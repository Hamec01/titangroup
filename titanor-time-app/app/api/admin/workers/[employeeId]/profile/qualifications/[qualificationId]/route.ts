import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { deleteEmployeeQualification } from '@/lib/employee-profile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ employeeId: string; qualificationId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.update.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId, qualificationId } = await params;
  if (!UUID_PATTERN.test(employeeId) || !UUID_PATTERN.test(qualificationId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Qualification not found.' }, requestId);
  }

  const result = await deleteEmployeeQualification({ qualificationId, employeeId, actorUserId: authenticated.user.id, requestId });
  if (!result.ok) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Qualification not found.' }, requestId);
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}
