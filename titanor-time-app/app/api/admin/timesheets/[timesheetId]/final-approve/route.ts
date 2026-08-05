import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { finalApproveTimesheet } from '@/lib/admin-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/01_SCREEN_MAP.md §2 `/admin/timesheets/[timesheetId]/approve` DoD: "сервер
// отклоняет любые данные об изменении часов в теле final-approve" — enforced here by rejecting
// any non-empty body outright, since there is no field on this action that could legitimately
// carry one; the UI itself never sends one.
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

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.final_approve'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const rawBody = await request.text();
  if (rawBody.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
    }
    if (parsed !== null && typeof parsed === 'object' && Object.keys(parsed as object).length > 0) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'final-approve does not accept a body — it never changes hour data.' }, requestId);
    }
  }

  const { timesheetId } = await params;
  const result = await finalApproveTimesheet(timesheetId, authenticated.user.id, requestId);

  if ('code' in result) {
    if (result.code === 'NOT_FOUND') {
      return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
    }
    return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Timesheet is not in FOREMAN_APPROVED status.' }, requestId);
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
