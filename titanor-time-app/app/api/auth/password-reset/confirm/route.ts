import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { redeemAccountRecovery } from '@/lib/account-recovery';
import { checkRateLimit } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// R03 — POST /api/auth/password-reset/confirm. The user submits their own login + the one-time
// code the admin gave them + a new password. No SMTP anywhere in this flow. Every non-policy
// failure is the same 400 with an identical message so the endpoint cannot be used to probe which
// logins exist or which have an outstanding code (TZ §7.2).
const REQUIRED_CSRF_HEADER_VALUE = 'titanor-time';
const IP_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
const LOGIN_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (request.headers.get('x-requested-with') !== REQUIRED_CSRF_HEADER_VALUE) {
    return jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  if (
    typeof body.login !== 'string' || body.login.trim().length === 0 || body.login.length > 320 ||
    typeof body.code !== 'string' || body.code.length === 0 || body.code.length > 64 ||
    typeof body.password !== 'string'
  ) {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, requestId);
  }

  const ip = clientIp(request);
  const loginKey = body.login.trim().toLowerCase();
  const [ipAllowed, loginAllowed] = await Promise.all([
    checkRateLimit(`recovery-confirm-ip:${ip ?? 'unknown'}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs),
    checkRateLimit(`recovery-confirm-login:${loginKey}`, LOGIN_RATE_LIMIT.limit, LOGIN_RATE_LIMIT.windowMs)
  ]);
  if (!ipAllowed || !loginAllowed) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, requestId);
  }

  const result = await redeemAccountRecovery({
    login: body.login,
    code: body.code,
    password: body.password,
    requestId,
    ipAddress: ip,
    userAgent: request.headers.get('user-agent')
  });

  if (!result.ok) {
    if (result.code === 'VALIDATION_ERROR') {
      return jsonError(
        400,
        { code: 'VALIDATION_ERROR', message: 'Choose a password of at least 8 characters.', fieldErrors: { password: ['too short'] } },
        requestId
      );
    }
    // INVALID and EXPIRED collapse to one caller-facing answer.
    return jsonError(400, { code: 'RECOVERY_INVALID', message: 'This login and code do not match an active recovery request.' }, requestId);
  }

  return NextResponse.json({ user: result.user }, { status: 200, headers: successHeaders(requestId) });
}
