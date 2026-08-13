import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { issueSystemActivationToken } from '@/lib/system-activation';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md — POST /api/admin/users/:userId/activation.
// Standalone-FOREMAN counterpart to POST /api/admin/workers/:employeeId/activation — same
// pattern (Idempotency-Key mandatory, permission gate, UUID path param), different permission and
// target table (UserActivationToken via lib/system-activation.ts, not ActivationToken).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/users/:userId/activation';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ userId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'user.activation.generate'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { userId } = await params;
  if (!UUID_PATTERN.test(userId)) {
    return jsonError(404, { code: 'USER_NOT_FOUND', message: 'No user with this id.' }, requestId);
  }

  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (idempotencyKeyHeader === null || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
  }
  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'POST',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey: idempotencyKeyHeader
  };
  const requestHash = computeRequestHash({ pathParams: { userId } });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') {
    return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  }
  if (begin.kind === 'CONFLICT') {
    return jsonError(
      409,
      {
        code: begin.code,
        message:
          begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS'
            ? 'A request with this Idempotency-Key is still being processed.'
            : 'This Idempotency-Key was already used for a different request.'
      },
      requestId
    );
  }

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body });
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const result = await issueSystemActivationToken(userId, authenticated.user.id, requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'USER_NOT_FOUND':
        return respond(404, errorBody({ code: 'USER_NOT_FOUND', message: 'No user with this id.' }, requestId));
      case 'USER_ALREADY_ACTIVE':
        return respond(409, errorBody({ code: 'USER_ALREADY_ACTIVE', message: 'This user has already activated their account.' }, requestId));
      case 'USER_USES_WORKER_ACTIVATION':
        return respond(
          409,
          errorBody({ code: 'USER_USES_WORKER_ACTIVATION', message: 'This user is linked to an Employee and uses the worker activation flow instead.' }, requestId)
        );
      case 'SYSTEM_USER_NOT_ELIGIBLE':
        return respond(409, errorBody({ code: 'SYSTEM_USER_NOT_ELIGIBLE', message: 'This user is a reserved system actor and cannot be activated.' }, requestId));
      case 'ACCOUNT_NOT_ELIGIBLE':
        return respond(409, errorBody({ code: 'ACCOUNT_NOT_ELIGIBLE', message: 'This account is not eligible for activation.' }, requestId));
    }
  }

  return respond(201, result);
}
