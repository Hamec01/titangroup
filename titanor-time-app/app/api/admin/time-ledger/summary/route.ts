import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { parseTimeLedgerQuery } from '@/lib/reporting/time-ledger-query';
import { loadCustomerHoursSummary, SUMMARY_MAX_WEEKS, SUMMARY_MAX_SLICES } from '@/lib/reporting/customer-hours-summary';

// UT8-B — GET /api/admin/time-ledger/summary. Read-only, powers the "Сводка" tab. Reuses
// parseTimeLedgerQuery verbatim (same strict siteId/workAreaId/employeeSearch/date-range validation
// as the main ledger and historical-approvals endpoints) — status/onlyIssues/onlyChangedAfterApproval/
// submissionState/submissionSource/page/pageSize are accepted by the parser but unused here (the
// summary always aggregates the WHOLE matching scope with every status, never a pre-filtered slice).
//
// allTime=true is always rejected here (a client document needs a stated period) even though the
// main ledger allows it — see customer-hours-summary.ts's validateSummaryRange. A range spanning
// more than SUMMARY_MAX_WEEKS weeks is RANGE_TOO_LARGE; a scope with more than SUMMARY_MAX_SLICES
// weekly slices is SELECTION_TOO_LARGE — neither is ever silently truncated.
//
// The response never includes the raw WeeklyCustomerSliceRow[] (that stays server-side, used only by
// the export route) — only aggregates, so an ordinary summary view is small regardless of scope size.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const parsed = parseTimeLedgerQuery(request.nextUrl.searchParams);
  if (!parsed.ok) {
    return jsonError(400, parsed.error, requestId);
  }

  const outcome = await loadCustomerHoursSummary(parsed.query, { userId: authenticated.user.id, employeeId: authenticated.user.employeeId }, prisma);
  if (!outcome.ok) {
    if (outcome.reason === 'ALL_TIME_NOT_ALLOWED') {
      return jsonError(400, { code: 'ALL_TIME_NOT_ALLOWED', message: 'The summary requires an explicit date range — allTime is not supported here.' }, requestId);
    }
    if (outcome.reason === 'RANGE_TOO_LARGE') {
      return jsonError(400, { code: 'RANGE_TOO_LARGE', message: `The summary range must be ${SUMMARY_MAX_WEEKS} weeks or fewer (requested ${outcome.actualWeeks}). Narrow the period.`, fieldErrors: { requestedRange: [`must span at most ${SUMMARY_MAX_WEEKS} weeks`] } }, requestId);
    }
    if (outcome.reason === 'WORK_AREA_NONE_REQUIRES_SITE') {
      return jsonError(400, { code: 'WORK_AREA_NONE_REQUIRES_SITE', message: "workAreaId='none' requires siteId — a company-wide 'no customer' scope is not supported here.", fieldErrors: { siteId: ['required when workAreaId is none'] } }, requestId);
    }
    return jsonError(400, { code: 'SELECTION_TOO_LARGE', message: `This selection has ${outcome.totalItems} weekly entries, more than the ${SUMMARY_MAX_SLICES} limit. Narrow the customer/worker/period filter.` }, requestId);
  }

  return NextResponse.json(
    {
      requestId,
      requestedRange: outcome.requestedRange,
      effectiveWeekRange: outcome.effectiveWeekRange,
      totals: outcome.totals,
      byCustomer: outcome.byCustomer,
      readyForCustomerExport: outcome.readyForCustomerExport,
      blockers: outcome.blockers
    },
    { status: 200, headers: successHeaders(requestId) }
  );
}
