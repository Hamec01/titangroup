import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { redeemPasswordReset } from '@/lib/password-reset';
import { checkRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
  const ip = clientIp(request);
  if (!checkRateLimit(`password-reset-confirm-ip:${ip ?? 'unknown'}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs)) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, requestId);
  }
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' }, requestId);
  }
  const body = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  if (typeof body.token !== 'string' || body.token.length === 0 || body.token.length > 512 || typeof body.password !== 'string') {
    return jsonError(400, { code: 'VALIDATION_ERROR', message: 'Invalid request body.' }, requestId);
  }

  const result = await redeemPasswordReset({ token: body.token, password: body.password, requestId, ipAddress: ip, userAgent: request.headers.get('user-agent') });
  if (!result.ok) {
    const status = result.code === 'TOKEN_EXPIRED' || result.code === 'TOKEN_USED' ? 410 : result.code === 'ACCOUNT_NOT_ELIGIBLE' ? 409 : 400;
    return jsonError(status, { code: result.code, message: 'Password reset link is invalid or can no longer be used.' }, requestId);
  }

  return NextResponse.json({ user: result.user }, { status: 200, headers: successHeaders(requestId) });
}
