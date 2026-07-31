import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { createAuditEvent } from '@/lib/audit';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/sites';
// Not specified by the contract (it only says "название, город — опционально,
// адрес, описание") — pragmatic bounds matching the style of MAX_*_LENGTH in
// app/api/auth/login/route.ts, not a documented limit.
const MAX_NAME_LENGTH = 255;
const MAX_ADDRESS_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  if (!(await hasPermission(authenticated.user.roles, 'site.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  // Idempotency-Key is supported, not required, for this endpoint (§0: "Idempotency:
  // поддерживается" here, vs. "обязателен" for endpoints like absence.approve) — a
  // request without the header just skips this whole block and runs once, uncached.
  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  let identity: IdempotencyIdentity | null = null;
  if (idempotencyKeyHeader !== null) {
    if (!isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
      return jsonError(
        400,
        { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID.' },
        requestId
      );
    }
    identity = {
      actorUserId: authenticated.user.id,
      httpMethod: 'POST',
      routeTemplate: ROUTE_TEMPLATE,
      idempotencyKey: idempotencyKeyHeader
    };
    const requestHash = computeRequestHash({ body: bodyObject });
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
  }

  // From here on, every outcome (success or error) is a real, final response to
  // this request — if an Idempotency-Key was supplied, it gets cached via
  // completeIdempotentRequest() below before being returned, so a genuine retry
  // gets this exact response back instead of re-running validation/the write.
  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    if (identity) {
      await completeIdempotentRequest(identity, { statusCode, body });
    }
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const { name, cityId, address, description } = bodyObject as {
    name?: unknown;
    cityId?: unknown;
    address?: unknown;
    description?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  let trimmedName = '';
  if (typeof name !== 'string' || name.trim().length === 0) {
    fieldErrors.name = ['required'];
  } else if (name.trim().length > MAX_NAME_LENGTH) {
    fieldErrors.name = ['too long'];
  } else {
    trimmedName = name.trim();
  }

  if (cityId !== undefined && cityId !== null) {
    if (typeof cityId !== 'string' || !UUID_PATTERN.test(cityId)) {
      fieldErrors.cityId = ['invalid'];
    }
  }
  if (address !== undefined && address !== null) {
    if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH) {
      fieldErrors.address = ['invalid'];
    }
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) {
      fieldErrors.description = ['invalid'];
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  const normalizedCityId = typeof cityId === 'string' ? cityId : null;
  if (normalizedCityId !== null) {
    const city = await prisma.city.findUnique({ where: { id: normalizedCityId }, select: { id: true } });
    if (!city) {
      return respond(404, errorBody({ code: 'CITY_NOT_FOUND', message: 'cityId does not reference an existing city.' }, requestId));
    }
  }

  const site = await prisma.$transaction(async (tx) => {
    const created = await tx.workSite.create({
      data: {
        name: trimmedName,
        cityId: normalizedCityId,
        address: typeof address === 'string' ? address : null,
        description: typeof description === 'string' ? description : null
      }
    });

    await createAuditEvent(tx, {
      actorUserId: authenticated.user.id,
      eventType: 'SITE_CREATED',
      entityType: 'WORK_SITE',
      entityId: created.id,
      requestId,
      beforeValue: null,
      afterValue: {
        id: created.id,
        name: created.name,
        cityId: created.cityId,
        address: created.address,
        description: created.description,
        active: created.active,
        version: created.version
      }
    });

    return created;
  });

  return respond(201, {
    id: site.id,
    name: site.name,
    cityId: site.cityId,
    address: site.address,
    description: site.description,
    active: site.active,
    version: site.version,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString()
  });
}
