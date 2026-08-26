import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getEmployeeQualificationPhotoPath, setEmployeeQualificationPhoto, removeEmployeeQualificationPhoto } from '@/lib/employee-profile';
import { readEmployeeUpload } from '@/lib/employee-files';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/workers/:employeeId/profile/qualifications/:qualificationId/photo';
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
  return new NextResponse(buffer, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ employeeId: string; qualificationId: string }> }): Promise<NextResponse> {
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
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }

  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (idempotencyKeyHeader === null || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
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

  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'POST',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey: idempotencyKeyHeader
  };
  // No non-file body fields exist on this route — the file's bytes are deliberately not hashed
  // (same convention as the qualification-create route's `hasPhoto: boolean`, not a content
  // checksum): the path params alone already fully define "replace this qualification's photo".
  const requestHash = computeRequestHash({ pathParams: { employeeId, qualificationId } });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') {
    return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  }
  if (begin.kind === 'CONFLICT') {
    return jsonError(
      409,
      { code: begin.code, message: begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS' ? 'A request with this Idempotency-Key is still being processed.' : 'This Idempotency-Key was already used for a different request.' },
      requestId
    );
  }
  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body });
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const result = await setEmployeeQualificationPhoto(qualificationId, employeeId, file);
  if (!result.ok) {
    if (result.code === 'NOT_FOUND' || result.code === 'FORBIDDEN') {
      return respond(404, { error: { code: 'NOT_FOUND', message: 'Not found.', requestId } });
    }
    return respond(400, { error: { code: result.code, message: result.code === 'TOO_LARGE' ? 'Photo is too large.' : 'Unsupported photo type.', requestId } });
  }
  return respond(200, { ok: true });
}

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
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }

  const result = await removeEmployeeQualificationPhoto(qualificationId, employeeId);
  if (!result.ok) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'Not found.' }, requestId);
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}
