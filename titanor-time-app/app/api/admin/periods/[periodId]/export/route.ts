import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { UUID_PATTERN } from '@/lib/attendance-exceptions';
import { isValidIdempotencyKeyFormat, computeRequestHash, beginIdempotentRequest, completeIdempotentRequest, type IdempotencyIdentity } from '@/lib/idempotency';
import { createExportBatch } from '@/lib/csv-export';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" §BK — POST /api/admin/periods/:periodId/export.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/periods/:periodId/export';
type RouteParams = { params: Promise<{ periodId: string }> };

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
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

  // Both permissions required simultaneously (§BK) — not an OR.
  if (!(await hasPermission(authenticated.user.roles, 'period.export'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }
  if (!(await hasPermission(authenticated.user.roles, 'export.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { periodId } = await params;
  if (!UUID_PATTERN.test(periodId)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'periodId must be a UUID.', fieldErrors: { periodId: ['invalid'] } }, requestId);
  }

  // Body — must be absent or an empty JSON object. Any field at all is "unknown" (none are allowed).
  const rawText = await request.text();
  let bodyObject: Record<string, unknown> = {};
  if (rawText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be an empty JSON object.' }, requestId);
    }
    bodyObject = parsed as Record<string, unknown>;
  }
  if (Object.keys(bodyObject).length > 0) {
    const fieldErrors: Record<string, string[]> = {};
    for (const key of Object.keys(bodyObject)) {
      fieldErrors[key] = ['unknown field'];
    }
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'This endpoint accepts no request body fields.', fieldErrors }, requestId);
  }

  // Idempotency-Key is mandatory for this endpoint.
  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (idempotencyKeyHeader === null || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' }, requestId);
  }
  const identity: IdempotencyIdentity = { actorUserId: authenticated.user.id, httpMethod: 'POST', routeTemplate: ROUTE_TEMPLATE, idempotencyKey: idempotencyKeyHeader };
  const requestHash = computeRequestHash({ pathParams: { periodId }, body: bodyObject });
  const begin = await beginIdempotentRequest(identity, requestHash);
  if (begin.kind === 'CACHED') {
    return NextResponse.json(begin.body, { status: begin.statusCode, headers: successHeaders(requestId) });
  }
  if (begin.kind === 'CONFLICT') {
    return jsonError(
      409,
      { code: begin.code, message: begin.code === 'IDEMPOTENCY_KEY_IN_PROGRESS' ? 'A request with this Idempotency-Key is still being processed.' : 'This Idempotency-Key was already used for a different request.' },
      requestId
    );
  }

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body });
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const result = await createExportBatch(periodId, authenticated.user.id, requestId);

  if ('code' in result) {
    switch (result.code) {
      case 'PERIOD_NOT_FOUND':
        return respond(404, errorBody({ code: 'PERIOD_NOT_FOUND', message: 'No period with this id.' }, requestId));
      case 'PERIOD_NOT_EXPORTABLE':
        return respond(409, errorBody({ code: 'PERIOD_NOT_EXPORTABLE', message: 'Period must be LOCKED or EXPORTED to export.' }, requestId));
      case 'NOTHING_TO_EXPORT':
        return respond(409, errorBody({ code: 'NOTHING_TO_EXPORT', message: 'Period is already EXPORTED and has no pending corrections to export.' }, requestId));
    }
  }

  return respond(201, result);
}
