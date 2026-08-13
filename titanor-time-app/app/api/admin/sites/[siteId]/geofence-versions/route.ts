import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getGeofenceHistory, createGeofenceVersion, validateGeofenceInput } from '@/lib/geofences';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.3/§16 "Geofence admin" — exact contract
// for this endpoint pair.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/sites/:siteId/geofence-versions';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
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

  if (!(await hasPermission(authenticated.user.roles, 'attendance.geofence.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { siteId } = await params;
  // Malformed and nonexistent siteId must be indistinguishable (same 404, no oracle) — a
  // non-UUID string passed straight to Prisma's uuid-typed WHERE would otherwise throw and
  // surface as an uncaught 500 instead.
  if (!UUID_PATTERN.test(siteId)) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize = Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE ? pageSizeParam : DEFAULT_PAGE_SIZE;

  const result = await getGeofenceHistory(siteId, page, pageSize);
  if (!result) {
    return jsonError(404, { code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId);
  }

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

  if (!(await hasPermission(authenticated.user.roles, 'attendance.geofence.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { siteId } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  // Idempotency-Key is mandatory for this endpoint (§12.3 — a mutating create, same convention as
  // POST /api/admin/workers).
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
  // requestHash covers siteId (path param) + the canonical body — a replay against a different
  // site or with a different body under the same key must be rejected, not silently reused.
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
        message: begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS' ? 'A request with this Idempotency-Key is still being processed.' : 'This Idempotency-Key was already used for a different request.'
      },
      requestId
    );
  }

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body });
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  if (!UUID_PATTERN.test(siteId)) {
    return respond(404, errorBody({ code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId));
  }

  const validated = validateGeofenceInput(bodyObject);
  if (!validated.ok) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId));
  }

  const result = await createGeofenceVersion(siteId, authenticated.user.id, requestId, validated.value);
  if ('code' in result) {
    return respond(404, errorBody({ code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId));
  }

  return respond(201, { ...result.version, currentGeofenceVersionId: result.currentGeofenceVersionId });
}
