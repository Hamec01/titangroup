import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import {
  isValidIdempotencyKeyFormat,
  computeRequestHash,
  beginIdempotentRequest,
  completeIdempotentRequest,
  type IdempotencyIdentity
} from '@/lib/idempotency';
import { createPeriod, listPeriods } from '@/lib/periods';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §7 — exact contract.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/periods';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'period.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const periods = await listPeriods();
  return NextResponse.json(periods, { status: 200, headers: successHeaders(requestId) });
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

  if (!(await hasPermission(authenticated.user.roles, 'period.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

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

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    if (identity) {
      await completeIdempotentRequest(identity, { statusCode, body });
    }
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const { startDate, endDate } = bodyObject as { startDate?: unknown; endDate?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof startDate !== 'string' || !DATE_PATTERN.test(startDate)) {
    fieldErrors.startDate = ['required'];
  }
  if (typeof endDate !== 'string' || !DATE_PATTERN.test(endDate)) {
    fieldErrors.endDate = ['required'];
  }
  if (
    Object.keys(fieldErrors).length === 0 &&
    new Date(`${endDate as string}T00:00:00.000Z`) < new Date(`${startDate as string}T00:00:00.000Z`)
  ) {
    fieldErrors.endDate = ['before startDate'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  const result = await createPeriod({
    startDate: new Date(`${startDate as string}T00:00:00.000Z`),
    endDate: new Date(`${endDate as string}T00:00:00.000Z`),
    openedByUserId: authenticated.user.id,
    requestId
  });

  if ('code' in result) {
    return respond(409, errorBody({ code: 'PERIOD_OVERLAP', message: 'This date range overlaps an existing period.' }, requestId));
  }

  return respond(201, result);
}
