import { createHash, randomBytes } from 'node:crypto';

// Exact cookie name from docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §0.
export const SESSION_COOKIE_NAME = 'tt_session';

// Not specified by any architecture doc as of this task — a reasonable
// default for an internal work-hours app where forcing re-login on a
// worker's phone in the field is real friction. Unlike the cookie name or
// the token-hashing scheme (both fixed contracts), this is a tunable value;
// flagged here as an assumption pending owner confirmation, not a spec.
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Opaque, high-entropy session token — the raw value only ever goes into the cookie, never the database. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256(token), hex-encoded — this is what's stored in UserSession.tokenHash, per 03_DATA_MODEL_ERD.md §4.1. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
