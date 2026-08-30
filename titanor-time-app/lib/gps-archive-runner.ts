import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { prisma } from '@/lib/prisma';
import {
  isGpsArchiveKeyConfigured,
  GpsArchiveKeyConfigError,
  packArchive,
  unpackArchive,
  serializeGpsRecords,
  parseGpsRecords,
  buildDayManifest,
  archiveRelativePath,
  sha256Hex
} from './gps-archive';
import {
  listSealableDays,
  collectGpsDay,
  upsertArchiveDayWritten,
  markArchiveDayVerified,
  markArchiveDayFailed,
  DEFAULT_SEAL_MARGIN_DAYS,
  DEFAULT_MAX_LOOKBACK_DAYS
} from './gps-archive-run';

// R08 — the archive runner (docs/titanor-time/R08_GPS_ARCHIVE_REPORT_RU.md, TZ §9). Two phases,
// both run in a throwaway container by ops/titanor-time/gps-archive-titanor-time.sh:
//   write   — encrypt each sealable day into the local staging dir, self-verify it there, record
//             GpsArchiveDay = WRITTEN. Never touches /mnt/250gb.
//   promote — read the host's _offbox-verified.json (the days it copied off-box and checksum-
//             verified), re-check each against the staging file + ledger, record VERIFIED.
// The runner NEVER deletes raw GPS — that is the scheduler's retention step, gated on VERIFIED.

const PENDING_FILE = 'gps-archive/_pending-offbox.json';
const OFFBOX_VERIFIED_FILE = 'gps-archive/_offbox-verified.json';

type Log = (fields: Record<string, unknown>) => void;
const noop: Log = () => {};

function requireKey(): void {
  if (!isGpsArchiveKeyConfigured()) {
    throw new GpsArchiveKeyConfigError(
      'GPS_ARCHIVE_ENCRYPTION_KEY is not set or malformed — GPS archive job will not run.'
    );
  }
}

