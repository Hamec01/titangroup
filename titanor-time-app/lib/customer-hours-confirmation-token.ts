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
// The token proves only "this actor was shown this exact preview, for this exact item/selection and
// fingerprint(s), recently" — it is never a substitute for the commit transaction's own fresh
// canonical-source re-read and fingerprint recheck (UT5-A §3 / UT5-A-R1's explicit requirement).
//
// UT6-B — a second token kind for mass approval (UT6-A-R1 §3/§10): a selection can hold up to 200
// items, far too large to embed item-by-item inside a token still bounded by MAX_TOKEN_LENGTH, so
// the mass payload carries only a `selectionHash` (a sha256 of the canonically-sorted selection,
// lib/reporting/weekly-approval.ts's computeSelectionHash) plus itemCount, never the items
// themselves. Both kinds share the same low-level sign/verify/temporal-validity mechanics
// (signRaw/verifyRaw/checkTemporalValidity below) so neither formula is duplicated; each kind keeps
// its own payload shape guard and its own `kind` discriminant so a single-item token can never be
// accepted in place of a mass one or vice versa, even though they share one HMAC secret (the same
// trust domain: "this actor was shown a real approval preview recently").

const TOKEN_VERSION = 1 as const;
export const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes, owner-confirmed (UT5-A-R1 §8)
// Generous upper bound on a token's OWN claimed lifetime (issuedAt..expiresAt) — a well-formed
// token issued by this module never exceeds CONFIRMATION_TOKEN_TTL_MS, so anything meaningfully
// larger is treated as malformed rather than trusted, even though the signature already guarantees
// the payload came from this server (defense in depth against a future signing bug, not a
// substitute for the signature check).
const MAX_TOKEN_LIFETIME_MS = 10 * 60 * 1000;
// A real payload here is at most a few hundred bytes of JSON (the mass payload is far smaller, since
// it never embeds the selection itself — see the header comment); base64url adds ~33%. 4096 is a
// generous ceiling that still rejects a deliberately oversized string before any JSON.parse is
// attempted. UT6-A-R1 §3/§10 — kept unchanged, never raised for the mass token.
const MAX_TOKEN_LENGTH = 4096;

export interface ConfirmationItemKey {
  timesheetId: string;
  siteId: string;
  workAreaId: string | null;
  weekStart: string; // YYYY-MM-DD
}

export interface ConfirmationTokenPayloadV1 {
  v: 1;
  kind: 'SINGLE';
  actorUserId: string;
  employeeId: string; // server-resolved employeeId for the item's timesheet, not client input
  itemKey: ConfirmationItemKey;
  expectedFingerprint: string;
  issuedAt: number; // ms epoch
  expiresAt: number; // ms epoch
}

export interface MassConfirmationTokenPayloadV1 {
  v: 1;
  kind: 'MASS';
  actorUserId: string;
  selectionHash: string; // sha256 hex of the canonically-sorted selection (weekly-approval.ts)
  itemCount: number;
  issuedAt: number;
  expiresAt: number;
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

// =================================================================================================
// Shared low-level mechanics (UT6-B) — base64url(JSON payload).base64url(HMAC), timing-safe
// signature comparison, and the issuedAt/expiresAt bounds check. Neither token kind reimplements
// these; each kind only supplies its own payload TYPE and shape guard.
// =================================================================================================

function signRaw(payload: unknown): string {
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

type RawVerifyResult = { ok: true; decoded: unknown } | { ok: false; reason: 'INVALID'; detail: 'MALFORMED' | 'TOO_LARGE' | 'BAD_SIGNATURE' };

/** Pure crypto/shape-agnostic verification: length, dot-shape, signature, JSON parse. Never throws
 *  for a malformed/tampered/oversized input — a 500 on bad client input is exactly what UT5-A-R1
 *  ruled out. Says nothing about which token KIND this is or whether its fields make sense — that is
 *  each kind's own isXPayloadShape() below. */
function verifyRaw(token: string): RawVerifyResult {
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
  return { ok: true, decoded };
}

type TemporalCheck = { ok: true } | { ok: false; reason: 'EXPIRED' } | { ok: false; reason: 'INVALID'; detail: 'BAD_SHAPE' };

/** issuedAt/expiresAt bounds shared by both kinds — UT5-B-fixup #2's future-issuedAt rejection
 *  applies identically to a mass token, not re-derived per kind. */
function checkTemporalValidity(payload: { issuedAt: number; expiresAt: number }, now: Date): TemporalCheck {
  if (payload.expiresAt < payload.issuedAt || payload.expiresAt - payload.issuedAt > MAX_TOKEN_LIFETIME_MS) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SHAPE' };
  }
  // A well-formed token this module issued always has issuedAt <= the moment it was signed; one
  // claiming to have been issued in the future is either a forged payload (the signature already
  // rules that out) or a genuinely nonsensical clock value — never honored.
  if (payload.issuedAt > now.getTime()) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SHAPE' };
  }
  if (now.getTime() >= payload.expiresAt) {
    return { ok: false, reason: 'EXPIRED' };
  }
  return { ok: true };
}

function isPlainString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isItemKeyShape(v: unknown): v is ConfirmationItemKey {
  if (v === null || typeof v !== 'object') return false;
  const k = v as Record<string, unknown>;
  return isPlainString(k.timesheetId) && isPlainString(k.siteId) && (k.workAreaId === null || isPlainString(k.workAreaId)) && isPlainString(k.weekStart);
}

