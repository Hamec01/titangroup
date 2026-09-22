import { createHmac, timingSafeEqual } from 'node:crypto';

// UT5-B — stateless confirmation token binding one approval-preview response to the exact commit
// that may follow it. Deliberately NOT the opaque-random-token-plus-DB-row shape every other secret
// in this codebase uses (lib/session.ts, lib/activation-secret.ts, lib/password-reset-secret.ts) —
// none of those carry a self-contained payload, and UT5-A-R1's research confirmed no existing
// primitive does what's needed here: a short-TTL, HMAC-signed payload verifiable with zero DB
// round-trip and zero process-local state, so it stays correct across multiple app instances and a
// restart. Same "32-byte canonical base64 secret, memoized, never shared with another key" shape as
// activation-secret.ts, just with CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY as its own env var.
//
// The token proves only "this actor was shown this exact preview, for this exact item and
// fingerprint, recently" — it is never a substitute for the commit transaction's own fresh
// canonical-source re-read and fingerprint recheck (UT5-A §3 / UT5-A-R1's explicit requirement).

const TOKEN_VERSION = 1 as const;
export const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes, owner-confirmed (UT5-A-R1 §8)
// Generous upper bound on a token's OWN claimed lifetime (issuedAt..expiresAt) — a well-formed
// token issued by this module never exceeds CONFIRMATION_TOKEN_TTL_MS, so anything meaningfully
// larger is treated as malformed rather than trusted, even though the signature already guarantees
// the payload came from this server (defense in depth against a future signing bug, not a
// substitute for the signature check).
const MAX_TOKEN_LIFETIME_MS = 10 * 60 * 1000;
// A real payload here is a few hundred bytes of JSON; base64url adds ~33%. 4096 is a generous
// ceiling that still rejects a deliberately oversized string before any JSON.parse is attempted.
const MAX_TOKEN_LENGTH = 4096;

export interface ConfirmationItemKey {
  timesheetId: string;
  siteId: string;
  workAreaId: string | null;
  weekStart: string; // YYYY-MM-DD
}

export interface ConfirmationTokenPayloadV1 {
  v: 1;
  actorUserId: string;
  employeeId: string; // server-resolved employeeId for the item's timesheet, not client input
  itemKey: ConfirmationItemKey;
  expectedFingerprint: string;
  issuedAt: number; // ms epoch
  expiresAt: number; // ms epoch
}

let cachedKey: Buffer | null = null;

/** Read lazily — build/typecheck must never require a real production secret, only sign()/verify()
 *  calls do, matching lib/idempotency.ts's own encryptionKey()/activation-secret.ts's own pattern. */
function confirmationTokenHmacKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY;
  if (!raw) {
    throw new Error('CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY is not set.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new Error('CUSTOMER_HOURS_CONFIRMATION_TOKEN_HMAC_KEY must be canonical base64 encoding of exactly 32 bytes.');
  }
  cachedKey = key;
  return key;
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(payloadB64: string): string {
  return createHmac('sha256', confirmationTokenHmacKey()).update(payloadB64).digest('base64url');
}

export function signConfirmationToken(input: { actorUserId: string; employeeId: string; itemKey: ConfirmationItemKey; expectedFingerprint: string; now?: Date }): { token: string; expiresAt: string } {
  const now = input.now ?? new Date();
  const issuedAt = now.getTime();
  const expiresAt = issuedAt + CONFIRMATION_TOKEN_TTL_MS;
  const payload: ConfirmationTokenPayloadV1 = {
    v: TOKEN_VERSION,
    actorUserId: input.actorUserId,
    employeeId: input.employeeId,
    itemKey: input.itemKey,
    expectedFingerprint: input.expectedFingerprint,
    issuedAt,
    expiresAt
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signature = sign(payloadB64);
  return { token: `${payloadB64}.${signature}`, expiresAt: new Date(expiresAt).toISOString() };
}

export type VerifyConfirmationTokenResult =
  | { ok: true; payload: ConfirmationTokenPayloadV1 }
  | { ok: false; reason: 'EXPIRED' }
  | { ok: false; reason: 'INVALID'; detail: 'MALFORMED' | 'TOO_LARGE' | 'BAD_SIGNATURE' | 'BAD_SHAPE' };

function isPlainString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isItemKeyShape(v: unknown): v is ConfirmationItemKey {
  if (v === null || typeof v !== 'object') return false;
  const k = v as Record<string, unknown>;
  return isPlainString(k.timesheetId) && isPlainString(k.siteId) && (k.workAreaId === null || isPlainString(k.workAreaId)) && isPlainString(k.weekStart);
}
function isPayloadShape(v: unknown): v is ConfirmationTokenPayloadV1 {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    p.v === TOKEN_VERSION &&
    isPlainString(p.actorUserId) &&
    isPlainString(p.employeeId) &&
    isItemKeyShape(p.itemKey) &&
    isPlainString(p.expectedFingerprint) &&
    /^[0-9a-f]{64}$/.test(p.expectedFingerprint as string) &&
    typeof p.issuedAt === 'number' &&
    Number.isFinite(p.issuedAt) &&
    typeof p.expiresAt === 'number' &&
    Number.isFinite(p.expiresAt)
  );
}

/** Pure crypto/shape verification only — never compares the payload against "the current request's"
 *  actor/itemKey/fingerprint. That contextual binding is the caller's job (the route handler knows
 *  the session's real actor and the request body it just parsed) — keeping it out of this function
 *  makes the token module testable in isolation and keeps "is this token real" separate from "does
 *  it apply to this request". Every failure path returns a typed result; this function never throws
 *  for a malformed/tampered/oversized input — a 500 on bad client input is exactly what UT5-A-R1
 *  ruled out. */
export function verifyConfirmationToken(token: string, now: Date = new Date()): VerifyConfirmationTokenResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'INVALID', detail: 'TOO_LARGE' };
  }

  const dotIndex = token.indexOf('.');
  if (dotIndex <= 0 || dotIndex === token.length - 1 || token.indexOf('.', dotIndex + 1) !== -1) {
    return { ok: false, reason: 'INVALID', detail: 'MALFORMED' };
  }
  const payloadB64 = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  let expectedSignature: string;
  try {
    expectedSignature = sign(payloadB64);
  } catch {
    // Secret missing/malformed at verify time — a server config problem, not a client error, but
    // still must never throw into a 500 from inside a route handler; treated as an unverifiable
    // (invalid) token, and the route's own startup/health checks are where a missing secret should
    // actually surface.
    return { ok: false, reason: 'INVALID', detail: 'MALFORMED' };
  }

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SIGNATURE' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'INVALID', detail: 'MALFORMED' };
  }

  if (!isPayloadShape(decoded)) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SHAPE' };
  }
  const payload = decoded;
  if (payload.expiresAt < payload.issuedAt || payload.expiresAt - payload.issuedAt > MAX_TOKEN_LIFETIME_MS) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SHAPE' };
  }
  // UT5-B-fixup #2 — a well-formed token this module issued always has issuedAt <= now at the
  // moment it was signed; one claiming to have been issued in the future is either a forged payload
  // (the signature already rules that out) or a genuinely nonsensical clock value, either way never
  // something to honor rather than an expiry check alone would catch.
  if (payload.issuedAt > now.getTime()) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SHAPE' };
  }
  if (now.getTime() >= payload.expiresAt) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return { ok: true, payload };
}

export function confirmationItemKeyEquals(a: ConfirmationItemKey, b: ConfirmationItemKey): boolean {
  return a.timesheetId === b.timesheetId && a.siteId === b.siteId && a.workAreaId === b.workAreaId && a.weekStart === b.weekStart;
}
