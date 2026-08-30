import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { checkRateLimit } from '@/lib/rate-limit';
import { clientRateLimitKey } from '@/lib/client-ip';
import { verifySystemActivationToken } from '@/lib/system-activation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md — GET /api/auth/activate-account?token=...
// Public, no CSRF (a GET). Standalone-FOREMAN counterpart to GET /api/auth/activate — separate
// rate-limit namespace so the two never share a bucket, and only ever looks at
// UserActivationToken, never ActivationToken.
const IP_RATE_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  if (!(await checkRateLimit(`activate-account-ip:${clientRateLimitKey(request)}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs))) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  if (typeof token !== 'string' || token.trim().length === 0) {
    return jsonError(404, { code: 'TOKEN_INVALID', message: 'No token provided.' }, requestId);
  }

  const result = await verifySystemActivationToken(token);

  if ('code' in result) {
    switch (result.code) {
      case 'TOKEN_EXPIRED':
        return jsonError(410, { code: 'TOKEN_EXPIRED', message: 'This activation code has expired.' }, requestId);
      case 'TOKEN_USED':
        return jsonError(410, { code: 'TOKEN_USED', message: 'This activation code has already been used.' }, requestId);
      case 'TOKEN_INVALID':
        return jsonError(404, { code: 'TOKEN_INVALID', message: 'This activation code is not valid.' }, requestId);
    }
  }

  return NextResponse.json(result, { status: 200, headers: successHeaders(requestId) });
}
