import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  computeRequestHash,
  isValidIdempotencyKeyFormat,
  type IdempotencyIdentity
} from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §2 — exact contract for this endpoint.
//
// proxy.ts already blocks unauthenticated requests to /api/admin/* at the
// gate, but re-checks the session here anyway — per Next.js's own Proxy
// guidance, a matcher change or a route move can silently remove that
// coverage, so each route verifies auth/permission itself rather than
// trusting the gate alone.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'city.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const cities = await prisma.city.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true }
  });

  return NextResponse.json(
    { items: cities },
    { status: 200, headers: successHeaders(requestId) }
  );
}

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/cities';
const MAX_NAME_LENGTH = 255;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'city.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};

  const idempotencyKey = request.headers.get('idempotency-key');
  let identity: IdempotencyIdentity | null = null;
  if (idempotencyKey !== null) {
    if (!isValidIdempotencyKeyFormat(idempotencyKey)) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID.' }, requestId);
    }
    identity = {
      actorUserId: authenticated.user.id,
      httpMethod: 'POST',
      routeTemplate: ROUTE_TEMPLATE,
      idempotencyKey
    };
    const begin = await beginIdempotentRequest(identity, computeRequestHash({ body }));
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
  }

  const respond = async (statusCode: number, responseBody: unknown): Promise<NextResponse> => {
    if (identity) await completeIdempotentRequest(identity, { statusCode, body: responseBody });
    return NextResponse.json(responseBody, { status: statusCode, headers: successHeaders(requestId) });
  };

  const name = body.name;
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > MAX_NAME_LENGTH) {
    return respond(
      400,
      errorBody(
        {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body.',
          fieldErrors: { name: [typeof name === 'string' && name.trim().length > MAX_NAME_LENGTH ? 'too long' : 'required'] }
        },
        requestId
      )
    );
  }

  try {
    const city = await prisma.$transaction(async (tx) => {
      const created = await tx.city.create({ data: { name: name.trim() } });
      await createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'CITY_CREATED',
        entityType: 'CITY',
        entityId: created.id,
        requestId,
        beforeValue: null,
        afterValue: { id: created.id, name: created.name }
      });
      return created;
    });
    return respond(201, { id: city.id, name: city.name });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return respond(409, errorBody({ code: 'DUPLICATE_CITY_NAME', message: 'A city with this name already exists.' }, requestId));
    }
    throw error;
  }
}
