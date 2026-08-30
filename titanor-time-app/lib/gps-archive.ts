import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

// R08 — GPS encrypted archive (docs/titanor-time/R08_GPS_ARCHIVE_REPORT_RU.md, TZ §9).
//
// This module is pure: it turns a day's raw GPS records into one encrypted, compressed blob and
// back, and nothing else. No database, no filesystem. The DB-aware selection/ledger live in
// lib/gps-archive-run.ts; the runner that writes files lives in scripts/run-gps-archive.ts.
//
// Key: GPS_ARCHIVE_ENCRYPTION_KEY — a *separate* base64 32-byte secret (NOT
// PERSONAL_DATA_ENCRYPTION_KEY / IDEMPOTENCY_ENCRYPTION_KEY), so compromising or rotating one never
// touches the archive. Owner generates it with `openssl rand -base64 32` and puts it in app.env.
// The key is never logged, never written to /mnt/250gb, never put in a backup, a report, or deploy
// output.

const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const MAGIC = Buffer.from('TGPSA', 'ascii'); // 5 bytes
const FORMAT_VERSION = 1;
export const GPS_ARCHIVE_FORMAT = 'jsonl.gz.enc(aes-256-gcm)';
export const GPS_ARCHIVE_SCHEMA_VERSION = 1;

export class GpsArchiveKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpsArchiveKeyConfigError';
  }
}

export class GpsArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpsArchiveFormatError';
  }
}

function readKeyRaw(): Buffer | null {
  const raw = process.env.GPS_ARCHIVE_ENCRYPTION_KEY;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

/**
 * True only when GPS_ARCHIVE_ENCRYPTION_KEY is set and decodes to exactly 32 bytes. The retention
 * job calls this and refuses to delete any raw GPS when it is false — no key means no archiving is
 * possible, so nothing may be discarded. Never throws, never logs the key.
 */
export function isGpsArchiveKeyConfigured(): boolean {
  return readKeyRaw() !== null;
}

function gpsArchiveKey(): Buffer {
  const key = readKeyRaw();
  if (!key) {
    throw new GpsArchiveKeyConfigError(
      'GPS_ARCHIVE_ENCRYPTION_KEY is not set or does not decode to exactly 32 bytes (AES-256).'
    );
  }
  return key;
}

// ---------------------------------------------------------------------------------------------
// Record shape — one JSONL line per raw GPS record (TZ §9.3). Coordinates and accuracy are kept
// as strings to preserve the exact Decimal value; BigInt columns likewise.
// ---------------------------------------------------------------------------------------------

export interface GpsClockLocationRecord {
  recordType: 'clock_location';
  clockEventId: string;
  employeeId: string;
  operationType: string;
  recordedAt: string; // ClockEvent.clientCapturedAt (device claim)
  effectiveAt: string; // ClockEvent.effectiveAt (server-adjudicated — the archive bucket key)
  serverReceivedAt: string;
  latitude: string;
  longitude: string;
  accuracyMeters: string | null;
  isApproximate: boolean;
  fixAgeSeconds: number | null;
  capturedAfterEventSeconds: number | null;
  capturedOffline: boolean;
  channel: string;
  siteId: string;
  assumedSiteId: string | null;
  geofenceVersionId: string | null;
  gpsVerification: string;
  gpsUnavailableReason: string | null;
  locationCreatedAt: string; // ClockEventLocation.createdAt (server-insert stream position)
  archivedAt: string;
}

export interface GpsPresenceSampleRecord {
  recordType: 'presence_sample';
  sampleId: string;
  clientSampleId: string;
  employeeId: string;
  recordedAt: string; // ShiftPresenceSample.capturedAt (the archive bucket key)
  serverReceivedAt: string;
  latitude: string;
  longitude: string;
  accuracyMeters: string;
  capturedOffline: boolean;
  siteId: string | null;
  openShiftId: string | null;
  geofenceVersionId: string | null;
  insideGeofence: boolean | null;
  sampleCreatedAt: string; // ShiftPresenceSample.createdAt (server-insert stream position)
  archivedAt: string;
}

export type GpsArchiveRecord = GpsClockLocationRecord | GpsPresenceSampleRecord;

/** Deterministic JSONL: keys sorted, one record per line, trailing newline. Byte-stable for a
 *  given record set, so the plaintext SHA-256 is reproducible. */
export function serializeGpsRecords(records: GpsArchiveRecord[]): string {
  return records.map((r) => JSON.stringify(sortKeys(r as unknown as Record<string, unknown>))).join('\n') + (records.length ? '\n' : '');
}

export function parseGpsRecords(jsonl: string): GpsArchiveRecord[] {
  const trimmed = jsonl.replace(/\n$/, '');
  if (trimmed === '') return [];
  return trimmed.split('\n').map((line, i) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new GpsArchiveFormatError(`archive line ${i + 1} is not valid JSON`);
    }
    if (!value || typeof value !== 'object' || !('recordType' in value)) {
      throw new GpsArchiveFormatError(`archive line ${i + 1} has no recordType`);
    }
    return value as GpsArchiveRecord;
  });
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

