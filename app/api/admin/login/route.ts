import { NextResponse } from 'next/server';
import {
  createAdminSessionToken,
  getAdminSessionCookieName,
  getAdminSessionCookieOptions,
  isAdminPasswordValid
} from '../../../../lib/admin-auth';
import { checkRateLimit } from '../../../../lib/rate-limit';
import { clientRateLimitKey, resolveClientIp } from '../../../../lib/client-ip';
import { recordAdminLogin } from '../../../../lib/admin-audit';
import { rejectIfCsrfMissing } from '../../../../lib/csrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// R07-B — 10 attempts / 15 min per client IP. Fixed window; a restart clears it (acceptable for a
// one-instance low-traffic site). IP is resolved from the trusted X-Forwarded-For position.
const RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

export async function POST(request: Request) {
  const csrf = rejectIfCsrfMissing(request);
  if (csrf) return csrf;

  const ip = resolveClientIp(request).ip;
  const userAgent = request.headers.get('user-agent');

  if (!checkRateLimit(`admin-login-ip:${clientRateLimitKey(request)}`, RATE_LIMIT.limit, RATE_LIMIT.windowMs).allowed) {
    await recordAdminLogin('rate_limited', { ip, userAgent });
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  let password = '';
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body?.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!password || !isAdminPasswordValid(password)) {
    await recordAdminLogin('failure', { ip, userAgent });
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  await recordAdminLogin('success', { ip, userAgent });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(getAdminSessionCookieName(), createAdminSessionToken(), getAdminSessionCookieOptions());
  return response;
}
