import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getEmployeeQualificationPhotoPath } from '@/lib/employee-profile';
import { readEmployeeUpload } from '@/lib/employee-files';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ employeeId: string; qualificationId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId, qualificationId } = await params;
  if (!UUID_PATTERN.test(employeeId) || !UUID_PATTERN.test(qualificationId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  const photoPath = await getEmployeeQualificationPhotoPath(qualificationId, employeeId);
  if (!photoPath) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  const buffer = await readEmployeeUpload(photoPath);
  return new NextResponse(buffer, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } });
}
