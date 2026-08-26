import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { deleteEmployeeQualification, updateEmployeeQualification } from '@/lib/employee-profile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Body: { certificateNumber?, issuer?, issuedOn?, expiresOn? } — no `verify` field: a worker
 * can never set VERIFIED (task spec §13/§20). Editing an already-VERIFIED credential's metadata
 * drops it back to SELF_REPORTED (updateEmployeeQualification's resetVerificationOnEdit). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ qualificationId: string }> }): Promise<NextResponse> {
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
    return jsonError(404, { code: 'NOT_FOUND', message: 'Qualification not found.' }, requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be JSON.' }, requestId);
  }

  const parseDateField = (value: unknown, field: string): Date | null | { error: NextResponse } => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
      return { error: jsonError(400, { code: 'VALIDATION_ERROR', message: `Invalid ${field}.`, fieldErrors: { [field]: ['invalid'] } }, requestId) };
    }
    return new Date(`${value}T00:00:00.000Z`);
  };
  const issuedOnParsed = parseDateField(body.issuedOn, 'issuedOn');
  if (issuedOnParsed && typeof issuedOnParsed === 'object' && 'error' in issuedOnParsed) return issuedOnParsed.error;
  const expiresOnParsed = parseDateField(body.expiresOn, 'expiresOn');
  if (expiresOnParsed && typeof expiresOnParsed === 'object' && 'error' in expiresOnParsed) return expiresOnParsed.error;

  const result = await updateEmployeeQualification({
    qualificationId,
    employeeId: authenticated.user.employeeId,
    certificateNumber: typeof body.certificateNumber === 'string' ? body.certificateNumber : null,
    issuer: typeof body.issuer === 'string' ? body.issuer : null,
    issuedOn: issuedOnParsed as Date | null,
    expiresOn: expiresOnParsed as Date | null,
    actorUserId: authenticated.user.id,
    requestId,
    resetVerificationOnEdit: true
  });
  if (!result.ok) {
    if (result.code === 'VALIDATION_ERROR') {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors }, requestId);
    }
    // FORBIDDEN (owned by someone else) reads identically to NOT_FOUND — never an oracle for
    // which qualification ids exist, same convention as DELETE below.
    return jsonError(404, { code: 'NOT_FOUND', message: 'Qualification not found.' }, requestId);
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
    return jsonError(404, { code: 'NOT_FOUND', message: 'Qualification not found.' }, requestId);
  }

  const result = await deleteEmployeeQualification({
    qualificationId,
    employeeId: authenticated.user.employeeId,
    actorUserId: authenticated.user.id,
    requestId
  });
  if (!result.ok) {
    // FORBIDDEN (owned by someone else) reads identically to NOT_FOUND — never an oracle for
    // which qualification ids exist.
    return jsonError(404, { code: 'NOT_FOUND', message: 'Qualification not found.' }, requestId);
  }
  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}
