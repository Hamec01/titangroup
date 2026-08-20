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
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';
import { listWorkAreas } from '@/lib/work-areas';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3 — exact contract for this endpoint.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/sites/:siteId/work-areas';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
// Not specified by the contract (it only says "name") — same bounds style as
// MAX_NAME_LENGTH elsewhere in this codebase.
const MAX_NAME_LENGTH = 128;
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

type RouteParams = { params: Promise<{ siteId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'workarea.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { siteId } = await params;
  if (!UUID_PATTERN.test(siteId)) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  }
  const site = await prisma.workSite.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize =
    Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE
      ? pageSizeParam
      : DEFAULT_PAGE_SIZE;
  const activeParam = searchParams.get('active');
  const active = activeParam === 'true' ? true : activeParam === 'false' ? false : undefined;

  const result = await listWorkAreas(siteId, page, pageSize, active);
  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}

export async function POST(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'workarea.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { siteId } = await params;
  if (!UUID_PATTERN.test(siteId)) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  // Idempotency-Key is supported, not required, for this endpoint (§0/§3:
  // "поддерживается"), same as POST /api/admin/sites.
  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  let identity: IdempotencyIdentity | null = null;
  if (idempotencyKeyHeader !== null) {
    if (!isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID.' }, requestId);
    }
    identity = {
      actorUserId: authenticated.user.id,
      httpMethod: 'POST',
      routeTemplate: ROUTE_TEMPLATE,
      idempotencyKey: idempotencyKeyHeader
    };
    const requestHash = computeRequestHash({ pathParams: { siteId }, body: bodyObject });
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

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    if (identity) {
      await completeIdempotentRequest(identity, { statusCode, body });
    }
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const { name } = bodyObject as { name?: unknown };
  const fieldErrors: Record<string, string[]> = {};
  let trimmedName = '';
  if (typeof name !== 'string' || name.trim().length === 0) {
    fieldErrors.name = ['required'];
  } else if (name.trim().length > MAX_NAME_LENGTH) {
    fieldErrors.name = ['too long'];
  } else {
    trimmedName = name.trim();
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  const site = await prisma.workSite.findUnique({ where: { id: siteId }, select: { id: true } });
  if (!site) {
    return respond(404, errorBody({ code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId));
  }

  try {
    const area = await prisma.$transaction(async (tx) => {
      const created = await tx.workArea.create({ data: { siteId, name: trimmedName } });

      await createAuditEvent(tx, {
        actorUserId: authenticated.user.id,
        eventType: 'WORK_AREA_CREATED',
        entityType: 'WORK_AREA',
        entityId: created.id,
        requestId,
        beforeValue: null,
        afterValue: { id: created.id, siteId: created.siteId, name: created.name, active: created.active, version: created.version }
      });

      return created;
    });

    return respond(201, {
      id: area.id,
      siteId: area.siteId,
      name: area.name,
      active: area.active,
      version: area.version,
      createdAt: area.createdAt.toISOString(),
      updatedAt: area.updatedAt.toISOString()
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return respond(
        409,
        errorBody({ code: 'DUPLICATE_WORK_AREA_NAME', message: 'A work area with this name already exists on this site.' }, requestId)
      );
    }
    throw error;
  }
}
