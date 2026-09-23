import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { guardApiRequest } from '@/lib/api-guard';
import { prisma } from '@/lib/prisma';
import {
  prepareWeeklyCustomerApprovalsBatch,
  validateMassSelection,
  computeSelectionHash,
  classifyMassApprovalItemProblem,
  type WeeklyApprovalBatchItemResult,
  type MassSelectionScope
} from '@/lib/reporting/weekly-approval';
import { signMassConfirmationToken } from '@/lib/customer-hours-confirmation-token';
import type { LedgerIssue } from '@/lib/reporting/time-ledger';

// UT6-B — POST /api/admin/time-ledger/mass-approval-preview. Read-only, same contract as UT5-B's
// single-item approval-preview: never writes to the database, never requires Idempotency-Key.
// Re-resolves the whole selection fresh on every call via prepareWeeklyCustomerApprovalsBatch (the
// batched sibling of the single-item preparation service), so a preview's numbers are never
// stale-by-construction. Issues a mass confirmationToken ONLY when every item resolved cleanly AND
// every item's fingerprint matches (UT6-A-R1 §9/§10) — a business WARNING (self-approval, open
// shift, open correction, ...) never withholds the token; only a genuinely technical blocker or a
// stale item does.
//
// UT6-B-fixup #2 — every per-item "can this proceed" decision below goes through
// lib/reporting/weekly-approval.ts's classifyMassApprovalItemProblem, the SAME function the mass
// commit route calls to decide what aborts the whole transaction. The bug this fixup closes was
// exactly a duplicated, DIVERGED copy of this check: preview issued a token and outcome=WILL_APPROVE
// for an item commit would already have rejected as a blocker.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ALLOWED_BODY_KEYS = ['selection', 'scope'];

