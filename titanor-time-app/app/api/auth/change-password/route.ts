import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { resolveAuthenticatedSession } from '@/lib/auth';
import { SESSION_COOKIE_NAME } from '@/lib/session';
import { changeAccountPassword, MAX_PASSWORD_LENGTH } from '@/lib/account';
import { checkRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// R03 — POST /api/auth/change-password. Self-service password change by the current password
// (TZ §6.1). Keeps this session; every other session is revoked.
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const IP_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

function clientIp(request: NextRequest): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  const session = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId);

  if (!checkRateLimit(`change-password-ip:${clientIp(request) ?? 'unknown'}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs)) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  if (
    typeof body.currentPassword !== 'string' || body.currentPassword.length === 0 || body.currentPassword.length > MAX_PASSWORD_LENGTH ||
    typeof body.newPassword !== 'string'
  ) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.', fieldErrors: { currentPassword: ['required'] } }, requestId);
  }

  const result = await changeAccountPassword({
    userId: session.user.id,
    currentSessionId: session.sessionId,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    requestId
  });

  if (!result.ok) {
    switch (result.code) {
      case 'INVALID_CURRENT_PASSWORD':
        return jsonError(400, { code: result.code, message: 'The current password is incorrect.' }, requestId);
      case 'SAME_AS_CURRENT':
        return jsonError(400, { code: result.code, message: 'Choose a password different from the current one.', fieldErrors: { newPassword: ['same as current'] } }, requestId);
      case 'VALIDATION_ERROR':
        return jsonError(400, { code: result.code, message: 'Choose a password of at least 8 characters.', fieldErrors: { newPassword: ['too short'] } }, requestId);
      case 'ACCOUNT_NOT_ELIGIBLE':
        return jsonError(403, { code: result.code, message: 'This account cannot change its password here.' }, requestId);
    }
  }

  return new NextResponse(null, { status: 204, headers: successHeaders(requestId) });
}
