import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Worker Dossier feature (2026-08-26) — generic field-level encryption for sensitive personal
// data (Finnish henkilötunnus today; any future single-value sensitive profile field can reuse
// this). Same AES-256-GCM shape as lib/idempotency.ts's encryptResponseBody/decryptResponseBody
// (iv || authTag || ciphertext, 32-byte base64 key), generalized into its own module rather than
// reused in place: idempotency.ts's functions are private, JSON-body-shaped, and keyed on a
// different secret (IDEMPOTENCY_ENCRYPTION_KEY) — deliberately not the same key as this module's
// PERSONAL_DATA_ENCRYPTION_KEY, so rotating/compromising one never affects the other.

const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;

export class PersonalDataEncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonalDataEncryptionConfigError';
  }
}

function encryptionKey(): Buffer {
  const raw = process.env.PERSONAL_DATA_ENCRYPTION_KEY;
  if (!raw) {
    throw new PersonalDataEncryptionConfigError('PERSONAL_DATA_ENCRYPTION_KEY is not set.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new PersonalDataEncryptionConfigError('PERSONAL_DATA_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).');
  }
  return key;
}

/** Encrypts a single plaintext string, returned as a base64 string (iv || authTag || ciphertext) — a plain TEXT-column-friendly encoding, unlike idempotency.ts's raw Bytes column. */
export function encryptPersonalData(plaintext: string): string {
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Inverse of encryptPersonalData. Throws (never returns a partially-decrypted or empty fallback) on a tampered/corrupt value — GCM's auth tag check makes this a hard failure, not a silent one. */
export function decryptPersonalData(stored: string): string {
  const buffer = Buffer.from(stored, 'base64');
  const iv = buffer.subarray(0, GCM_IV_LENGTH);
  const authTag = buffer.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
