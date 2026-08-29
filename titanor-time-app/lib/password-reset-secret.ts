let cachedKey: Buffer | null = null;

/** Separate HMAC key for recovery links. It must never be shared with activation tokens. */
export function passwordResetTokenHmacKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.PASSWORD_RESET_TOKEN_HMAC_KEY;
  if (!raw) throw new Error('PASSWORD_RESET_TOKEN_HMAC_KEY is not set.');

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new Error('PASSWORD_RESET_TOKEN_HMAC_KEY must be canonical base64 encoding of exactly 32 bytes.');
  }
  cachedKey = key;
  return key;
}
