import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getWorkerTimesheetCurrentVersion } from '@/lib/worker-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §9 — GET /api/worker/timesheets/:timesheetId/current-version.
type RouteParams = { params: Promise<{ timesheetId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  const { timesheetId } = await params;
  const timesheetIdInvalid = requireUuidParam(timesheetId, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id, or it has never been submitted.' }, requestId);
  if (timesheetIdInvalid) return timesheetIdInvalid;
  const result = await getWorkerTimesheetCurrentVersion(authenticated.user.employeeId, timesheetId);

  if ('code' in result) {
    if (result.code === 'FORBIDDEN') {
      return jsonError(403, { code: 'FORBIDDEN', message: 'This timesheet does not belong to you.' }, requestId);
    }
    return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id, or it has never been submitted.' }, requestId);
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
