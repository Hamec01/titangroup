import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, personalDataEncryptionUnavailable } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getEmployeeProfilePersonalIdentityCode } from '@/lib/employee-profile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Worker Dossier feature (2026-08-26, task spec §44) — own-only: employeeId always comes from
// the session, never a request parameter, so a worker can never reveal another worker's code.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This account has no employee profile.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.read.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  let value: string | null;
  try {
    value = await getEmployeeProfilePersonalIdentityCode(authenticated.user.employeeId);
  } catch (error) {
    return personalDataEncryptionUnavailable(error, requestId);
  }
  if (!value) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  return NextResponse.json(
    { value },
    { status: 200, headers: { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId } }
  );
}
