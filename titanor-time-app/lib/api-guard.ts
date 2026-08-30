import { jsonError } from '@/lib/api-error';
import type { NextResponse } from 'next/server';

// R07-A — shared API-route guards.

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
