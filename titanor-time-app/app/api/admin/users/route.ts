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
import { listUsers, createStandaloneForeman, grantForemanToExistingEmployee } from '@/lib/users';
import type { Locale } from '@prisma/client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md — GET/POST /api/admin/users. Only creates or
// grants the FOREMAN role — no UI, no activation issuance (out of scope for this slice).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const ROUTE_TEMPLATE = '/api/admin/users';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Mirrors POST /auth/login's identifier normalization (trim+lowercase) exactly, plus an explicit
// documented format: lowercase ASCII letters, digits, dot, underscore, hyphen, 3-64 chars.
const USERNAME_FORMAT = /^[a-z0-9._-]{3,64}$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 255;
const VALID_LOCALES: Locale[] = ['FI', 'EN', 'RU'];
const DEFAULT_LOCALE: Locale = 'FI';

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authenticated = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!authenticated) {
    return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);
  }

  if (!(await hasPermission(authenticated.user.roles, 'user.read'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const pageSizeParam = Number(searchParams.get('pageSize'));
  const pageSize =
    Number.isInteger(pageSizeParam) && pageSizeParam >= 1 && pageSizeParam <= MAX_PAGE_SIZE ? pageSizeParam : DEFAULT_PAGE_SIZE;
  // Only 'FOREMAN' is a documented filter value — anything else is treated as no filter.
  const roleParam = searchParams.get('role');
  const role = roleParam === 'FOREMAN' ? roleParam : undefined;

  const result = await listUsers({ page, pageSize, role });

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
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

  if (!(await hasPermission(authenticated.user.roles, 'user.create.foreman'))) {
    return jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const bodyObject = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};

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

  // Role is never accepted from the body — this endpoint can only create/grant FOREMAN.
  if ('role' in bodyObject || 'roles' in bodyObject) {
    return respond(
      400,
      errorBody({ code: 'VALIDATION_ERROR', message: 'role/roles cannot be set via this endpoint.', fieldErrors: { role: ['not allowed'] } }, requestId)
    );
  }

  const mode = bodyObject.mode;

  if (mode === 'STANDALONE') {
    if ('employeeId' in bodyObject) {
      return respond(
        400,
        errorBody({ code: 'VALIDATION_ERROR', message: 'employeeId is not allowed in STANDALONE mode.', fieldErrors: { employeeId: ['not allowed'] } }, requestId)
      );
    }

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

    const result = await createStandaloneForeman(normalizedUsername, normalizedEmail, normalizedLocale, authenticated.user.id, requestId);

    if ('code' in result) {
      const message = result.code === 'DUPLICATE_USERNAME' ? 'username is already in use.' : 'email is already in use.';
      return respond(409, errorBody({ code: result.code, message }, requestId));
    }

    return respond(201, result);
  }

  if (mode === 'EXISTING_EMPLOYEE') {
    if ('username' in bodyObject || 'email' in bodyObject || 'locale' in bodyObject) {
      return respond(
        400,
        errorBody(
          { code: 'VALIDATION_ERROR', message: 'username/email/locale are not allowed in EXISTING_EMPLOYEE mode.', fieldErrors: { mode: ['conflicting fields'] } },
          requestId
        )
      );
    }

    const { employeeId } = bodyObject as { employeeId?: unknown };
    if (typeof employeeId !== 'string' || employeeId.length === 0) {
      return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { employeeId: ['required'] } }, requestId));
    }

    const result = await grantForemanToExistingEmployee(employeeId, authenticated.user.id, requestId);

    if ('code' in result) {
      const statusAndMessage: Record<string, { status: number; message: string }> = {
        EMPLOYEE_NOT_FOUND: { status: 404, message: 'Employee not found.' },
        EMPLOYEE_USER_MISSING: { status: 409, message: 'Employee has no linked User.' },
        USER_NOT_ELIGIBLE: { status: 409, message: 'User status does not allow granting FOREMAN.' },
        USER_ALREADY_FOREMAN: { status: 409, message: 'User already has an active FOREMAN role.' }
      };
      const mapped = statusAndMessage[result.code];
      return respond(mapped.status, errorBody({ code: result.code, message: mapped.message }, requestId));
    }

    return respond(201, result);
  }

  return respond(400, errorBody({ code: 'VALIDATION_ERROR', message: 'mode must be STANDALONE or EXISTING_EMPLOYEE.', fieldErrors: { mode: ['invalid'] } }, requestId));
}
