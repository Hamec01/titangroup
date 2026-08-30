import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { issueAccountRecovery } from '@/lib/account-recovery';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// R03 — POST /api/admin/workers/:employeeId/recovery. Admin-assisted account recovery for a worker
// who has already activated (ACTIVE/OFFBOARDING). Resolves the Employee's linked User, then reuses
// the same one-time code as the standalone-user route. Worker still in PENDING_ACTIVATION → 409
// (they need .../activation, not recovery). TZ §7.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/workers/:employeeId/recovery';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ employeeId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'user.recovery.generate'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) {
    return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
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
  const begin = await beginIdempotentRequest(identity, computeRequestHash({ pathParams: { employeeId } }));
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

  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { user: { select: { id: true } } } });
  if (!employee) {
    return respond(404, errorBody({ code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId));
  }
  if (!employee.user) {
    return respond(409, errorBody({ code: 'TARGET_NOT_ELIGIBLE', message: 'This worker has no linked account.' }, requestId));
  }

  const result = await issueAccountRecovery({ targetUserId: employee.user.id, issuedByUserId: authenticated.user.id, requestId });
  if (!result.ok) {
    return respond(
      409,
      errorBody(
        { code: 'TARGET_NOT_ELIGIBLE', message: 'This worker cannot be recovered — they have not activated an account yet (use activation) or are deactivated.' },
        requestId
      )
    );
  }

  return respond(201, { code: result.code, expiresAt: result.expiresAt.toISOString() });
}
