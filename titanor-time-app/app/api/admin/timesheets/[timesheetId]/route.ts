import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getTimesheetCard } from '@/lib/admin-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets/[timesheetId]` — GET /api/admin/timesheets/:timesheetId.
type RouteParams = { params: Promise<{ timesheetId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { timesheetId } = await params;
  const card = await getTimesheetCard(timesheetId);
  if (!card) {
    return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
  }

  return NextResponse.json(card, { status: 200, headers: successHeaders(requestId) });
}
