import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { checkRateLimit } from '@/lib/rate-limit';
import { validateSwitchSiteBody, performSwitchSite } from '@/lib/attendance-clock';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §9.3/§12.2/§14 — POST /api/worker/attendance/switch-site.
// One HTTP request, one DB transaction — checkOutClientEventId/checkInClientEventId are each the
// mandatory natural idempotency key for their own half; Idempotency-Key header is OPTIONAL.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/worker/attendance/switch-site';
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

  if (!(await hasPermission(authenticated.user.roles, 'attendance.clock.switch_site.own'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  if (!authenticated.user.employeeId) {
    return jsonError(403, { code: 'NO_EMPLOYEE_PROFILE', message: 'This user has no linked employee profile.' }, requestId);
  }

  if (!(await checkRateLimit(`actor:${authenticated.user.id}:${ROUTE_TEMPLATE}`, RATE_LIMIT.limit, RATE_LIMIT.windowMs))) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many switch-site attempts. Try again later.' }, requestId);
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

  const validated = validateSwitchSiteBody(bodyObject);
  if (!validated.ok) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId));
  }

  const result = await performSwitchSite(authenticated.user.employeeId, authenticated.user.id, requestId, validated.value);

  switch (result.kind) {
    case 'CREATED':
      return respond(201, { groupId: result.groupId, checkOut: result.checkOut, checkIn: result.checkIn });
    case 'REPLAY':
      return respond(200, { groupId: result.groupId, checkOut: result.checkOut, checkIn: result.checkIn });
    case 'CONFLICT':
      return respond(409, errorBody({ code: 'CLIENT_EVENT_ID_REUSED', message: 'One of these clientEventIds was already used with a different payload, or this pair does not exactly replay a previous switch.' }, requestId));
    case 'NO_OPEN_SHIFT':
      return respond(409, errorBody({ code: 'NO_OPEN_SHIFT_TO_SWITCH', message: 'No open shift to switch from.' }, requestId));
    case 'OUTSIDE_GEOFENCE':
      return respond(403, errorBody({ code: 'OUTSIDE_GEOFENCE', message: 'GPS reading is outside the new site geofence.' }, requestId));
    case 'SITE_NOT_FOUND':
      return respond(404, errorBody({ code: 'SITE_NOT_FOUND', message: 'No site with this id.' }, requestId));
    case 'WORK_AREA_INVALID':
      return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { newWorkAreaId: ['not found for this site'] } }, requestId));
  }
}
