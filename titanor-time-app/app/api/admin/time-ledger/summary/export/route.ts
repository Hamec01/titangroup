import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import { prisma } from '@/lib/prisma';
import { attachmentContentDisposition } from '@/lib/reporting/content-disposition';
import { parseTimeLedgerQuery } from '@/lib/reporting/time-ledger-query';
import { loadCustomerHoursSummary, SUMMARY_MAX_WEEKS, SUMMARY_MAX_SLICES } from '@/lib/reporting/customer-hours-summary';
import { buildCustomerHoursSummaryCsv, customerHoursSummaryCsvFileName, type SummaryExportMode } from '@/lib/reporting/customer-hours-summary-csv';
import { buildCustomerHoursSummaryPdf, customerHoursSummaryPdfFileName } from '@/lib/reporting/customer-hours-summary-pdf';
import { customerHoursApprovalEnabled } from '@/lib/customer-hours-approval-flag';

// UT8-B — GET /api/admin/time-ledger/summary/export?format=csv|pdf&mode=preview|final. The NEW
// official customer-facing document — replaces lib/reporting/customer-time-report.ts's
// FINAL_APPROVED-gated export for this purpose (that module and its own route are UNTOUCHED and
// keep working; this is a separate, additive surface). Requires timesheet.read.all + export.read —
// no additional permission (owner decision, UT8-A).
//
// mode=preview: available whenever the filter/range itself is valid, regardless of confirmation
// state — every row carries its own status, the file is explicitly watermarked/labelled as a
// preview, and NO AuditEvent is written (owner decision — preview must be free to explore).
// mode=final: refused (409 NOT_READY_FOR_EXPORT) unless outcome.readyForCustomerExport === true —
// the response then lists the SPECIFIC workers/weeks still blocking it, same shape the "Сводка" tab
// itself uses, so the admin can narrow the filter or go confirm the blocking rows and retry. On
// success, contains ONLY approvalState==='APPROVED' rows (customer-hours-summary.ts's own filter is
// a second, defensive guarantee — the readyForCustomerExport gate is the primary one) and writes
// exactly one REPORT_EXPORTED AuditEvent.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.all')) || !(await hasPermission(authenticated.user.roles, 'export.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const sp = request.nextUrl.searchParams;

  // UT8-B-fixup #4 — a repeated format/mode must be rejected outright, never silently resolved to
  // the first value the way a bare .get() would (?format=csv&format=pdf was previously accepted).
  // Checked BEFORE reading either value at all.
  const dupFieldErrors: Record<string, string[]> = {};
  if (sp.getAll('format').length > 1) dupFieldErrors.format = ['must not be repeated'];
  if (sp.getAll('mode').length > 1) dupFieldErrors.mode = ['must not be repeated'];
  if (Object.keys(dupFieldErrors).length > 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'A query parameter was repeated.', fieldErrors: dupFieldErrors }, requestId);
  }

  const formatRaw = (sp.get('format') ?? '').toUpperCase();
  const modeRaw = (sp.get('mode') ?? '').toLowerCase();
  if (formatRaw !== 'CSV' && formatRaw !== 'PDF') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'format must be csv or pdf.', fieldErrors: { format: ['csv or pdf'] } }, requestId);
  }
  if (modeRaw !== 'preview' && modeRaw !== 'final' && modeRaw !== 'recorded') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'mode must be preview, final, or recorded.', fieldErrors: { mode: ['preview, final, or recorded'] } }, requestId);
  }
  const mode: SummaryExportMode = modeRaw;
  const approvalEnabled = customerHoursApprovalEnabled();
  if ((!approvalEnabled && mode !== 'recorded') || (approvalEnabled && mode === 'recorded')) {
    return jsonError(409, { code: 'FEATURE_MODE_MISMATCH', message: approvalEnabled ? 'Recorded export is available when customer-hours approval is disabled.' : 'Approval-based exports are disabled; use recorded mode.' }, requestId);
  }

  // format/mode are this route's own params, not part of the shared ledger query shape — stripped
  // before handing the rest to parseTimeLedgerQuery so its strict unknown-parameter check does not
  // reject them.
  const spWithoutOwnParams = new URLSearchParams(sp);
  spWithoutOwnParams.delete('format');
  spWithoutOwnParams.delete('mode');
  const parsed = parseTimeLedgerQuery(spWithoutOwnParams);
  if (!parsed.ok) {
    return jsonError(400, parsed.error, requestId);
  }

  const actor = { userId: authenticated.user.id, employeeId: authenticated.user.employeeId };
  const outcome = await loadCustomerHoursSummary(parsed.query, actor, prisma);
  if (!outcome.ok) {
    if (outcome.reason === 'ALL_TIME_NOT_ALLOWED') {
      return jsonError(400, { code: 'ALL_TIME_NOT_ALLOWED', message: 'The export requires an explicit date range — allTime is not supported here.' }, requestId);
    }
    if (outcome.reason === 'RANGE_TOO_LARGE') {
      return jsonError(400, { code: 'RANGE_TOO_LARGE', message: `The export range must be ${SUMMARY_MAX_WEEKS} weeks or fewer (requested ${outcome.actualWeeks}). Narrow the period.` }, requestId);
    }
    if (outcome.reason === 'WORK_AREA_NONE_REQUIRES_SITE') {
      return jsonError(400, { code: 'WORK_AREA_NONE_REQUIRES_SITE', message: "workAreaId='none' requires siteId — a company-wide 'no customer' scope is not supported here.", fieldErrors: { siteId: ['required when workAreaId is none'] } }, requestId);
    }
    return jsonError(400, { code: 'SELECTION_TOO_LARGE', message: `This selection has ${outcome.totalItems} weekly entries, more than the ${SUMMARY_MAX_SLICES} limit. Narrow the customer/worker/period filter.` }, requestId);
  }

  if (mode === 'final' && !outcome.readyForCustomerExport) {
    return NextResponse.json(
      {
        error: {
          code: 'NOT_READY_FOR_EXPORT',
          message: 'Some hours in this selection are not confirmed, were changed after confirmation, or are technically unreadable.',
          blockers: outcome.blockers,
          requestId
        }
      },
      { status: 409, headers: { ...NO_STORE, 'X-Request-Id': requestId } }
    );
  }

  // UT8-B-fixup #3 — build the FULL file bytes first. Only once that has genuinely succeeded does
  // the (final-only) AuditEvent get written; only once THAT has genuinely succeeded is the response
  // returned. If the generator throws, no audit is written (a failed export never gets recorded as
  // if it happened). If the audit write itself throws, the response is never returned either — an
  // export whose audit didn't take is never silently handed to the caller as if it were logged.
  const generatedAtHelsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

  let content: Buffer;
  let contentType: string;
  let fileName: string;
  if (formatRaw === 'CSV') {
    content = buildCustomerHoursSummaryCsv(outcome, mode);
    contentType = 'text/csv; charset=utf-8';
    fileName = customerHoursSummaryCsvFileName(outcome, mode);
  } else {
    content = await buildCustomerHoursSummaryPdf(outcome, mode, { generatedAtHelsinki, preparedBy: authenticated.user.username });
    contentType = 'application/pdf';
    fileName = customerHoursSummaryPdfFileName(outcome, mode);
  }

  if (mode === 'final' || mode === 'recorded') {
    await prisma.$transaction((tx) =>
      createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'REPORT_EXPORTED',
        entityType: 'CUSTOMER_HOURS_SUMMARY',
        entityId: null,
        requestId,
        beforeValue: null,
        afterValue: {
          report: 'CUSTOMER_HOURS_SUMMARY',
          format: formatRaw,
          dateFrom: outcome.requestedRange.startDate,
          dateTo: outcome.requestedRange.endDate,
          siteId: parsed.query.siteId,
          workAreaId: parsed.query.workAreaId,
          customerCount: outcome.byCustomer.length,
          workerCount: mode === 'recorded' ? outcome.totals.recordedWorkerCount : outcome.totals.confirmedWorkerCount,
          confirmedMinutes: mode === 'recorded' ? undefined : outcome.totals.confirmedMinutes,
          recordedMinutes: mode === 'recorded' ? outcome.totals.recordedMinutes : undefined,
          mode,
          rowCount: mode === 'recorded' ? outcome.rows.length : outcome.rows.filter((r) => r.approvalState === 'APPROVED').length
        }
      })
    );
  }

  return new NextResponse(new Uint8Array(content), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': attachmentContentDisposition(fileName),
      'X-Content-Type-Options': 'nosniff',
      ...NO_STORE,
      'X-Request-Id': requestId
    }
  });
}
