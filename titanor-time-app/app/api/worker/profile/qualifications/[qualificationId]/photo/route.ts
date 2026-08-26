import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getEmployeeQualificationPhotoPath, setEmployeeQualificationPhoto, removeEmployeeQualificationPhoto } from '@/lib/employee-profile';
import { readEmployeeUpload } from '@/lib/employee-files';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ qualificationId: string }> }): Promise<NextResponse> {
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

  const { qualificationId } = await params;
  if (!UUID_PATTERN.test(qualificationId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  const photoPath = await getEmployeeQualificationPhotoPath(qualificationId, authenticated.user.employeeId);
  if (!photoPath) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  const buffer = await readEmployeeUpload(photoPath);
  return new NextResponse(buffer, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ qualificationId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This account has no employee profile.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.update.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { qualificationId } = await params;
  if (!UUID_PATTERN.test(qualificationId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be multipart/form-data.' }, requestId);
  }
  const file = formData.get('photo');
  if (!(file instanceof File)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'photo file is required.', fieldErrors: { photo: ['required'] } }, requestId);
  }

  const result = await setEmployeeQualificationPhoto(qualificationId, authenticated.user.employeeId, file);
  if (!result.ok) {
    if (result.code === 'NOT_FOUND' || result.code === 'FORBIDDEN') {
      return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
    }
    return jsonError(400, { code: result.code, message: result.code === 'TOO_LARGE' ? 'Photo is too large.' : 'Unsupported photo type.' }, requestId);
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ qualificationId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This account has no employee profile.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.profile.update.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { qualificationId } = await params;
  if (!UUID_PATTERN.test(qualificationId)) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }

  const result = await removeEmployeeQualificationPhoto(qualificationId, authenticated.user.employeeId);
  if (!result.ok) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}