// =================================================================================================
// Single-item token (UT5-B).
// =================================================================================================

function isSinglePayloadShape(v: unknown): v is ConfirmationTokenPayloadV1 {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    p.v === TOKEN_VERSION &&
    p.kind === 'SINGLE' &&
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

export function signConfirmationToken(input: { actorUserId: string; employeeId: string; itemKey: ConfirmationItemKey; expectedFingerprint: string; now?: Date }): { token: string; expiresAt: string } {
  const now = input.now ?? new Date();
  const issuedAt = now.getTime();
  const expiresAt = issuedAt + CONFIRMATION_TOKEN_TTL_MS;
  const payload: ConfirmationTokenPayloadV1 = {
    v: TOKEN_VERSION,
    kind: 'SINGLE',
    actorUserId: input.actorUserId,
    employeeId: input.employeeId,
    itemKey: input.itemKey,
    expectedFingerprint: input.expectedFingerprint,
    issuedAt,
    expiresAt
  };
  return { token: signRaw(payload), expiresAt: new Date(expiresAt).toISOString() };
}

export type VerifyConfirmationTokenResult =
  | { ok: true; payload: ConfirmationTokenPayloadV1 }
  | { ok: false; reason: 'EXPIRED' }
  | { ok: false; reason: 'INVALID'; detail: 'MALFORMED' | 'TOO_LARGE' | 'BAD_SIGNATURE' | 'BAD_SHAPE' };

/** Pure crypto/shape verification only — never compares the payload against "the current request's"
 *  actor/itemKey/fingerprint. That contextual binding is the caller's job (the route handler knows
 *  the session's real actor and the request body it just parsed) — keeping it out of this function
 *  makes the token module testable in isolation and keeps "is this token real" separate from "does
 *  it apply to this request". */
export function verifyConfirmationToken(token: string, now: Date = new Date()): VerifyConfirmationTokenResult {
  const raw = verifyRaw(token);
  if (!raw.ok) return raw;
  if (!isSinglePayloadShape(raw.decoded)) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SHAPE' };
  }
  const payload = raw.decoded;
  const temporal = checkTemporalValidity(payload, now);
  if (!temporal.ok) return temporal;
  return { ok: true, payload };
}

export function confirmationItemKeyEquals(a: ConfirmationItemKey, b: ConfirmationItemKey): boolean {
  return a.timesheetId === b.timesheetId && a.siteId === b.siteId && a.workAreaId === b.workAreaId && a.weekStart === b.weekStart;
}

// =================================================================================================
// Mass-selection token (UT6-B, UT6-A-R1 §3/§10). Never embeds the selection itself — only its hash
// — so it stays a small, constant-size payload regardless of how many items (up to
// MAX_MASS_SELECTION_ITEMS, weekly-approval.ts) were selected.
// =================================================================================================

function isMassPayloadShape(v: unknown): v is MassConfirmationTokenPayloadV1 {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    p.v === TOKEN_VERSION &&
    p.kind === 'MASS' &&
    isPlainString(p.actorUserId) &&
    isPlainString(p.selectionHash) &&
    /^[0-9a-f]{64}$/.test(p.selectionHash as string) &&
    typeof p.itemCount === 'number' &&
    Number.isInteger(p.itemCount) &&
    p.itemCount > 0 &&
    typeof p.issuedAt === 'number' &&
    Number.isFinite(p.issuedAt) &&
    typeof p.expiresAt === 'number' &&
    Number.isFinite(p.expiresAt)
  );
}

export function signMassConfirmationToken(input: { actorUserId: string; selectionHash: string; itemCount: number; now?: Date }): { token: string; expiresAt: string } {
  const now = input.now ?? new Date();
  const issuedAt = now.getTime();
  const expiresAt = issuedAt + CONFIRMATION_TOKEN_TTL_MS;
  const payload: MassConfirmationTokenPayloadV1 = {
    v: TOKEN_VERSION,
    kind: 'MASS',
    actorUserId: input.actorUserId,
    selectionHash: input.selectionHash,
    itemCount: input.itemCount,
    issuedAt,
    expiresAt
  };
  return { token: signRaw(payload), expiresAt: new Date(expiresAt).toISOString() };
}

export type VerifyMassConfirmationTokenResult =
  | { ok: true; payload: MassConfirmationTokenPayloadV1 }
  | { ok: false; reason: 'EXPIRED' }
  | { ok: false; reason: 'INVALID'; detail: 'MALFORMED' | 'TOO_LARGE' | 'BAD_SIGNATURE' | 'BAD_SHAPE' };

/** Same contract as verifyConfirmationToken: pure crypto/shape check only. The caller (the mass
 *  commit route) recomputes selectionHash from ITS OWN freshly-validated request body and compares
 *  it to payload.selectionHash itself — this function never sees the selection. */
export function verifyMassConfirmationToken(token: string, now: Date = new Date()): VerifyMassConfirmationTokenResult {
  const raw = verifyRaw(token);
  if (!raw.ok) return raw;
  if (!isMassPayloadShape(raw.decoded)) {
    return { ok: false, reason: 'INVALID', detail: 'BAD_SHAPE' };
  }
  const payload = raw.decoded;
  const temporal = checkTemporalValidity(payload, now);
  if (!temporal.ok) return temporal;
  return { ok: true, payload };
}
