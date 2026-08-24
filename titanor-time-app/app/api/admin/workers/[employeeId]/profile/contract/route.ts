import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';
import { setEmployeeContract, getEmployeeContractPath } from '@/lib/employee-profile';
import { readEmployeeUpload, deleteEmployeeUpload } from '@/lib/employee-files';
import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/workers/:employeeId/profile/contract';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    return jsonError(404, { code: 'NOT_FOUND', message: 'No contract on file.' }, requestId);
  }
  const contractPath = await getEmployeeContractPath(employeeId);
  if (!contractPath) {
    return jsonError(404, { code: 'NOT_FOUND', message: 'No contract on file.' }, requestId);
  }
  const buffer = await readEmployeeUpload(contractPath);
  const contentType = contractPath.endsWith('.pdf') ? 'application/pdf' : contractPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return new NextResponse(buffer, { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-store' } });
}

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
  const file = formData.get('contract');
  if (!(file instanceof File)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'contract file is required.', fieldErrors: { contract: ['required'] } }, requestId);
  }

  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'POST',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey: idempotencyKeyHeader
  };
  const requestHash = computeRequestHash({ pathParams: { employeeId }, body: { fileName: file.name, fileSize: file.size } });
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

  const result = await setEmployeeContract({ employeeId, file, actorUserId: authenticated.user.id, requestId });
  if (!result.ok) {
    if (result.code === 'EMPLOYEE_NOT_FOUND') {
      return respond(404, { error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.', requestId } });
    }
    return respond(400, { error: { code: result.code, message: result.code === 'TOO_LARGE' ? 'File is too large.' : 'Unsupported file type.', requestId } });
  }
  return respond(200, { ok: true });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
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

  const profile = await prisma.employeeProfile.findUnique({ where: { employeeId }, select: { id: true, contractPath: true } });
  if (!profile?.contractPath) {
    return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
  }

  await prisma.$transaction(async (tx) => {
    await tx.employeeProfile.update({ where: { employeeId }, data: { contractPath: null, contractUploadedByUserId: null, contractUploadedAt: null } });
    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'EMPLOYEE_CONTRACT_REMOVED',
      entityType: 'EMPLOYEE_PROFILE',
      entityId: profile.id,
      requestId,
      beforeValue: { contractPath: profile.contractPath },
      afterValue: null
    });
  });
  await deleteEmployeeUpload(profile.contractPath);

  return NextResponse.json({ ok: true }, { status: 200, headers: successHeaders(requestId) });
}
