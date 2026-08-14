import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { getForemanSiteIds } from '@/lib/foreman-review';
import { listAttendanceExceptions, parseExceptionListQuery } from '@/lib/attendance-exceptions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1/§12.3 — GET /api/foreman/attendance/exceptions.
// employeeId is deliberately NOT part of this route's query contract (admin-only filter) — a
// foreman-supplied employeeId is silently ignored rather than validated/rejected, same treatment
// app/api/foreman/review-scopes/route.ts already gives its own unused `status` param.
function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.read.assigned'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const parsed = parseExceptionListQuery(
    {
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
      status: searchParams.get('status'),
      type: searchParams.get('type'),
      siteId: searchParams.get('siteId'),
      employeeId: null,
      payrollPeriodId: searchParams.get('payrollPeriodId'),
      from: searchParams.get('from'),
      to: searchParams.get('to')
    },
    { allowEmployeeId: false }
  );
  if (!parsed.ok) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', fieldErrors: parsed.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  const today = helsinkiToday();
  const ownSiteIds = await getForemanSiteIds(authenticated.user.id, today);

  const result = await listAttendanceExceptions(parsed.filters, { ownSiteIds, excludeEmployeeId: authenticated.user.employeeId });
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
