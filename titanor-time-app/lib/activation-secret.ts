// docs/titanor-time/03_DATA_MODEL_ERD.md §4.1 "ActivationToken" — owner-confirmed choice of
// keyed HMAC-SHA256 (not Argon2id) for tokenHash, specifically so GET /api/auth/activate can find
// the row by a single deterministic equality lookup on the code the user typed/scanned. Same
// "secret held outside the DB, base64, exactly 32 bytes" shape as IDEMPOTENCY_ENCRYPTION_KEY
// (lib/idempotency.ts) — a separate key, never logged, never committed.

let cachedKey: Buffer | null = null;

export function activationTokenHmacKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const raw = process.env.ACTIVATION_TOKEN_HMAC_KEY;
  if (!raw) {
    throw new Error('ACTIVATION_TOKEN_HMAC_KEY is not set.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new Error('ACTIVATION_TOKEN_HMAC_KEY must be canonical base64 encoding of exactly 32 bytes.');
  }
  cachedKey = key;
  return key;
}
