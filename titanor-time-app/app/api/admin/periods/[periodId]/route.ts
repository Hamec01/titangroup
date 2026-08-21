import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { getPeriodDetail, updateLegacyOpenPeriod } from '@/lib/periods';
import { computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, isValidIdempotencyKeyFormat, type IdempotencyIdentity } from '@/lib/idempotency';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §7 — GET /api/admin/periods/:periodId.
type RouteParams = { params: Promise<{ periodId: string }> };
// A malformed id must never reach Prisma (throws P2023, surfaces as a 500) and must be
// indistinguishable from a genuinely nonexistent one (no oracle).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function GET(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'period.read.all'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { periodId } = await params;
  if (!UUID_PATTERN.test(periodId)) {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
  }
  const period = await getPeriodDetail(periodId);
  if (!period) {
    return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
  }

  return NextResponse.json(period, { status: 200, headers: successHeaders(requestId) });
}

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== 'titanor-time') {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }
  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  if (!(await hasPermission(authenticated.user.roles, 'period.update'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  const { periodId } = await params;
  if (!UUID_PATTERN.test(periodId)) return jsonError(404, { code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId);
  let raw: unknown;
  try { raw = await request.json(); } catch { return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId); }
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const fieldErrors: Record<string, string[]> = {};
  if (!isCalendarDate(body.startDate)) fieldErrors.startDate = ['invalid'];
  if (!isCalendarDate(body.endDate)) fieldErrors.endDate = ['invalid'];
  if (typeof body.version !== 'number' || !Number.isInteger(body.version) || body.version < 1) fieldErrors.version = ['invalid'];
  if (!fieldErrors.startDate && !fieldErrors.endDate && (body.startDate as string) > (body.endDate as string)) fieldErrors.endDate = ['before_start'];
  if (Object.keys(fieldErrors).length) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors, requestId } }, { status: 400, headers: successHeaders(requestId) });
  }
  const key = request.headers.get('idempotency-key');
  if (!key || !isValidIdempotencyKeyFormat(key)) return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
  const identity: IdempotencyIdentity = { actorUserId: authenticated.user.id, httpMethod: 'PATCH', routeTemplate: '/api/admin/periods/:periodId', idempotencyKey: key };
  const hash = computeRequestHash({ pathParams: { periodId }, body });
  const begin = await beginIdempotentRequest(identity, hash);
  if (begin.kind === 'CACHED') return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  if (begin.kind === 'CONFLICT') return jsonError(409, { code: begin.code, message: 'This Idempotency-Key cannot be used for this request.' }, requestId);
  const respond = async (status: number, responseBody: unknown) => {
    await completeIdempotentRequest(identity, { statusCode: status, body: responseBody });
    return NextResponse.json(responseBody, { status, headers: successHeaders(requestId) });
  };
  const result = await updateLegacyOpenPeriod({
    periodId,
    startDate: new Date(`${body.startDate as string}T00:00:00.000Z`),
    endDate: new Date(`${body.endDate as string}T00:00:00.000Z`),
    version: body.version as number,
    actorUserId: authenticated.user.id,
    requestId
  });
  if (result.ok) return respond(200, result);
  const status = result.code === 'PERIOD_NOT_FOUND' ? 404 : result.code === 'VERSION_CONFLICT' || result.code === 'PERIOD_OVERLAP' ? 409 : 400;
  return respond(status, { error: { code: result.code, message: result.code === 'DATA_OUTSIDE_RANGE' ? 'The new range would remove durable or submitted time data.' : 'This period cannot be edited.', requestId } });
}
