import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getAttendanceExceptionDetail, UUID_PATTERN } from '@/lib/attendance-exceptions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1/§12.3 — GET /api/admin/attendance/exceptions/:exceptionId.
type RouteParams = { params: Promise<{ exceptionId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'attendance.exception.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { exceptionId } = await params;
  // A malformed id must return the same safe 404 as "doesn't exist" — never a 400/500 that would
  // distinguish "well-formed but missing" from "not even a UUID" (§ list/detail security contract).
  if (!UUID_PATTERN.test(exceptionId)) {
    return jsonError(404, { code: 'EXCEPTION_NOT_FOUND', message: 'No attendance exception with this id.' }, requestId);
  }

  const detail = await getAttendanceExceptionDetail(exceptionId, null);
  if (!detail) {
    return jsonError(404, { code: 'EXCEPTION_NOT_FOUND', message: 'No attendance exception with this id.' }, requestId);
  }

  return NextResponse.json(detail, { status: 200, headers: successHeaders(requestId) });
}