async function writeFileMkdir(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export interface WrittenDay {
  archiveDate: string;
  revision: number;
  relativePath: string;
  ciphertextSha256: string;
  plaintextSha256: string;
  clockLocationCount: number;
  presenceSampleCount: number;
}

export interface GpsArchiveWriteResult {
  written: WrittenDay[];
  failed: { archiveDate: string; revision: number; errorCode: string }[];
  pendingOffbox: WrittenDay[];
}

export async function runGpsArchiveWrite(opts: {
  stagingDir: string;
  asOf?: Date;
  sealMarginDays?: number;
  maxLookbackDays?: number;
  log?: Log;
}): Promise<GpsArchiveWriteResult> {
  requireKey();
  const log = opts.log ?? noop;
  const asOf = opts.asOf ?? new Date();
  const sealMarginDays = opts.sealMarginDays ?? DEFAULT_SEAL_MARGIN_DAYS;
  const maxLookbackDays = opts.maxLookbackDays ?? DEFAULT_MAX_LOOKBACK_DAYS;

  const days = await listSealableDays(asOf, { sealMarginDays, maxLookbackDays });
  log({ event: 'gps_archive_write_start', sealableDays: days.length, asOf: asOf.toISOString() });

  const written: WrittenDay[] = [];
  const failed: GpsArchiveWriteResult['failed'] = [];

  for (const day of days) {
    try {
      const collected = await collectGpsDay(day.archiveDate, day.sinceCreatedAt, asOf, asOf);
      if (collected.records.length === 0 && day.reason === 'amendment') {
        log({ event: 'gps_archive_day_skipped', archiveDate: day.archiveDate, reason: 'empty_amendment' });
        continue;
      }

      const jsonl = serializeGpsRecords(collected.records);
      const blob = packArchive(jsonl);
      const relativePath = archiveRelativePath(day.archiveDate, day.targetRevision);
      const manifest = buildDayManifest({
        archiveDate: day.archiveDate,
        revision: day.targetRevision,
        clockLocationCount: collected.clockLocationCount,
        presenceSampleCount: collected.presenceSampleCount,
        coveredThroughCreatedAt: asOf.toISOString(),
        jsonl,
        blob,
        relativePath
      });

      const blobPath = join(opts.stagingDir, relativePath);
      await writeFileMkdir(blobPath, blob);
      await writeFileMkdir(`${blobPath}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n');

      // Self-verify from the file we just wrote.
      const readBack = await readFile(blobPath);
      if (sha256Hex(readBack) !== manifest.ciphertextSha256) throw new Error('self_verify_ciphertext_sha');
      const jsonlBack = unpackArchive(readBack);
      if (sha256Hex(jsonlBack) !== manifest.plaintextSha256) throw new Error('self_verify_plaintext_sha');
      const recsBack = parseGpsRecords(jsonlBack);
      if (recsBack.length !== manifest.recordCount) throw new Error('self_verify_count');

      await upsertArchiveDayWritten({
        archiveDate: day.archiveDate,
        revision: day.targetRevision,
        clockLocationCount: collected.clockLocationCount,
        presenceSampleCount: collected.presenceSampleCount,
        coveredThroughCreatedAt: asOf,
        plaintextSha256: manifest.plaintextSha256,
        ciphertextSha256: manifest.ciphertextSha256,
        ciphertextBytes: manifest.ciphertextBytes,
        relativePath
      });

      written.push({
        archiveDate: day.archiveDate,
        revision: day.targetRevision,
        relativePath,
        ciphertextSha256: manifest.ciphertextSha256,
        plaintextSha256: manifest.plaintextSha256,
        clockLocationCount: collected.clockLocationCount,
        presenceSampleCount: collected.presenceSampleCount
      });
      log({
        event: 'gps_archive_day_written',
        archiveDate: day.archiveDate,
        revision: day.targetRevision,
        recordCount: manifest.recordCount,
        ciphertextBytes: manifest.ciphertextBytes
      });
    } catch {
      // Never logs the raw Error — it can carry coordinates or the key.
      const errorCode = 'GPS_ARCHIVE_DAY_WRITE_FAILED';
      await markArchiveDayFailed(day.archiveDate, day.targetRevision, errorCode).catch(() => {});
      failed.push({ archiveDate: day.archiveDate, revision: day.targetRevision, errorCode });
      log({ event: 'gps_archive_day_failed', archiveDate: day.archiveDate, revision: day.targetRevision, errorCode });
    }
  }

  // Every currently-WRITTEN day (this run + any earlier run that never got promoted).
  const pendingRows = await prisma.gpsArchiveDay.findMany({
    where: { status: 'WRITTEN' },
    orderBy: [{ archiveDate: 'asc' }, { revision: 'asc' }]
  });
  const pendingOffbox: WrittenDay[] = pendingRows.map((r) => ({
    archiveDate: r.archiveDate.toISOString().slice(0, 10),
    revision: r.revision,
    relativePath: r.relativePath ?? '',
    ciphertextSha256: r.ciphertextSha256 ?? '',
    plaintextSha256: r.plaintextSha256 ?? '',
    clockLocationCount: r.clockLocationCount,
    presenceSampleCount: r.presenceSampleCount
  }));
  await writeFileMkdir(join(opts.stagingDir, PENDING_FILE), JSON.stringify({ generatedAt: new Date().toISOString(), days: pendingOffbox }, null, 2) + '\n');

  log({ event: 'gps_archive_write_done', written: written.length, failed: failed.length, pendingOffbox: pendingOffbox.length });
  return { written, failed, pendingOffbox };
}

export interface GpsArchivePromoteResult {
  verified: { archiveDate: string; revision: number }[];
  failed: { archiveDate: string; revision: number; errorCode: string }[];
}

export async function runGpsArchivePromote(opts: { stagingDir: string; log?: Log }): Promise<GpsArchivePromoteResult> {
  requireKey();
  const log = opts.log ?? noop;
  const verified: GpsArchivePromoteResult['verified'] = [];
  const failed: GpsArchivePromoteResult['failed'] = [];

  let entries: { archiveDate: string; revision: number; ciphertextSha256: string }[];
  try {
    const raw = await readFile(join(opts.stagingDir, OFFBOX_VERIFIED_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { days?: unknown };
    entries = Array.isArray(parsed.days) ? (parsed.days as typeof entries) : [];
  } catch {
    log({ event: 'gps_archive_promote_nothing', reason: 'no_offbox_verified_file' });
    return { verified, failed };
  }

  for (const entry of entries) {
    const row = await prisma.gpsArchiveDay.findUnique({
      where: { archiveDate_revision: { archiveDate: new Date(`${entry.archiveDate}T00:00:00.000Z`), revision: entry.revision } }
    });
    if (!row || row.status !== 'WRITTEN') {
      log({ event: 'gps_archive_promote_skip', archiveDate: entry.archiveDate, revision: entry.revision, status: row?.status ?? 'missing' });
      continue;
    }

    let errorCode: string | null = null;
    try {
      if (entry.ciphertextSha256 !== row.ciphertextSha256) errorCode = 'GPS_ARCHIVE_OFFBOX_SHA_MISMATCH';
      else {
        const blob = await readFile(join(opts.stagingDir, row.relativePath ?? ''));
        if (sha256Hex(blob) !== row.ciphertextSha256) errorCode = 'GPS_ARCHIVE_STAGING_SHA_MISMATCH';
        else {
          const jsonl = unpackArchive(blob);
          if (sha256Hex(jsonl) !== row.plaintextSha256) errorCode = 'GPS_ARCHIVE_PLAINTEXT_SHA_MISMATCH';
          else {
            const recs = parseGpsRecords(jsonl);
            const clock = recs.filter((r) => r.recordType === 'clock_location').length;
            const presence = recs.length - clock;
            if (clock !== row.clockLocationCount || presence !== row.presenceSampleCount) errorCode = 'GPS_ARCHIVE_COUNT_MISMATCH';
          }
        }
      }
    } catch {
      errorCode = 'GPS_ARCHIVE_VERIFY_ERROR';
    }

    if (errorCode) {
      await markArchiveDayFailed(entry.archiveDate, entry.revision, errorCode).catch(() => {});
      failed.push({ archiveDate: entry.archiveDate, revision: entry.revision, errorCode });
      log({ event: 'gps_archive_promote_failed', archiveDate: entry.archiveDate, revision: entry.revision, errorCode });
    } else {
      await markArchiveDayVerified(entry.archiveDate, entry.revision);
      verified.push({ archiveDate: entry.archiveDate, revision: entry.revision });
      log({ event: 'gps_archive_day_verified', archiveDate: entry.archiveDate, revision: entry.revision });
    }
  }

  log({ event: 'gps_archive_promote_done', verified: verified.length, failed: failed.length });
  return { verified, failed };
}
