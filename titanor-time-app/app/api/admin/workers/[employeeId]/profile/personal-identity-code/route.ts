import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, personalDataEncryptionUnavailable } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getEmployeeProfilePersonalIdentityCode } from '@/lib/employee-profile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Worker Dossier feature (2026-08-26, task spec §43) — the profile GET/list responses only ever
// carry personalIdentityCodeLast4 (masked). Decrypted plaintext is only ever returned from this
// separate, explicitly-authorized "reveal" endpoint, on demand.
export async function GET(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  let value: string | null;
  try {
    value = await getEmployeeProfilePersonalIdentityCode(employeeId);
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
