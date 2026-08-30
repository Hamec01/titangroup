import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { checkRateLimit } from '@/lib/rate-limit';
import { validateSyncRequestBody, performSync } from '@/lib/attendance-sync';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §7/§9.11/§12.2 — POST /api/worker/attendance/sync.
// employeeId always resolved from the session, never the body. A structurally valid batch is
// ALWAYS HTTP 200 — the outcome of each event lives in results[] (§7); HTTP-layer errors are only
// for envelope-level problems (auth/permission/CSRF/malformed JSON/malformed batch shape) or the
// bounded-retry exhaustion case (503).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/worker/attendance/sync';
const RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };

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

  if (!(await hasPermission(authenticated.user.roles, 'attendance.clock.sync.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  if (!(await checkRateLimit(`actor:${authenticated.user.id}:${ROUTE_TEMPLATE}`, RATE_LIMIT.limit, RATE_LIMIT.windowMs))) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many sync attempts. Try again later.' }, requestId);
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
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header must be a UUID when present.' }, requestId);
    }
    identity = { actorUserId: authenticated.user.id, httpMethod: 'POST', routeTemplate: ROUTE_TEMPLATE, idempotencyKey: idempotencyKeyHeader };
    const requestHash = computeRequestHash({ body: bodyObject });
    const begin = await beginIdempotentRequest(identity, requestHash);
    if (begin.kind === 'CACHED') {
      return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
    }
    if (begin.kind === 'CONFLICT') {
      return jsonError(409, { code: begin.code, message: begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS' ? 'A request with this Idempotency-Key is still being processed.' : 'This Idempotency-Key was already used for a different request.' }, requestId);
    }
  }

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    if (identity) {
      await completeIdempotentRequest(identity, { statusCode, body });
    }
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const validated = validateSyncRequestBody(bodyObject);
  if (!validated.ok) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId));
  }

  // Business-field errors (beyond the four structural fields validateSyncRequestBody already
  // rejected the whole batch for, if invalid) do NOT reject the request — each such event is
  // still a fully FIFO-placeable SyncEventInput with fieldsValid=false, which performSync's own
  // preflight rejects individually as VALIDATION_ERROR (§9.11), consuming exactly one FIFO slot,
  // never a whole-batch 400.
  const result = await performSync(authenticated.user.employeeId, authenticated.user.id, requestId, validated.deviceInstallationId, validated.events);

  switch (result.kind) {
    case 'OK':
      return respond(200, { results: result.results });
    case 'DEVICE_NOT_OWNED':
      return respond(403, errorBody({ code: 'DEVICE_NOT_OWNED', message: 'This device is not registered to your account.' }, requestId));
    case 'DEVICE_REVOKED':
      return respond(403, errorBody({ code: 'DEVICE_REVOKED', message: 'This device has been revoked.' }, requestId));
    case 'RETRY_EXHAUSTED':
      return respond(503, errorBody({ code: 'INGESTION_RETRY_EXHAUSTED', message: 'Could not process this batch due to contention. Retry the exact same batch shortly.' }, requestId));
  }
}
