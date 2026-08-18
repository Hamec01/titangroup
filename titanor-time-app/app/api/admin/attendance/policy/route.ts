import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';
import { getCompanyAttendancePolicy, validatePolicyPatchInput, updateCompanyAttendancePolicy } from '@/lib/attendance-policy';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1 + Addendum "T7A.10A" §F —
// GET/PATCH /api/admin/attendance/policy.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/attendance/policy';

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'attendance.policy.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const policy = await getCompanyAttendancePolicy();
  return NextResponse.json(policy, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'attendance.policy.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};

  // Idempotency-Key is mandatory for this endpoint (task spec — mutating admin policy update).
  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (idempotencyKeyHeader === null || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
  }
  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'PATCH',
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
        message: begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS' ? 'A request with this Idempotency-Key is still being processed.' : 'This Idempotency-Key was already used for a different request.'
      },
      requestId
    );
  }

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body });
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const validated = validatePolicyPatchInput(bodyObject);
  if (!validated.ok) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: validated.fieldErrors }, requestId));
  }

  const updated = await updateCompanyAttendancePolicy(authenticated.user.id, requestId, validated.value);
  return respond(200, updated);
}
