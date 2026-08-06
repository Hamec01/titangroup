import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { jsonError, successHeaders } from '@/lib/api-error';
import { checkRateLimit } from '@/lib/rate-limit';
import { verifyActivationToken } from '@/lib/activation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §1 — GET /api/auth/activate?token=...
// Public, no CSRF check (a GET, per the shared convention CSRF only guards mutating requests).
// Rate limited by IP — the contract doesn't give an exact number for this endpoint (unlike
// login's explicitly-confirmed 5/15min+50/15min), so a pragmatic bound is used here: bounded by
// the same 72h token lifetime as the code itself is, not tied to any per-token counter.
const IP_RATE_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

function clientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const first = forwardedFor?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const ip = clientIp(request);
  if (!checkRateLimit(`activate-ip:${ip ?? 'unknown'}`, IP_RATE_LIMIT.limit, IP_RATE_LIMIT.windowMs)) {
    return jsonError(429, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' }, requestId);
  }

  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  if (typeof token !== 'string' || token.trim().length === 0) {
    return jsonError(404, { code: 'TOKEN_INVALID', message: 'No token provided.' }, requestId);
  }

  const result = await verifyActivationToken(token);

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
