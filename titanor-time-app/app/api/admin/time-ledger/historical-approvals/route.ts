import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { parseTimeLedgerQuery } from '@/lib/reporting/time-ledger-query';
import { loadHistoricalApprovalIssues } from '@/lib/reporting/customer-hours-history';

// UT7-B-fixup #2 / UT7-B-fixup-2 — GET /api/admin/time-ledger/historical-approvals. Read-only, a
// SEPARATE bounded list alongside the main GET /api/admin/time-ledger response (never woven into its
// pagination — see customer-hours-history.ts's header comment for why). Reuses parseTimeLedgerQuery
// verbatim so this endpoint accepts exactly the same query shape the main ledger already validates
// strictly (unknown/repeated params rejected, real calendar dates, real UUIDs) — status/
// onlyIssues/onlyChangedAfterApproval ARE used here (they gate whether historical rows apply at all,
// see isHistoricalCompatibleFilter); page/pageSize are still unused (this list is its own bounded
// query, not paginated the way the main ledger is). `truncated: true` means more logical keys
// matched than the response shows — the client must say so, never present a partial list as
// complete.
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

  const { rows, truncated } = await loadHistoricalApprovalIssues(parsed.query, { userId: authenticated.user.id, employeeId: authenticated.user.employeeId }, prisma);

  return NextResponse.json({ requestId, rows, truncated }, { status: 200, headers: successHeaders(requestId) });
}
