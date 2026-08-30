import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { submitWorkerTimesheet } from '@/lib/worker-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §9 — POST /api/worker/timesheets/:timesheetId/submit.
// No Idempotency-Key support: not listed in the contract for this endpoint, and a genuine retry
// after success is already safe — it hits 409 INVALID_STATE_TRANSITION rather than double-freezing
// a version, since status is no longer DRAFT/RETURNED.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';

type RouteParams = { params: Promise<{ timesheetId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.submit'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  const { timesheetId } = await params;
  const timesheetIdInvalid = requireUuidParam(timesheetId, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
  if (timesheetIdInvalid) return timesheetIdInvalid;
  const result = await submitWorkerTimesheet(authenticated.user.employeeId, timesheetId, authenticated.user.id, requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'FORBIDDEN':
        return jsonError(403, { code: 'FORBIDDEN', message: 'This timesheet does not belong to you.' }, requestId);
      case 'NOT_FOUND':
        return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Timesheet is not in DRAFT or RETURNED status.' }, requestId);
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
