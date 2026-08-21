import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, isValidIdempotencyKeyFormat, type IdempotencyIdentity } from '@/lib/idempotency';
import { assignWorkerSubmissionSchedule, getWorkerSubmissionScheduleView } from '@/lib/timesheet-submission-schedules';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ROUTE_TEMPLATE = '/api/admin/workers/:employeeId/timesheet-schedule';

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

type RouteParams = { params: Promise<{ employeeId: string }> };

function errorBody(body: ApiErrorBody, requestId: string) {
  return { error: { ...body, requestId } };
}

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.schedule.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  const view = await getWorkerSubmissionScheduleView(employeeId);
  if (!view) return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);
  return NextResponse.json(view, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== 'titanor-time') {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'timesheet.schedule.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { employeeId } = await params;
  if (!UUID_PATTERN.test(employeeId)) return jsonError(404, { code: 'WORKER_NOT_FOUND', message: 'No worker with this id.' }, requestId);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const scheduleId = body.scheduleId;
  const effectiveFrom = body.effectiveFrom;
  const fieldErrors: Record<string, string[]> = {};
  if (typeof scheduleId !== 'string' || !UUID_PATTERN.test(scheduleId)) fieldErrors.scheduleId = ['invalid'];
  if (!isCalendarDate(effectiveFrom)) {
    fieldErrors.effectiveFrom = ['invalid'];
  }
  if (Object.keys(fieldErrors).length) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId), {
      status: 400,
      headers: successHeaders(requestId)
    });
  }

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey || !isValidIdempotencyKeyFormat(idempotencyKey)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
  }
  const identity: IdempotencyIdentity = {
    actorUserId: authenticated.user.id,
    httpMethod: 'PATCH',
    routeTemplate: ROUTE_TEMPLATE,
    idempotencyKey
  };
  const requestHash = computeRequestHash({ pathParams: { employeeId }, body: { scheduleId, effectiveFrom } });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  if (begin.kind === 'CONFLICT') {
    return jsonError(409, { code: begin.code, message: 'This Idempotency-Key cannot be used for this request.' }, requestId);
  }
  const respond = async (status: number, responseBody: unknown) => {
    await completeIdempotentRequest(identity, { statusCode: status, body: responseBody });
    return NextResponse.json(responseBody, { status, headers: successHeaders(requestId) });
  };

  const result = await assignWorkerSubmissionSchedule({
    employeeId,
    scheduleId: scheduleId as string,
    effectiveFrom: new Date(`${effectiveFrom as string}T00:00:00.000Z`),
    actorUserId: authenticated.user.id,
    requestId
  });
  if (!result.ok) {
    if (result.code === 'WORKER_NOT_FOUND') return respond(404, errorBody({ code: result.code, message: 'No worker with this id.' }, requestId));
    if (result.code === 'SCHEDULE_NOT_FOUND') return respond(404, errorBody({ code: result.code, message: 'No active schedule with this id.' }, requestId));
    if (result.code === 'EFFECTIVE_FROM_NOT_BOUNDARY') {
      return respond(400, errorBody({ code: result.code, message: 'Start date must be the first day of the selected cycle.', fieldErrors: { effectiveFrom: ['not_cycle_boundary'] } }, requestId));
    }
    if (result.code === 'EFFECTIVE_FROM_BEFORE_CURRENT') {
      return respond(409, errorBody({ code: result.code, message: 'The new cycle cannot start before the currently scheduled change.' }, requestId));
    }
    if (result.code === 'EXISTING_PERIOD_HAS_DATA') {
      return respond(409, errorBody({ code: result.code, message: 'An existing generated period already contains durable worker data.' }, requestId));
    }
    return respond(409, errorBody({ code: 'PERIOD_OVERLAP', message: 'This worker already belongs to an overlapping payroll period.' }, requestId));
  }
  return respond(200, result);
}
