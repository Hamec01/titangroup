import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { requireUuidParam } from '@/lib/api-guard';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { getForemanTimesheetDetail } from '@/lib/foreman-review';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §4 `/foreman/review/[timesheetId]` — GET
// /api/foreman/timesheets/:timesheetId.
type RouteParams = { params: Promise<{ timesheetId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.assigned'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { timesheetId } = await params;
  const timesheetIdInvalid = requireUuidParam(timesheetId, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id on your own sites.' }, requestId);
  if (timesheetIdInvalid) return timesheetIdInvalid;
  const detail = await getForemanTimesheetDetail(timesheetId, authenticated.user.id, helsinkiToday());
  if (!detail) {
    return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id on your own sites.' }, requestId);
  }

  return NextResponse.json(detail, { status: 200, headers: successHeaders(requestId) });
}
