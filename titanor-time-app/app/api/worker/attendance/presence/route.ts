import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { checkRateLimit } from '@/lib/rate-limit';
import { validatePresenceSampleInput, recordPresenceSample } from '@/lib/attendance-presence';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §2b — POST /api/worker/attendance/presence.
// One opportunistic "still on site" GPS sample, taken while a shift is open. employeeId always from
// the session. Idempotent on clientSampleId. A structurally valid request for which there is no
// open shift (worker checked out between capture and sync) is a 200 { recorded: false } — not an
// error — so the client stops retrying a sample that can never land.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/worker/attendance/presence';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many presence samples. Try again later.' }, requestId);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const deviceInstallationId = typeof obj.deviceInstallationId === 'string' && UUID_RE.test(obj.deviceInstallationId) ? obj.deviceInstallationId : null;
  if (!deviceInstallationId) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { deviceInstallationId: ['required, must be a UUID'] } }, requestId), {
      status: 400,
      headers: successHeaders(requestId)
    });
  }

  const validated = validatePresenceSampleInput({
    clientSampleId: obj.clientSampleId,
    latitude: obj.latitude,
    longitude: obj.longitude,
    accuracyMeters: obj.accuracyMeters,
    capturedAt: obj.capturedAt,
    capturedOffline: obj.capturedOffline
  });
  if (!validated.ok) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId), {
      status: 400,
      headers: successHeaders(requestId)
    });
  }

  const result = await recordPresenceSample(authenticated.user.employeeId, deviceInstallationId, validated.value);

  switch (result.kind) {
    case 'DEVICE_NOT_OWNED':
      return jsonError(403, { code: 'DEVICE_NOT_OWNED', message: 'This device is not registered to you.' }, requestId);
    case 'DEVICE_REVOKED':
      return jsonError(403, { code: 'DEVICE_REVOKED', message: 'This device has been revoked.' }, requestId);
    case 'CLOCK_SKEW_TOO_LARGE':
      return jsonError(409, { code: 'CLOCK_SKEW_TOO_LARGE', message: 'Device clock is too far off to record this sample.' }, requestId);
    case 'NO_OPEN_SHIFT':
      return NextResponse.json({ recorded: false, reason: 'NO_OPEN_SHIFT' }, { status: 200, headers: successHeaders(requestId) });
    case 'DUPLICATE':
      return NextResponse.json({ recorded: true, duplicate: true }, { status: 200, headers: successHeaders(requestId) });
    case 'RECORDED':
      return NextResponse.json({ recorded: true, insideGeofence: result.insideGeofence }, { status: 201, headers: successHeaders(requestId) });
  }
}
