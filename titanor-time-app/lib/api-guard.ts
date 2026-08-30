import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { jsonError } from '@/lib/api-error';
import { resolveAuthenticatedSession, type AuthenticatedSession } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { SESSION_COOKIE_NAME } from '@/lib/session';

// R07-A — shared API-route guards.

// The custom header every mutating client request must carry (a value no cross-site form or
// simple request can set), checked on every mutating route.
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'titanor-time';

export interface GuardOptions {
  /** Reject the request (403 CSRF_REJECTED) unless it carries the X-Requested-With header. */
  csrf?: boolean;
  /** Require the session's roles to grant ALL of these permission codes (403 FORBIDDEN otherwise). */
  permission?: string | readonly string[];
  /** Require the session's roles to grant AT LEAST ONE of these (403 FORBIDDEN otherwise). */
  anyPermission?: readonly string[];
}

export type GuardResult =
  | { ok: true; session: AuthenticatedSession; requestId: string }
  | { ok: false; response: NextResponse };

/**
 * The one place the repeated per-route auth block lives: fresh request id → optional CSRF header
 * check → authenticated session (401 NOT_AUTHENTICATED) → optional permission check(s)
 * (403 FORBIDDEN). Route-specific checks (ownership, NO_EMPLOYEE_PROFILE, domain state) stay in the
 * route, after `const { session, requestId } = guard`. The response envelopes / codes / messages
 * are byte-identical to what every route emitted inline before R07-A.
 */
export async function guardApiRequest(request: NextRequest, opts: GuardOptions = {}): Promise<GuardResult> {
  const requestId = randomUUID();

  if (opts.csrf && request.headers.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return { ok: false, response: jsonError(403, { code: 'CSRF_REJECTED', message: 'Missing or invalid X-Requested-With header.' }, requestId) };
  }

  const session = await resolveAuthenticatedSession(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!session) {
    return { ok: false, response: jsonError(401, { code: 'NOT_AUTHENTICATED', message: 'No active session.' }, requestId) };
  }

  if (opts.permission !== undefined) {
    const codes = typeof opts.permission === 'string' ? [opts.permission] : opts.permission;
    for (const code of codes) {
      if (!(await hasPermission(session.user.roles, code))) {
        return { ok: false, response: jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId) };
      }
    }
  }

  if (opts.anyPermission && opts.anyPermission.length > 0) {
    const granted = await Promise.all(opts.anyPermission.map((code) => hasPermission(session.user.roles, code)));
    if (!granted.some(Boolean)) {
      return { ok: false, response: jsonError(403, { code: 'FORBIDDEN', message: 'Missing required permission.' }, requestId) };
    }
  }

  return { ok: true, session, requestId };
}

// Any hex in the 8-4-4-4-12 shape — exactly what a Postgres `::uuid` cast accepts, regardless of
// RFC version/variant bits. Being lenient here (vs a strict v4 pattern) avoids a false 404 for a
// well-formed non-v4 id while still stopping the malformed values that make Prisma throw P2023.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Guards a route's `[id]` path parameter. Returns a 404 `NextResponse` (using the caller's own
 * not-found `code`/`message`, so a malformed id is indistinguishable from a valid-but-missing one)
 * when `value` is not a UUID, or `null` when it is fine — the caller does `const bad =
 * requireUuidParam(...); if (bad) return bad;` before any Prisma call, so P2023 / HTTP 500 on
 * garbage input is impossible.
 */
export function requireUuidParam(
  value: string,
  notFound: { code: string; message: string },
  requestId: string
): NextResponse | null {
  return isUuid(value) ? null : jsonError(404, notFound, requestId);
}
