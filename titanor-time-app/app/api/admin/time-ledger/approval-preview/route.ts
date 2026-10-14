import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { guardApiRequest } from '@/lib/api-guard';
import { prisma } from '@/lib/prisma';
import { prepareWeeklyCustomerApproval, validateApprovalRequestBody } from '@/lib/reporting/weekly-approval';
import { signConfirmationToken } from '@/lib/customer-hours-confirmation-token';
import { customerHoursApprovalEnabled } from '@/lib/customer-hours-approval-flag';

// UT5-B — POST /api/admin/time-ledger/approval-preview. Read-only: never writes to the database,
// never requires Idempotency-Key (nothing to dedupe — repeating a preview is harmless). Re-reads
// canonical source and rebuilds the slice fresh on every call via the SAME shared preparation
// service the commit endpoint uses (lib/reporting/weekly-approval.ts), so a preview's numbers are
// never stale-by-construction. Issues a confirmationToken ONLY when the fingerprint matches, the
// slice exists, and there are no blockers (UT5-A-R1 §9) — warnings never withhold the token.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardApiRequest(request, { csrf: true, permission: 'timesheet.customer_hours_approve.all' });
  if (!guard.ok) return guard.response;
  const { session, requestId } = guard;
  if (!customerHoursApprovalEnabled()) return jsonError(409, { code: 'FEATURE_DISABLED', message: 'Customer hours approval is disabled.' }, requestId);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' }, requestId);
  }

  const validated = validateApprovalRequestBody(rawBody);
  if (!validated.ok) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId);
  }
  const { itemKey, expectedFingerprint } = validated.value;

  const prepared = await prepareWeeklyCustomerApproval({
    itemKey,
    actor: { userId: session.user.id, employeeId: session.user.employeeId },
    mode: 'READ',
    db: prisma
  });

  if (!prepared.ok) {
    switch (prepared.reason) {
      case 'INVALID_WORK_AREA_SITE':
        return jsonError(400, { code: 'INVALID_WORK_AREA_SITE', message: 'workAreaId does not belong to siteId.' }, requestId);
      case 'TIMESHEET_NOT_FOUND':
        return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
      case 'SOURCE_ERROR':
        return jsonError(409, { code: 'SOURCE_ERROR', message: 'This timesheet has no readable canonical source.' }, requestId);
      case 'SLICE_NOT_FOUND':
        return jsonError(409, { code: 'SLICE_NOT_FOUND', message: 'No hours found for this customer/week.' }, requestId);
      case 'INVARIANT_FAILURE':
        return jsonError(409, { code: 'INVARIANT_FAILURE', message: "Could not compute this week's hours." }, requestId);
      default: {
        const exhaustive: never = prepared;
        throw new Error(`unreachable prepareWeeklyCustomerApproval reason: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const matchesExpectedFingerprint = prepared.slice.fingerprint === expectedFingerprint;
  const existingApprovalState: 'NONE' | 'CURRENT_MATCHING' | 'CURRENT_STALE' = !prepared.existingCurrentItem
    ? 'NONE'
    : prepared.existingCurrentItem.fingerprint === prepared.slice.fingerprint
      ? 'CURRENT_MATCHING'
      : 'CURRENT_STALE';

  let confirmationToken: string | undefined;
  let confirmationTokenExpiresAt: string | undefined;
  if (matchesExpectedFingerprint && prepared.eligibility.canApprove) {
    const signed = signConfirmationToken({ actorUserId: session.user.id, employeeId: prepared.employeeId, itemKey, expectedFingerprint: prepared.slice.fingerprint });
    confirmationToken = signed.token;
    confirmationTokenExpiresAt = signed.expiresAt;
  }

  return NextResponse.json(
    {
      requestId,
      itemKey: { ...itemKey, employeeId: prepared.employeeId },
      employeeName: prepared.employeeName,
      employeeNumber: prepared.employeeNumber,
      siteName: prepared.siteName,
      workAreaName: prepared.workAreaName,
      weekEnd: prepared.slice.logicalKey.weekEnd,
      workedMinutes: prepared.slice.workedMinutes,
      grossMinutes: prepared.slice.grossMinutes,
      breakMinutes: prepared.slice.breakMinutes,
      currentFingerprint: prepared.slice.fingerprint,
      matchesExpectedFingerprint,
      submissionState: prepared.submissionState,
      warnings: prepared.warnings,
      blockers: prepared.blockers,
      eligibility: prepared.eligibility,
      existingApproval: {
        state: existingApprovalState,
        approvedByUserName: prepared.existingCurrentItem?.approvedByUserName,
        approvedAt: prepared.existingCurrentItem?.approvedAt
      },
      confirmationToken,
      confirmationTokenExpiresAt
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
