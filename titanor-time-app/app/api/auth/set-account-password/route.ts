import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders, type ApiErrorBody } from '@/lib/api-error';
import { checkRateLimit } from '@/lib/rate-limit';
import { setAccountPassword } from '@/lib/system-activation';
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md — POST /api/auth/set-account-password.
// Standalone-FOREMAN counterpart to POST /api/auth/set-initial-password — same CSRF/rate-limit/
// cookie pattern, separate rate-limit namespace, and only ever touches UserActivationToken/a
// User(employeeId IS NULL), never ActivationToken or worker eligibility.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const MAX_PASSWORD_LENGTH = 256;
const IP_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

function errorBody(body: ApiErrorBody, requestId: string): { error: ApiErrorBody & { requestId: string } } {
  return { error: { ...body, requestId } };
}

function clientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const first = forwardedFor?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const ip = clientIp(request);
  if (!checkRateLimit(`set-account-password-ip:${ip ?? 'unknown'}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs)) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const { token, password } = (body && typeof body === 'object' ? body : {}) as { token?: unknown; password?: unknown };

  const fieldErrors: Record<string, string[]> = {};
  if (typeof token !== 'string' || token.trim().length === 0) {
    fieldErrors.token = ['required'];
  }
  if (typeof password !== 'string' || password.length === 0) {
    fieldErrors.password = ['required'];
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    fieldErrors.password = ['too long'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors }, requestId), {
      status: 400,
      headers: successHeaders(requestId)
    });
  }

  const userAgent = request.headers.get('user-agent');
  const result = await setAccountPassword(token as string, password as string, requestId, ip, userAgent);

  if ('code' in result) {
    switch (result.code) {
      case 'TOKEN_EXPIRED':
        return jsonError(410, { code: 'TOKEN_EXPIRED', message: 'This activation code has expired.' }, requestId);
      case 'TOKEN_USED':
        return jsonError(410, { code: 'TOKEN_USED', message: 'This activation code has already been used.' }, requestId);
      case 'TOKEN_INVALID':
        return jsonError(404, { code: 'TOKEN_INVALID', message: 'This activation code is not valid.' }, requestId);
      case 'ACCOUNT_NOT_ELIGIBLE':
        return jsonError(409, { code: 'ACCOUNT_NOT_ELIGIBLE', message: 'This account is no longer eligible for activation.' }, requestId);
      case 'VALIDATION_ERROR':
        return NextResponse.json(errorBody({ code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: result.fieldErrors }, requestId), {
          status: 400,
          headers: successHeaders(requestId)
        });
    }
  }

  // Cookie is only ever set here, after setAccountPassword's transaction has already committed
  // successfully — no earlier code path in this handler touches response cookies.
  const response = NextResponse.json(
    { user: { id: result.user.id, username: result.user.username, roles: result.user.roles, locale: result.user.locale } },
    { status: 200, headers: successHeaders(requestId) }
  );

  response.cookies.set(SESSION_COOKIE_NAME, result.sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_DURATION_MS / 1000)
  });

  return response;
}
