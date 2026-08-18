import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { getAdminOperationalOverview, parseOverviewQuery } from '@/lib/attendance-overview';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §16 п.9 + Addendum "T7A.9A" — GET /api/admin/overview.
function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

const REQUIRED_PERMISSIONS = ['timesheet.read.all', 'attendance.exception.read.all', 'attendance.conflict.read'];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  for (const permissionCode of REQUIRED_PERMISSIONS) {
    if (!(await hasPermission(authenticated.user.roles, permissionCode))) {
      return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
    }
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseOverviewQuery(
    {
      periodId: searchParams.get('periodId'),
      siteId: searchParams.get('siteId'),
      state: searchParams.get('state'),
      employeeId: searchParams.get('employeeId'),
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize')
    },
    { allowEmployeeId: true }
  );
  if (!parsed.ok) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors: parsed.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  const today = helsinkiToday();

  // §10 ТЗ T7A.9A — one REPEATABLE READ read-only transaction so summary/items/conflicts (and
  // period resolution) all read the same DB snapshot; `asOf` is fixed once inside
  // buildOperationalOverview. Same wrapper the /admin Server Component calls directly (T7A.9B) —
  // no HTTP self-fetch, no second transaction-wrapping copy.
  const outcome = await getAdminOperationalOverview(parsed.filters, today);

  if (outcome.code === 'PERIOD_NOT_FOUND') {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No payroll period with this id.' }, requestId);
  }

  return NextResponse.json(outcome.result, { status: 200, headers: successHeaders(requestId) });
}
