import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

const cookieName = 'tg_admin_session';
const sessionTtlSeconds = 60 * 60 * 24 * 7;

type SessionPayload = {
  exp: number;
};

type CookieStoreLike = {
  get(name: string): { value: string } | undefined;
};

function toBase64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function getSessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;

  if (!secret) {
    throw new Error('ADMIN_SESSION_SECRET is not set');
  }

  return secret;
}

function createSignature(data: string): string {
  return createHmac('sha256', getSessionSecret()).update(data).digest('base64url');
}

export function createAdminSessionToken(): string {
  const payload: SessionPayload = {
    exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = createSignature(encodedPayload);

  return `${encodedPayload}.${signature}`;
}

function verifyAdminSessionToken(token: string): boolean {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = createSignature(encodedPayload);

  if (
    expectedSignature.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature))
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as SessionPayload;
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function isAdminPasswordValid(password: string): boolean {
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedPassword) {
    throw new Error('ADMIN_PASSWORD is not set');
  }

  // R07-B — constant-time. A plain `password === expectedPassword` short-circuits at the first
  // mismatched byte, leaking the length and a matching prefix through response timing. HMAC both
  // sides with the server secret first, then compare the two fixed-length digests in constant time.
  const key = getSessionSecret();
  const candidate = createHmac('sha256', key).update(password, 'utf8').digest();
  const expected = createHmac('sha256', key).update(expectedPassword, 'utf8').digest();
  return timingSafeEqual(candidate, expected);
}

export function getAdminSessionCookieName(): string {
  return cookieName;
}

export function getAdminSessionCookieOptions() {
  return {
    httpOnly: true,
    // R07-B — `strict`: the admin cookie is never needed on a cross-site navigation into the panel,
    // and `strict` blocks it being sent on any request that did not originate on our own origin.
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: sessionTtlSeconds
  };
}

/** Cookie options for clearing the session (same attributes, maxAge 0). */
export function getAdminSessionClearOptions() {
  return { ...getAdminSessionCookieOptions(), maxAge: 0 };
}

export function isAdminRequestAuthenticated(request: NextRequest): boolean {
  const token = request.cookies.get(cookieName)?.value;
  if (!token) {
    return false;
  }

  return verifyAdminSessionToken(token);
}

export function isAdminCookiesAuthenticated(cookieStore: CookieStoreLike): boolean {
  const token = cookieStore.get(cookieName)?.value;
  if (!token) {
    return false;
  }

  return verifyAdminSessionToken(token);
}
