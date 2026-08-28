import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';
import { addEmployeeProfession, listEmployeeProfessions, isProfessionCategory } from '@/lib/professions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// T13.2 — a worker's professions. GET lists them; POST adds one (catalog definitionId XOR
// customName + customCategory). Permission: worker.profession.manage (ADMIN + SUPER_ADMIN).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/workers/:employeeId/professions';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, { params }: { params: Promise<{ employeeId: string }> }): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'worker.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }
  const items = await listEmployeeProfessions(employeeId);
  return NextResponse.json({ items }, { status: 200, headers: successHeaders(requestId) });
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
  if (!(await hasPermission(authenticated.user.roles, 'worker.profession.manage'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' }, requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be JSON.' }, requestId);
  }

  const definitionId = typeof body.definitionId === 'string' && body.definitionId.length > 0 ? body.definitionId : null;
  const customName = typeof body.customName === 'string' && body.customName.trim().length > 0 ? body.customName : null;
  const customCategory = body.customCategory;

  if ((definitionId && customName) || (!definitionId && !customName)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Provide exactly one of definitionId or (customName + customCategory).', fieldErrors: { definitionId: ['exactly one of definitionId / customName required'] } }, requestId);
  }
  if (definitionId && !UUID_PATTERN.test(definitionId)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid definitionId.', fieldErrors: { definitionId: ['must be a UUID'] } }, requestId);
  }
  if (customName && !isProfessionCategory(customCategory)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid customCategory.', fieldErrors: { customCategory: ['must be SHIPBUILDING or CONSTRUCTION'] } }, requestId);
  }

  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  let identity: IdempotencyIdentity | null = null;
  if (idempotencyKeyHeader !== null) {
    if (!isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID.' }, requestId);
    }
    identity = { actorUserId: authenticated.user.id, httpMethod: 'POST', routeTemplate: ROUTE_TEMPLATE, idempotencyKey: idempotencyKeyHeader };
    const requestHash = computeRequestHash({ pathParams: { employeeId }, body: { definitionId, customName: customName?.trim() ?? null, customCategory: customName ? String(customCategory) : null } });
    const begin = await beginIdempotentRequest(identity, requestHash);
    if (begin.kind === 'CACHED') {
      return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
    }
    if (begin.kind === 'CONFLICT') {
      return jsonError(409, { code: begin.code, message: begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS' ? 'A request with this Idempotency-Key is still being processed.' : 'This Idempotency-Key was already used for a different request.' }, requestId);
    }
  }
  const respond = async (statusCode: number, resBody: unknown): Promise<NextResponse> => {
    if (identity) await completeIdempotentRequest(identity, { statusCode, body: resBody });
    return NextResponse.json(resBody, { status: statusCode, headers: successHeaders(requestId) });
  };

  const result = definitionId
    ? await addEmployeeProfession({ employeeId, definitionId, actorUserId: authenticated.user.id, requestId })
    : await addEmployeeProfession({ employeeId, customName: customName as string, customCategory: customCategory as 'SHIPBUILDING' | 'CONSTRUCTION', actorUserId: authenticated.user.id, requestId });

  if (!result.ok) {
    if (result.code === 'ALREADY_ADDED') {
      return respond(409, { error: { code: 'PROFESSION_ALREADY_ADDED', message: 'This worker already has that profession.', requestId } });
    }
    if (result.code === 'EMPLOYEE_NOT_FOUND') {
      return respond(404, { error: { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.', requestId } });
    }
    if (result.code === 'DEFINITION_NOT_FOUND') {
      return respond(400, { error: { code: 'DEFINITION_NOT_FOUND', message: 'Unknown or inactive profession.', requestId } });
    }
    if (result.code === 'VALIDATION_ERROR') {
      return respond(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors, requestId } });
    }
    return respond(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', requestId } });
  }
  return respond(201, { id: result.id });
}
