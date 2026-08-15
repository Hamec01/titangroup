import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { editAttendanceExceptionReason, validateEditRequestBody } from '@/lib/attendance-exception-edit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §10.1-§10.3/§12.4 — T7A.8B.4B adds
// REASON_EDIT, the sixth and last action of the §11 resolution-action matrix. Deliberately a
// separate endpoint from .../resolve (different request/response shape, different target-identity
// resolution algorithm) — ADMIN/SUPER_ADMIN only, gated by all three of
// attendance.exception.read.all, attendance.exception.resolve.all, and
// timesheet.draft.edit.exception (the last one seeded ADMIN/SUPER_ADMIN-only by
// prisma/migrations/20260818000000_seed_timesheet_draft_edit_exception_permission).
// POST /api/admin/attendance/exceptions/:exceptionId/edit.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
type RouteParams = { params: Promise<{ exceptionId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  // All three independently required (§2 migration note carried forward from /resolve) — revoking
  // any one of the three must 403, not merely degrade the response.
  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.resolve.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.draft.edit.exception'))) {
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
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }

  const validated = validateEditRequestBody(rawBody);
  if (!validated.ok) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId);
  }

  const outcome = await editAttendanceExceptionReason(exceptionId, validated.value, authenticated.user.id, requestId);

  switch (outcome.kind) {
    case 'OK':
      return NextResponse.json(outcome.result, { status: 200, headers: successHeaders(requestId) });
    case 'NOT_FOUND':
      return jsonError(404, { code: 'EXCEPTION_NOT_FOUND', message: 'No attendance exception with this id.' }, requestId);
    case 'ALREADY_RESOLVED':
      return jsonError(409, { code: 'EXCEPTION_ALREADY_RESOLVED', message: 'This exception has already been resolved.' }, requestId);
    case 'ACTION_NOT_APPLICABLE':
      return jsonError(409, { code: 'ACTION_NOT_APPLICABLE', message: 'This action is not applicable to this exception type.', allowedActions: outcome.allowedActions }, requestId);
    case 'TARGET_NOT_APPLICABLE':
      return jsonError(409, { code: 'ACTION_NOT_APPLICABLE', message: 'The requested clockShiftFragmentId is not a valid target for this exception.' }, requestId);
    case 'TARGET_NOT_EDITABLE':
      return jsonError(409, { code: 'TARGET_NOT_EDITABLE', message: 'There is no live editable draft segment for this fragment.' }, requestId);
    case 'DRAFT_NOT_EDITABLE':
      return jsonError(409, { code: 'DRAFT_NOT_EDITABLE', message: 'The timesheet is not in a DRAFT or RETURNED state.' }, requestId);
    case 'OVERLAP_STILL_PRESENT':
      return jsonError(409, { code: 'OVERLAP_STILL_PRESENT', message: 'This edit does not eliminate the overlap between the two named shifts.' }, requestId);
    case 'BREAK_OUTSIDE_SEGMENT':
      return jsonError(409, { code: 'BREAK_OUTSIDE_SEGMENT', message: 'An existing break would fall outside the edited segment bounds.' }, requestId);
    case 'WORK_SEGMENT_OVERLAP':
      return jsonError(409, { code: 'WORK_SEGMENT_OVERLAP', message: 'This edit would overlap another segment on the same day.' }, requestId);
    case 'SITE_NOT_ASSIGNED':
      return jsonError(409, { code: 'SITE_NOT_ASSIGNED', message: 'This employee has no active site assignment for the requested site/work area on this date.' }, requestId);
    case 'VALIDATION_ERROR':
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: outcome.fieldErrors }, requestId);
  }
}
