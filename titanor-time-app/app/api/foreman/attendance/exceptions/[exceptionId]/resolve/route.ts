import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { resolveAttendanceException, validateResolveRequestBody } from '@/lib/attendance-exception-resolution';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5/§11/§12.1/§12.3 — T7A.8B.1.
// POST /api/foreman/attendance/exceptions/:exceptionId/resolve — DISMISS/ACKNOWLEDGE_AS_VALID only.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ exceptionId: string }> };

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

  // Resolve does not imply read and vice versa — both are required independently (§2 migration note).
  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.read.assigned'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.resolve.assigned'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { exceptionId } = await params;
  if (!UUID_PATTERN.test(exceptionId)) {
    return jsonError(404, { code: 'EXCEPTION_NOT_FOUND', message: 'No attendance exception with this id.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId), { status: 400, headers: successHeaders(requestId) });
  }
  const validated = validateResolveRequestBody(rawBody);
  if (!validated.ok) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }

  const scope = { foremanUserId: authenticated.user.id, today: helsinkiToday(), excludeEmployeeId: authenticated.user.employeeId };
  const outcome = await resolveAttendanceException(exceptionId, validated.action, validated.resolutionNote, authenticated.user.id, scope, requestId);

  switch (outcome.kind) {
    case 'OK':
      return NextResponse.json(outcome.result, { status: 200, headers: successHeaders(requestId) });
    case 'NOT_FOUND':
      return jsonError(404, { code: 'EXCEPTION_NOT_FOUND', message: 'No attendance exception with this id.' }, requestId);
    case 'ALREADY_RESOLVED':
      return jsonError(409, { code: 'EXCEPTION_ALREADY_RESOLVED', message: 'This exception has already been resolved.' }, requestId);
    case 'ACTION_NOT_APPLICABLE':
      return NextResponse.json(errorBody({ code: 'ACTION_NOT_APPLICABLE', message: 'This action is not applicable to this exception type.', allowedActions: outcome.allowedActions }, requestId), { status: 409, headers: successHeaders(requestId) });
    case 'FOREMAN_SCOPE_INCOMPLETE':
      return jsonError(403, { code: 'FOREMAN_SCOPE_INCOMPLETE', message: 'This exception touches a site outside your current assignments — resolution is unavailable.' }, requestId);
    case 'OPEN_SHIFT_STILL_PENDING':
      return jsonError(409, { code: 'OPEN_SHIFT_STILL_PENDING', message: 'The originating shift is still open.' }, requestId);
    case 'VALIDATION_ERROR':
      return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: outcome.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }
}
