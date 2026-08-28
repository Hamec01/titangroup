import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { reopenWorkerTimesheetForEdits } from '@/lib/worker-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T12 (owner model) — POST /api/worker/timesheets/:timesheetId/reopen. The worker takes back a
// timesheet they already sent, to keep editing, while the period is OPEN and before the cutoff.
// Same permission as submit (a worker who can submit can un-submit within the window).
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
  const result = await reopenWorkerTimesheetForEdits(authenticated.user.employeeId, timesheetId, authenticated.user.id, requestId);

  if ('code' in result && result.code !== 'REOPENED') {
    switch (result.code) {
      case 'FORBIDDEN':
        return jsonError(403, { code: 'FORBIDDEN', message: 'This timesheet does not belong to you.' }, requestId);
      case 'NOT_FOUND':
        return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
      case 'EDIT_WINDOW_CLOSED':
        return jsonError(409, { code: 'EDIT_WINDOW_CLOSED', message: 'The editing window for this week is closed.' }, requestId);
      case 'INVALID_STATE_TRANSITION':
        return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'This timesheet cannot be reopened.' }, requestId);
    }
  }

  return NextResponse.json({ status: 'DRAFT' }, { status: 200, headers: successHeaders(requestId) });
}
