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
const ROUTE_TEMPLATE = '/api/worker/profile/qualifications';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
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
  const definitionIdRaw = formData.get('definitionId');
  const name = formData.get('name');
  const certificateNumberRaw = formData.get('certificateNumber');
  const issuerRaw = formData.get('issuer');
  const issuedOnRaw = formData.get('issuedOn');
  const expiresOnRaw = formData.get('expiresOn');
  const photo = formData.get('photo');

  const definitionId = typeof definitionIdRaw === 'string' && definitionIdRaw.length > 0 ? definitionIdRaw : null;
  if (!definitionId && (typeof name !== 'string' || name.trim().length === 0)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'name is required.', fieldErrors: { name: ['required'] } }, requestId);
  }
  const parseDate = (raw: FormDataEntryValue | null, field: string): Date | null | { error: NextResponse } => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    if (!DATE_PATTERN.test(raw)) {
      return { error: jsonError(400, { code: 'VALIDATION_ERROR', message: `Invalid ${field}.`, fieldErrors: { [field]: ['invalid'] } }, requestId) };
    }
    return new Date(`${raw}T00:00:00.000Z`);
  };
  const issuedOnParsed = parseDate(issuedOnRaw, 'issuedOn');
  if (issuedOnParsed && typeof issuedOnParsed === 'object' && 'error' in issuedOnParsed) return issuedOnParsed.error;
  const expiresOnParsed = parseDate(expiresOnRaw, 'expiresOn');
  if (expiresOnParsed && typeof expiresOnParsed === 'object' && 'error' in expiresOnParsed) return expiresOnParsed.error;
  const issuedOn = issuedOnParsed as Date | null;
  const expiresOn = expiresOnParsed as Date | null;
  const photoFile = photo instanceof File ? photo : null;

  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'POST',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey: idempotencyKeyHeader
  };
  const requestHash = computeRequestHash({ body: { definitionId, name: typeof name === 'string' ? name.trim() : null, expiresOn: expiresOnRaw ?? null, hasPhoto: Boolean(photoFile) } });
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

  const result = await createEmployeeQualification({
    employeeId: authenticated.user.employeeId,
    definitionId,
    name: typeof name === 'string' ? name : null,
    certificateNumber: typeof certificateNumberRaw === 'string' ? certificateNumberRaw : null,
    issuer: typeof issuerRaw === 'string' ? issuerRaw : null,
    issuedOn,
    expiresOn,
    photoFile,
    actorUserId: authenticated.user.id,
    requestId,
    isAdminActor: false
  });

  if (!result.ok) {
    if (result.code === 'VALIDATION_ERROR') {
      return respond(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors, requestId } });
    }
    if (result.code === 'EMPLOYEE_NOT_FOUND') {
      return respond(404, { error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.', requestId } });
    }
    if (result.code === 'DEFINITION_NOT_FOUND' || result.code === 'DEFINITION_NOT_SELECTABLE') {
      return respond(400, { error: { code: result.code, message: 'Invalid qualification selection.', requestId } });
    }
    return respond(400, { error: { code: result.code, message: result.code === 'TOO_LARGE' ? 'Photo is too large.' : 'Unsupported photo type.', requestId } });
  }

  return respond(201, { id: result.id });
}
