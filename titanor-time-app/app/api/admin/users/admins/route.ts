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
import { createStandaloneAdmin } from '@/lib/users';
import type { Locale } from '@prisma/client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// SUPER_ADMIN-only counterpart to POST /api/admin/users (which can only create/grant FOREMAN —
// see that route's own comment). Deliberately a separate route rather than a `role` field bolted
// onto the existing one: that route's body validation hard-rejects `role`/`roles` specifically so
// a FOREMAN-level caller can never smuggle in an elevated role, and this keeps that guarantee
// intact rather than threading a permission-gated exception through it. Always STANDALONE — an
// ADMIN account is never created by granting a role to an existing worker's User.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/users/admins';

const USERNAME_FORMAT = /^[a-z0-9._-]{3,64}$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 255;
const VALID_LOCALES: Locale[] = ['RU', 'EN'];
const DEFAULT_LOCALE: Locale = 'RU';

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

  if (!(await hasPermission(authenticated.user.roles, 'user.create.admin'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

  if ('role' in bodyObject || 'roles' in bodyObject) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'role/roles cannot be set — this route always creates ADMIN.', fieldErrors: { role: ['not allowed'] } }, requestId);
  }

  const idempotencyKeyHeader = request.headers.get('idempotency-key');
  if (idempotencyKeyHeader === null || !isValidIdempotencyKeyFormat(idempotencyKeyHeader)) {
    return jsonError(
      400,
      { code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required and must be a UUID.' },
      requestId
    );
  }
  const identity: IdempotencyIdentity = {
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

  const respond = async (statusCode: number, body: unknown): Promise<NextResponse> => {
    await completeIdempotentRequest(identity, { statusCode, body });
    return NextResponse.json(body, { status: statusCode, headers: successHeaders(requestId) });
  };

  const { username, email, locale } = bodyObject as { username?: unknown; email?: unknown; locale?: unknown };
  const fieldErrors: Record<string, string[]> = {};

  let normalizedUsername = '';
  if (typeof username !== 'string') {
    fieldErrors.username = ['required'];
  } else {
    normalizedUsername = username.trim().toLowerCase();
    if (!USERNAME_FORMAT.test(normalizedUsername)) {
      fieldErrors.username = ['invalid'];
    }
  }

  let normalizedEmail: string | null = null;
  if (email !== undefined && email !== null) {
    if (typeof email !== 'string') {
      fieldErrors.email = ['invalid'];
    } else {
      normalizedEmail = email.trim().toLowerCase();
      if (normalizedEmail.length === 0) {
        normalizedEmail = null;
      } else if (normalizedEmail.length > MAX_EMAIL_LENGTH || !EMAIL_FORMAT.test(normalizedEmail)) {
        fieldErrors.email = ['invalid'];
      }
    }
  }

  let normalizedLocale: Locale = DEFAULT_LOCALE;
  if (locale !== undefined && locale !== null) {
    if (typeof locale !== 'string' || !VALID_LOCALES.includes(locale as Locale)) {
      fieldErrors.locale = ['invalid'];
    } else {
      normalizedLocale = locale as Locale;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId));
  }

  const result = await createStandaloneAdmin(normalizedUsername, normalizedEmail, normalizedLocale, authenticated.user.id, requestId);

  if ('code' in result) {
    const message = result.code === 'DUPLICATE_USERNAME' ? 'username is already in use.' : 'email is already in use.';
    return respond(409, errorBody({ code: result.code, message }, requestId));
  }

  return respond(201, result);
}
