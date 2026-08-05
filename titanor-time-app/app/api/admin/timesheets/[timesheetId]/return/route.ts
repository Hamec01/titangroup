import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { returnTimesheetOverride } from '@/lib/admin-timesheets';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 "Admin override-возврат всего табеля из
// FOREMAN_APPROVED" — 01_SCREEN_MAP.md §2 `/admin/timesheets/[timesheetId]/approve`.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ timesheetId: string }> };

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'timesheet.return'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const { returnReason } = bodyObject as { returnReason?: unknown };

  if (typeof returnReason !== 'string' || returnReason.trim().length === 0) {
    return NextResponse.json(
      errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { returnReason: ['required'] } }, requestId),
      { status: 400, headers: successHeaders(requestId) }
    );
  }

  const { timesheetId } = await params;
  const result = await returnTimesheetOverride(timesheetId, authenticated.user.id, returnReason.trim(), requestId);

  if ('code' in result) {
    if (result.code === 'NOT_FOUND') {
      return jsonError(404, { code: 'TIMESHEET_NOT_FOUND', message: 'No timesheet with this id.' }, requestId);
    }
    return jsonError(409, { code: 'INVALID_STATE_TRANSITION', message: 'Timesheet is not in FOREMAN_APPROVED status.' }, requestId);
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