// ---------------------------------------------------------------------------------------------
// pack / unpack — gzip then AES-256-GCM. Blob layout: MAGIC(5) | version(1) | iv(12) | ct | tag(16)
// ---------------------------------------------------------------------------------------------

export function packArchive(jsonl: string): Buffer {
  const compressed = gzipSync(Buffer.from(jsonl, 'utf8'), { level: 9 });
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', gpsArchiveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), iv, ciphertext, authTag]);
}

export function unpackArchive(blob: Buffer): string {
  const headerLen = MAGIC.length + 1 + GCM_IV_LENGTH;
  if (blob.length < headerLen + GCM_AUTH_TAG_LENGTH) {
    throw new GpsArchiveFormatError('archive blob is too short');
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new GpsArchiveFormatError('archive blob has a bad magic prefix');
  }
  const version = blob[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new GpsArchiveFormatError(`unsupported archive format version ${version}`);
  }
  const iv = blob.subarray(MAGIC.length + 1, headerLen);
  const authTag = blob.subarray(blob.length - GCM_AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(headerLen, blob.length - GCM_AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', gpsArchiveKey(), iv);
  decipher.setAuthTag(authTag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return gunzipSync(compressed).toString('utf8');
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Day manifest — sits next to the .enc file, both on-box and off-box. No coordinates, no key.
// ---------------------------------------------------------------------------------------------

export interface GpsDayManifestInput {
  archiveDate: string; // YYYY-MM-DD
  revision: number;
  clockLocationCount: number;
  presenceSampleCount: number;
  coveredThroughCreatedAt: string;
  jsonl: string;
  blob: Buffer;
  relativePath: string;
}

export interface GpsDayManifest {
  schemaVersion: number;
  format: string;
  archiveDate: string;
  revision: number;
  recordCount: number;
  clockLocationCount: number;
  presenceSampleCount: number;
  coveredThroughCreatedAt: string;
  plaintextSha256: string;
  plaintextBytes: number;
  ciphertextSha256: string;
  ciphertextBytes: number;
  relativePath: string;
  builtAt: string;
}

export function buildDayManifest(input: GpsDayManifestInput): GpsDayManifest {
  const plaintextBytes = Buffer.byteLength(input.jsonl, 'utf8');
  return {
    schemaVersion: GPS_ARCHIVE_SCHEMA_VERSION,
    format: GPS_ARCHIVE_FORMAT,
    archiveDate: input.archiveDate,
    revision: input.revision,
    recordCount: input.clockLocationCount + input.presenceSampleCount,
    clockLocationCount: input.clockLocationCount,
    presenceSampleCount: input.presenceSampleCount,
    coveredThroughCreatedAt: input.coveredThroughCreatedAt,
    plaintextSha256: sha256Hex(input.jsonl),
    plaintextBytes,
    ciphertextSha256: sha256Hex(input.blob),
    ciphertextBytes: input.blob.length,
    relativePath: input.relativePath,
    builtAt: new Date().toISOString()
  };
}

/** relative path within the archive root: gps-archive/YYYY/MM/YYYY-MM-DD[.rNN].jsonl.gz.enc */
export function archiveRelativePath(archiveDate: string, revision: number): string {
  const [y, m] = archiveDate.split('-');
  const suffix = revision === 0 ? '' : `.r${String(revision).padStart(2, '0')}`;
  return `gps-archive/${y}/${m}/${archiveDate}${suffix}.jsonl.gz.enc`;
}