// UT6-B-fixup #2 — the period shown in preview is always derived from the SERVER's own validated
// selection (itemKey.weekStart, already checked to be real Mondays by validateMassSelection), never
// from any client-supplied text. periodEnd is the Sunday of the LATEST selected week, matching the
// same Monday..Sunday convention every other week boundary in this codebase already uses.
function weekEndOf(weekStartIso: string): string {
  const d = new Date(`${weekStartIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

function technicalBlockerMessage(reason: string): string {
  switch (reason) {
    case 'INVALID_WORK_AREA_SITE':
      return 'workAreaId does not belong to siteId.';
    case 'TIMESHEET_NOT_FOUND':
      return 'No timesheet with this id.';
    case 'SOURCE_ERROR':
      return 'This timesheet has no readable canonical source.';
    case 'SLICE_NOT_FOUND':
      return 'No hours found for this customer/week.';
    case 'INVARIANT_FAILURE':
      return "Could not compute this week's hours.";
    default:
      return 'This item cannot be processed.';
  }
}

export interface MassPreviewItemResult {
  itemKey: { timesheetId: string; siteId: string; workAreaId: string | null; weekStart: string; employeeId: string | null };
  employeeName: string | null;
  employeeNumber: string | null;
  siteName: string | null;
  workAreaName: string | null;
  weekEnd: string | null;
  workedMinutes: number | null;
  currentFingerprint: string | null;
  matchesExpectedFingerprint: boolean;
  submissionState: 'SUBMITTED' | 'NOT_SUBMITTED' | null;
  warnings: LedgerIssue[];
  technicalBlocker: { code: string; message: string } | null;
  existingApproval: { state: 'NONE' | 'CURRENT_MATCHING' | 'CURRENT_STALE'; approvedByUserName?: string; approvedAt?: string } | null;
  outcome: 'WILL_APPROVE' | 'WILL_SUPERSEDE_AND_APPROVE' | 'ALREADY_APPROVED_NOOP' | 'TECHNICALLY_BLOCKED' | 'STALE';
}

/**
 * UT6-B-fixup #2 — the ONE place a single prepared item becomes a preview-response item: routes
 * every "can this proceed" decision through classifyMassApprovalItemProblem (never re-derives
 * !ok/stale/blockers itself), so this route's outcome/technicalBlocker fields can never again
 * diverge from what findFirstMassApprovalProblem (mass-approvals/route.ts) would decide for the
 * exact same item. Exported so it is directly unit-testable against a hand-built
 * WeeklyApprovalBatchItemResult without needing a live DB round-trip. Pure — no I/O.
 */
export function buildMassPreviewItemResult(r: WeeklyApprovalBatchItemResult): MassPreviewItemResult {
  const problem = classifyMassApprovalItemProblem(r);

  if (!r.ok) {
    return {
      itemKey: { ...r.itemKey, employeeId: null },
      employeeName: null,
      employeeNumber: null,
      siteName: null,
      workAreaName: null,
      weekEnd: null,
      workedMinutes: null,
      currentFingerprint: null,
      matchesExpectedFingerprint: false,
      submissionState: null,
      warnings: [],
      technicalBlocker: { code: r.reason, message: technicalBlockerMessage(r.reason) },
      existingApproval: null,
      outcome: 'TECHNICALLY_BLOCKED'
    };
  }

  // r.ok === true from here on (TS-narrowed). problem is either null, {kind:'STALE'}, or
  // {kind:'BLOCKED', blocker} — 'NOT_OK' is impossible given r.ok===true.
  const existingApprovalState: 'NONE' | 'CURRENT_MATCHING' | 'CURRENT_STALE' = !r.existingCurrentItem
    ? 'NONE'
    : r.existingCurrentItem.fingerprint === r.slice.fingerprint
      ? 'CURRENT_MATCHING'
      : 'CURRENT_STALE';

  const outcome: MassPreviewItemResult['outcome'] =
    problem?.kind === 'BLOCKED'
      ? 'TECHNICALLY_BLOCKED'
      : problem?.kind === 'STALE'
        ? 'STALE'
        : existingApprovalState === 'CURRENT_MATCHING'
          ? 'ALREADY_APPROVED_NOOP'
          : existingApprovalState === 'CURRENT_STALE'
            ? 'WILL_SUPERSEDE_AND_APPROVE'
            : 'WILL_APPROVE';

  return {
    itemKey: { ...r.itemKey, employeeId: r.employeeId },
    employeeName: r.employeeName,
    employeeNumber: r.employeeNumber,
    siteName: r.siteName,
    workAreaName: r.workAreaName,
    weekEnd: r.slice.logicalKey.weekEnd,
    workedMinutes: r.slice.workedMinutes,
    currentFingerprint: r.slice.fingerprint,
    matchesExpectedFingerprint: r.matchesExpectedFingerprint,
    submissionState: r.submissionState,
    warnings: r.warnings,
    technicalBlocker: problem?.kind === 'BLOCKED' ? { code: problem.blocker.code, message: problem.blocker.message } : null,
    existingApproval: { state: existingApprovalState, approvedByUserName: r.existingCurrentItem?.approvedByUserName, approvedAt: r.existingCurrentItem?.approvedAt },
    outcome
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guard = await guardApiRequest(request, { csrf: true, permission: 'timesheet.customer_hours_approve.all' });
  if (!guard.ok) return guard.response;
  const { session, requestId } = guard;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' }, requestId);
  }
  if (rawBody === null || typeof rawBody !== 'object' || Object.keys(rawBody as Record<string, unknown>).some((k) => !ALLOWED_BODY_KEYS.includes(k))) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, requestId);
  }

  const bodyRecord = rawBody as Record<string, unknown>;
  const scopeRaw = bodyRecord.scope;
  if (scopeRaw !== undefined && scopeRaw !== 'CUSTOMER' && scopeRaw !== 'WEEK') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { scope: ["must be 'CUSTOMER' or 'WEEK'"] } }, requestId);
  }
  const scope: MassSelectionScope = scopeRaw === 'WEEK' ? 'WEEK' : 'CUSTOMER';

  const validated = validateMassSelection(bodyRecord.selection, scope);
  if (!validated.ok) {
    return jsonError(400, { code: validated.error.code, message: validated.error.message, fieldErrors: validated.error.fieldErrors }, requestId);
  }
  const selection = validated.value;

  const results = await prepareWeeklyCustomerApprovalsBatch({ selection, actor: { userId: session.user.id, employeeId: session.user.employeeId }, mode: 'READ', db: prisma });

  // UT9-B — 'WEEK' scope describes "whose week", not "which customer": the selection spans several
  // (siteId, workAreaId) pairs by construction, so a single site/workArea context would be
  // misleading. The employee name is read from the FIRST resolved item (every item in a WEEK-scope
  // selection already shares one timesheetId, hence one employeeId — validateMassSelection's own
  // invariant), never guessed from unvalidated request input.
  const firstOk = results.find((r): r is Extract<WeeklyApprovalBatchItemResult, { ok: true }> => r.ok);
  const context =
    scope === 'WEEK'
      ? { scope, siteId: null, siteName: null, workAreaId: null, workAreaName: null, employeeId: firstOk?.employeeId ?? null, employeeName: firstOk?.employeeName ?? null }
      : await (async () => {
          const [contextSite, contextWorkArea] = await Promise.all([
            prisma.workSite.findUnique({ where: { id: selection[0].itemKey.siteId }, select: { name: true } }),
            selection[0].itemKey.workAreaId ? prisma.workArea.findUnique({ where: { id: selection[0].itemKey.workAreaId }, select: { name: true } }) : Promise.resolve(null)
          ]);
          return {
            scope,
            siteId: selection[0].itemKey.siteId,
            siteName: contextSite?.name ?? '',
            workAreaId: selection[0].itemKey.workAreaId,
            workAreaName: contextWorkArea?.name ?? null,
            employeeId: null,
            employeeName: null
          };
        })();

  const items = results.map(buildMassPreviewItemResult);

  const okResults = results.filter((r): r is Extract<WeeklyApprovalBatchItemResult, { ok: true }> => r.ok);
  const employeeCount = new Set(okResults.map((r) => r.employeeId)).size;
  const workedMinutes = okResults.reduce((sum, r) => sum + r.slice.workedMinutes, 0);
  const alreadyApprovedCount = items.filter((it) => it.outcome === 'ALREADY_APPROVED_NOOP').length;
  const technicallyBlockedCount = items.filter((it) => it.outcome === 'TECHNICALLY_BLOCKED').length;
  const staleCount = items.filter((it) => it.outcome === 'STALE').length;

  const weekStarts = selection.map((s) => s.itemKey.weekStart).sort();
  const periodStart = weekStarts[0];
  const periodEnd = weekStarts.map(weekEndOf).sort().slice(-1)[0];

  // UT6-A-R1 §9/§10 (fixed UT6-B-fixup #2) — a token is issued only when classifyMassApprovalItemProblem
  // finds NOTHING wrong with EVERY item: resolved cleanly, fingerprint matches, AND no real blocker.
  // Business warnings never withhold it; a technical blocker, a stale item, or a real blocker always
  // does, since committing would fail the whole transaction anyway (§6/§13) — the exact same check
  // findFirstMassApprovalProblem uses to decide what aborts commit.
  const allEligibleForToken = results.length > 0 && results.every((r) => classifyMassApprovalItemProblem(r) === null);
  let confirmationToken: string | undefined;
  let confirmationTokenExpiresAt: string | undefined;
  if (allEligibleForToken) {
    const selectionHash = computeSelectionHash(selection);
    const signed = signMassConfirmationToken({ actorUserId: session.user.id, selectionHash, itemCount: selection.length });
    confirmationToken = signed.token;
    confirmationTokenExpiresAt = signed.expiresAt;
  }

  return NextResponse.json(
    {
      requestId,
      selectionHash: computeSelectionHash(selection),
      context: { ...context, periodStart, periodEnd },
      // UT6-B-fixup #2 — renamed from itemCount to weekPartCount: this is always the TOTAL selected
      // weekly slices (including already-approved/blocked/stale ones), never to be confused with a
      // commit response's own itemCount (which counts only what was actually WRITTEN).
      summary: { weekPartCount: selection.length, employeeCount, workedMinutes, alreadyApprovedCount, technicallyBlockedCount, staleCount },
      items,
      confirmationToken,
      confirmationTokenExpiresAt
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
