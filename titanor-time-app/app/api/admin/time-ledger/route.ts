import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getTimeLedger, TimeLedgerReadChangedError } from '@/lib/reporting/time-ledger';
import { parseTimeLedgerQuery } from '@/lib/reporting/time-ledger-query';

// UT3-B — GET /api/admin/time-ledger, the единый табель read API (TITANOR_TIME_UNIFIED_TIMESHEET_UPDATE_TZ_RU.md,
// checkpoints UT0/UT0-R1/UT0-R2/UT3-A/UT3-A-R1/UT3-A-R2/UT3-B-fixup). Read-only: no mutation, no
// AuditEvent, no approval endpoint — that is a later, separate checkpoint. Query parsing itself is
// lib/reporting/time-ledger-query.ts's parseTimeLedgerQuery — a pure function, unit-tested directly
// in scripts/_test-time-ledger-query.ts — this handler only does auth/permission and the call.
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

  try {
    const result = await getTimeLedger(parsed.query, { userId: authenticated.user.id, employeeId: authenticated.user.employeeId });
    return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
  } catch (err) {
    if (err instanceof TimeLedgerReadChangedError) {
      return jsonError(409, { code: 'TIME_LEDGER_READ_CHANGED_DURING_QUERY', message: 'The underlying data changed while this page was being read. Please retry.' }, requestId);
    }
    throw err;
  }
}
