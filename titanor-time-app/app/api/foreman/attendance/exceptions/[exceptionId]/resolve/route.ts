import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { helsinkiToday } from '@/lib/workers';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { resolveAttendanceException, pairOrphanEvents, validateResolveRequestBody } from '@/lib/attendance-exception-resolution';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5/§9.7/§9.8/§11/§12.1/§12.3 — T7A.8B.1
// shipped DISMISS/ACKNOWLEDGE_AS_VALID; T7A.8B.2 added PAIR_ORPHAN_EVENTS. T7A.8B.3 adds
// CONFIRM_SOURCE_ASSIGNMENT but deliberately NOT to this route — FOREMAN never gets it (§12.1),
// rejected below with 403 before the body is even shape-validated, let alone before any
// chosenAssignmentId/target row is read.
// POST /api/foreman/attendance/exceptions/:exceptionId/resolve.
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

  // CONFIRM_SOURCE_ASSIGNMENT is ADMIN/SUPER_ADMIN only (§12.1) — rejected here, on the raw body,
  // before validateResolveRequestBody (which would otherwise happily accept a well-formed
  // chosenAssignmentId) and long before any target/assignment row is touched. Checked ahead of
  // full shape validation on purpose, so a malformed chosenAssignmentId can never turn this into a
  // 400 instead of 403 for a foreman who was never going to be allowed this action regardless.
  if (rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody) && (rawBody as Record<string, unknown>).action === 'CONFIRM_SOURCE_ASSIGNMENT') {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const validated = validateResolveRequestBody(rawBody);
  if (!validated.ok) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
  }
  if (validated.action === 'CONFIRM_SOURCE_ASSIGNMENT') {
    // Unreachable in practice (the raw-body check above already returned 403 for this action) —
    // kept so this narrows validated.action for the code below and stays correct even if the
    // raw-body check is ever changed.
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const scope = { foremanUserId: authenticated.user.id, today: helsinkiToday(), excludeEmployeeId: authenticated.user.employeeId };

  if (validated.action === 'PAIR_ORPHAN_EVENTS') {
    const outcome = await pairOrphanEvents(exceptionId, validated.checkInEventId, validated.checkOutEventId, validated.resolutionNote, authenticated.user.id, scope, requestId);
    switch (outcome.kind) {
      case 'CREATED':
        return NextResponse.json(outcome.result, { status: 201, headers: successHeaders(requestId) });
      case 'NOT_FOUND':
        return jsonError(404, { code: 'EXCEPTION_NOT_FOUND', message: 'No attendance exception with this id.' }, requestId);
      case 'ALREADY_RESOLVED':
        return jsonError(409, { code: 'EXCEPTION_ALREADY_RESOLVED', message: 'This exception has already been resolved.' }, requestId);
      case 'ACTION_NOT_APPLICABLE':
        return NextResponse.json(errorBody({ code: 'ACTION_NOT_APPLICABLE', message: 'This action is not applicable to this exception type.', allowedActions: outcome.allowedActions }, requestId), { status: 409, headers: successHeaders(requestId) });
      case 'FOREMAN_SCOPE_INCOMPLETE':
        return jsonError(403, { code: 'FOREMAN_SCOPE_INCOMPLETE', message: 'This exception touches a site outside your current assignments — resolution is unavailable.' }, requestId);
      case 'CLOCK_EVENT_NOT_FOUND':
        return jsonError(404, { code: 'CLOCK_EVENT_NOT_FOUND', message: 'One or both clock events do not exist.' }, requestId);
      case 'EVENT_ALREADY_PAIRED':
        return jsonError(409, { code: 'EVENT_ALREADY_PAIRED', message: 'One or both events are already part of a shift.' }, requestId);
      case 'PAIRED_SHIFT_OVERLAP':
        return jsonError(409, { code: 'PAIRED_SHIFT_OVERLAP', message: 'This pair would overlap an existing shift for this employee.' }, requestId);
      case 'VALIDATION_ERROR':
        return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: outcome.fieldErrors }, requestId), { status: 400, headers: successHeaders(requestId) });
    }
  }

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
