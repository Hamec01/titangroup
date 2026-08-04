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
import { createForemanAssignment } from '@/lib/foreman-assignments';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Contract designed by this task (04_ADMIN_FIRST_API_CONTRACTS.md has no
// admin-facing foreman-assignment endpoints — see PROJECT_ROADMAP.md T6.9),
// confirmed by the owner.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/foreman-assignments';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

  if (!(await hasPermission(authenticated.user.roles, 'foreman_assignment.create'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  // Idempotency-Key is supported, not required — lower stakes than
  // assignment.create (no side-effect upserts, no DB-level dedup at all for
  // this entity, so a genuine duplicate row from a retry is cheap to fix).
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

  const { foremanUserId, siteId, isSubstitute, validFrom, validTo } = bodyObject as {
    foremanUserId?: unknown;
    siteId?: unknown;
    isSubstitute?: unknown;
    validFrom?: unknown;
    validTo?: unknown;
  };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof foremanUserId !== 'string' || !UUID_PATTERN.test(foremanUserId)) {
    fieldErrors.foremanUserId = ['required'];
  }
  if (typeof siteId !== 'string' || !UUID_PATTERN.test(siteId)) {
    fieldErrors.siteId = ['required'];
  }
  let normalizedIsSubstitute = false;
  if (isSubstitute !== undefined) {
    if (typeof isSubstitute !== 'boolean') {
      fieldErrors.isSubstitute = ['invalid'];
    } else {
      normalizedIsSubstitute = isSubstitute;
    }
  }
  if (typeof validFrom !== 'string' || !DATE_PATTERN.test(validFrom)) {
    fieldErrors.validFrom = ['required'];
  }
  let normalizedValidTo: Date | null = null;
  if (validTo !== undefined && validTo !== null) {
    if (typeof validTo !== 'string' || !DATE_PATTERN.test(validTo)) {
      fieldErrors.validTo = ['invalid'];
    } else {
      normalizedValidTo = new Date(`${validTo}T00:00:00.000Z`);
    }
  }

  if (
    Object.keys(fieldErrors).length === 0 &&
    normalizedValidTo !== null &&
    normalizedValidTo < new Date(`${validFrom as string}T00:00:00.000Z`)
  ) {
    fieldErrors.validTo = ['before validFrom'];
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  const result = await createForemanAssignment({
    foremanUserId: foremanUserId as string,
    siteId: siteId as string,
    isSubstitute: normalizedIsSubstitute,
    validFrom: new Date(`${validFrom as string}T00:00:00.000Z`),
    validTo: normalizedValidTo,
    assignedByUserId: authenticated.user.id,
    requestId
  });

  if ('code' in result) {
    switch (result.code) {
      case 'FOREMAN_NOT_FOUND':
        return respond(404, errorBody({ code: 'FOREMAN_NOT_FOUND', message: 'foremanUserId does not reference an existing user.' }, requestId));
      case 'SITE_NOT_FOUND':
        return respond(404, errorBody({ code: 'SITE_NOT_FOUND', message: 'siteId does not reference an existing site.' }, requestId));
      case 'USER_NOT_FOREMAN':
        return respond(409, errorBody({ code: 'USER_NOT_FOREMAN', message: 'This user does not currently hold an active FOREMAN role.' }, requestId));
    }
  }

  return respond(201, result);
}
