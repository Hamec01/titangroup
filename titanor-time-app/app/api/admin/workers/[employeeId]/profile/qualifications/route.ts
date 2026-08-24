import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';
import { createEmployeeQualification } from '@/lib/employee-profile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/workers/:employeeId/profile/qualifications';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
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
  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
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
  const name = formData.get('name');
  const expiresOnRaw = formData.get('expiresOn');
  const photo = formData.get('photo');

  if (typeof name !== 'string' || name.trim().length === 0) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'name is required.', fieldErrors: { name: ['required'] } }, requestId);
  }
  let expiresOn: Date | null = null;
  if (typeof expiresOnRaw === 'string' && expiresOnRaw.length > 0) {
    if (!DATE_PATTERN.test(expiresOnRaw)) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid expiresOn.', fieldErrors: { expiresOn: ['invalid'] } }, requestId);
    }
    expiresOn = new Date(`${expiresOnRaw}T00:00:00.000Z`);
  }
  const photoFile = photo instanceof File ? photo : null;

  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'POST',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey: idempotencyKeyHeader
  };
  const requestHash = computeRequestHash({ pathParams: { employeeId }, body: { name: name.trim(), expiresOn: expiresOnRaw ?? null, hasPhoto: Boolean(photoFile) } });
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

  const result = await createEmployeeQualification({ employeeId, name, expiresOn, photoFile, actorUserId: authenticated.user.id, requestId });
  if (!result.ok) {
    if (result.code === 'VALIDATION_ERROR') {
      return respond(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors, requestId } });
    }
    if (result.code === 'EMPLOYEE_NOT_FOUND') {
      return respond(404, { error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.', requestId } });
    }
    return respond(400, { error: { code: result.code, message: result.code === 'TOO_LARGE' ? 'Photo is too large.' : 'Unsupported photo type.', requestId } });
  }
  return respond(201, { id: result.id });
}
