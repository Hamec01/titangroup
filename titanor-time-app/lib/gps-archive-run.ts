import { prisma } from '@/lib/prisma';
import type { GpsArchiveRecord } from './gps-archive';

// R08 — DB-aware side of the GPS archive (docs/titanor-time/R08_GPS_ARCHIVE_REPORT_RU.md, TZ §9).
// Selects sealable days, reads one day's raw GPS into archive records, and maintains the
// GpsArchiveDay ledger. No filesystem, no encryption — scripts/run-gps-archive.ts does that and
// calls in here. The retention job (lib/attendance-location-retention.ts) reads the same ledger.

export const DEFAULT_SEAL_MARGIN_DAYS = 2;
export const DEFAULT_MAX_LOOKBACK_DAYS = 120; // 90-day retention + slack; caps a first-run scan

export interface SealableDay {
  archiveDate: string; // YYYY-MM-DD (UTC reading-date)
  targetRevision: number;
  sinceCreatedAt: Date | null; // exclusive lower bound on server-insert time (null = from the start)
  reason: 'new' | 'retry' | 'amendment';
}

export interface DayCollection {
  records: GpsArchiveRecord[];
  clockLocationCount: number;
  presenceSampleCount: number;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `asOf` minus `days` whole days, as a YYYY-MM-DD UTC date string. */
function shiftUtcDate(asOf: Date, days: number): string {
  return utcDateString(new Date(asOf.getTime() - days * 86_400_000));
}

interface DayRow {
  d: Date;
  raw_max_created: Date;
  has_ledger: boolean;
  all_verified: boolean;
  max_rev: number | null;
  latest_covered_through: Date | null;
}

/**
 * Reading-days whose date is <= asOf - sealMarginDays and are not yet fully archived+verified:
 *  - no ledger row            -> a new day (revision 0, from the start)
 *  - an un-VERIFIED revision   -> retry it (same bounds it had)
 *  - all VERIFIED but raw rows exist past the last watermark -> an amendment (next revision)
 */
export async function listSealableDays(
  asOf: Date,
  opts: { sealMarginDays?: number; maxLookbackDays?: number } = {}
): Promise<SealableDay[]> {
  const sealMarginDays = opts.sealMarginDays ?? DEFAULT_SEAL_MARGIN_DAYS;
  const maxLookbackDays = opts.maxLookbackDays ?? DEFAULT_MAX_LOOKBACK_DAYS;
  const sealCutoff = shiftUtcDate(asOf, sealMarginDays);
  const lookbackFrom = shiftUtcDate(asOf, maxLookbackDays);

  const rows = await prisma.$queryRaw<DayRow[]>`
    WITH reading_days AS (
      SELECT (ce."effectiveAt" AT TIME ZONE 'UTC')::date AS d, MAX(cel."createdAt") AS max_created
        FROM "ClockEventLocation" cel
        JOIN "ClockEvent" ce ON ce."id" = cel."clockEventId"
       WHERE (ce."effectiveAt" AT TIME ZONE 'UTC')::date BETWEEN ${lookbackFrom}::date AND ${sealCutoff}::date
       GROUP BY 1
      UNION ALL
      SELECT (sps."capturedAt" AT TIME ZONE 'UTC')::date AS d, MAX(sps."createdAt") AS max_created
        FROM "ShiftPresenceSample" sps
       WHERE (sps."capturedAt" AT TIME ZONE 'UTC')::date BETWEEN ${lookbackFrom}::date AND ${sealCutoff}::date
       GROUP BY 1
    ),
    day_raw AS (
      SELECT d, MAX(max_created) AS raw_max_created FROM reading_days GROUP BY d
    ),
    day_ledger AS (
      SELECT "archiveDate" AS d,
             bool_and("status" = 'VERIFIED') AS all_verified,
             max("revision") AS max_rev,
             max("coveredThroughCreatedAt") AS latest_covered_through
        FROM "GpsArchiveDay"
       GROUP BY "archiveDate"
    )
    SELECT dr.d,
           dr.raw_max_created,
           (dl.d IS NOT NULL) AS has_ledger,
           COALESCE(dl.all_verified, false) AS all_verified,
           dl.max_rev,
           dl.latest_covered_through
      FROM day_raw dr
      LEFT JOIN day_ledger dl ON dl.d = dr.d
     ORDER BY dr.d ASC
  `;

  const result: SealableDay[] = [];
  for (const row of rows) {
    const archiveDate = utcDateString(row.d);

    if (!row.has_ledger) {
      result.push({ archiveDate, targetRevision: 0, sinceCreatedAt: null, reason: 'new' });
      continue;
    }

    if (!row.all_verified) {
      // Re-run the lowest un-VERIFIED revision with the exact bounds it was created with.
      const revisions = await prisma.gpsArchiveDay.findMany({
        where: { archiveDate: new Date(`${archiveDate}T00:00:00.000Z`) },
        orderBy: { revision: 'asc' },
        select: { revision: true, status: true, coveredThroughCreatedAt: true }
      });
      const stuck = revisions.find((r) => r.status !== 'VERIFIED');
      if (!stuck) continue; // raced to VERIFIED since the aggregate query
      const prev = revisions.filter((r) => r.revision < stuck.revision).sort((a, b) => b.revision - a.revision)[0];
      result.push({
        archiveDate,
        targetRevision: stuck.revision,
        sinceCreatedAt: prev ? prev.coveredThroughCreatedAt : null,
        reason: 'retry'
      });
      continue;
    }

    // All revisions VERIFIED — only an amendment is needed, and only if raw rows landed later.
    if (row.latest_covered_through && row.raw_max_created > row.latest_covered_through) {
      result.push({
        archiveDate,
        targetRevision: (row.max_rev ?? 0) + 1,
        sinceCreatedAt: row.latest_covered_through,
        reason: 'amendment'
      });
    }
  }
  return result;
}

interface ClockRow {
  clock_event_id: string;
  employee_id: string;
  op: string;
  client_captured_at: Date;
  effective_at: Date;
  server_received_at: Date;
  lat: string;
  lng: string;
  acc: string | null;
  is_approximate: boolean;
  fix_age_seconds: number | null;
  captured_after_event_seconds: number | null;
  captured_offline: boolean;
  channel: string;
  site_id: string;
  assumed_site_id: string | null;
  geofence_version_id: string | null;
  verif: string;
  unavail: string | null;
  loc_created_at: Date;
}

interface PresenceRow {
  sample_id: string;
  client_sample_id: string;
  employee_id: string;
  captured_at: Date;
  server_received_at: Date;
  lat: string;
  lng: string;
  acc: string;
  captured_offline: boolean;
  site_id: string | null;
  open_shift_id: string | null;
  geofence_version_id: string | null;
  inside_geofence: boolean | null;
  sample_created_at: Date;
}

/**
 * All raw GPS for one UTC reading-day with `sinceCreatedAt < createdAt <= throughCreatedAt`.
 * Deterministic order (createdAt, id). `archivedAt` is stamped onto every record.
 */
export async function collectGpsDay(
  archiveDate: string,
  sinceCreatedAt: Date | null,
  throughCreatedAt: Date,
  archivedAt: Date
): Promise<DayCollection> {
  const since = sinceCreatedAt ? sinceCreatedAt.toISOString() : null;
  const through = throughCreatedAt.toISOString();
  const archivedAtIso = archivedAt.toISOString();

  const clockRows = await prisma.$queryRaw<ClockRow[]>`
    SELECT cel."clockEventId"                AS clock_event_id,
           ce."employeeId"                   AS employee_id,
           ce."operationType"::text          AS op,
           ce."clientCapturedAt"             AS client_captured_at,
           ce."effectiveAt"                  AS effective_at,
           ce."serverReceivedAt"             AS server_received_at,
           cel."latitude"::text              AS lat,
           cel."longitude"::text             AS lng,
           ce."gpsAccuracyMeters"::text      AS acc,
           cel."isApproximate"               AS is_approximate,
           cel."fixAgeSeconds"               AS fix_age_seconds,
           cel."capturedAfterEventSeconds"   AS captured_after_event_seconds,
           ce."capturedOffline"              AS captured_offline,
           ce."channel"::text                AS channel,
           ce."siteId"                       AS site_id,
           ce."assumedSiteId"                AS assumed_site_id,
           ce."geofenceVersionId"            AS geofence_version_id,
           ce."gpsVerification"::text        AS verif,
           ce."gpsUnavailableReason"::text   AS unavail,
           cel."createdAt"                   AS loc_created_at
      FROM "ClockEventLocation" cel
      JOIN "ClockEvent" ce ON ce."id" = cel."clockEventId"
     WHERE (ce."effectiveAt" AT TIME ZONE 'UTC')::date = ${archiveDate}::date
       AND cel."createdAt" <= ${through}::timestamptz
       AND (${since}::timestamptz IS NULL OR cel."createdAt" > ${since}::timestamptz)
     ORDER BY cel."createdAt" ASC, cel."clockEventId" ASC
  `;

  const presenceRows = await prisma.$queryRaw<PresenceRow[]>`
    SELECT sps."id"                 AS sample_id,
           sps."clientSampleId"     AS client_sample_id,
           sps."employeeId"         AS employee_id,
           sps."capturedAt"         AS captured_at,
           sps."serverReceivedAt"   AS server_received_at,
           sps."latitude"::text     AS lat,
           sps."longitude"::text    AS lng,
           sps."accuracyMeters"::text AS acc,
           sps."capturedOffline"    AS captured_offline,
           sps."siteId"             AS site_id,
           sps."openShiftId"        AS open_shift_id,
           sps."geofenceVersionId"  AS geofence_version_id,
           sps."insideGeofence"     AS inside_geofence,
           sps."createdAt"          AS sample_created_at
      FROM "ShiftPresenceSample" sps
     WHERE (sps."capturedAt" AT TIME ZONE 'UTC')::date = ${archiveDate}::date
       AND sps."createdAt" <= ${through}::timestamptz
       AND (${since}::timestamptz IS NULL OR sps."createdAt" > ${since}::timestamptz)
     ORDER BY sps."createdAt" ASC, sps."id" ASC
  `;

  const records: GpsArchiveRecord[] = [];
  for (const r of clockRows) {
    records.push({
      recordType: 'clock_location',
      clockEventId: r.clock_event_id,
      employeeId: r.employee_id,
      operationType: r.op,
      recordedAt: r.client_captured_at.toISOString(),
      effectiveAt: r.effective_at.toISOString(),
      serverReceivedAt: r.server_received_at.toISOString(),
      latitude: r.lat,
      longitude: r.lng,
      accuracyMeters: r.acc,
      isApproximate: r.is_approximate,
      fixAgeSeconds: r.fix_age_seconds,
      capturedAfterEventSeconds: r.captured_after_event_seconds,
      capturedOffline: r.captured_offline,
      channel: r.channel,
      siteId: r.site_id,
      assumedSiteId: r.assumed_site_id,
      geofenceVersionId: r.geofence_version_id,
      gpsVerification: r.verif,
      gpsUnavailableReason: r.unavail,
      locationCreatedAt: r.loc_created_at.toISOString(),
      archivedAt: archivedAtIso
    });
  }
  for (const r of presenceRows) {
    records.push({
      recordType: 'presence_sample',
      sampleId: r.sample_id,
      clientSampleId: r.client_sample_id,
      employeeId: r.employee_id,
      recordedAt: r.captured_at.toISOString(),
      serverReceivedAt: r.server_received_at.toISOString(),
      latitude: r.lat,
      longitude: r.lng,
      accuracyMeters: r.acc,
      capturedOffline: r.captured_offline,
      siteId: r.site_id,
      openShiftId: r.open_shift_id,
      geofenceVersionId: r.geofence_version_id,
      insideGeofence: r.inside_geofence,
      sampleCreatedAt: r.sample_created_at.toISOString(),
      archivedAt: archivedAtIso
    });
  }

  return { records, clockLocationCount: clockRows.length, presenceSampleCount: presenceRows.length };
}

export interface WrittenLedgerInput {
  archiveDate: string;
  revision: number;
  clockLocationCount: number;
  presenceSampleCount: number;
  coveredThroughCreatedAt: Date;
  plaintextSha256: string;
  ciphertextSha256: string;
  ciphertextBytes: number;
  relativePath: string;
}

/** Insert or (for a retry of a still-WRITTEN/FAILED revision) update the ledger row to WRITTEN. */
export async function upsertArchiveDayWritten(input: WrittenLedgerInput): Promise<void> {
  const archiveDate = new Date(`${input.archiveDate}T00:00:00.000Z`);
  const data = {
    status: 'WRITTEN' as const,
    clockLocationCount: input.clockLocationCount,
    presenceSampleCount: input.presenceSampleCount,
    coveredThroughCreatedAt: input.coveredThroughCreatedAt,
    plaintextSha256: input.plaintextSha256,
    ciphertextSha256: input.ciphertextSha256,
    ciphertextBytes: input.ciphertextBytes,
    relativePath: input.relativePath,
    errorCode: null,
    writtenAt: new Date(),
    verifiedAt: null
  };
  await prisma.gpsArchiveDay.upsert({
    where: { archiveDate_revision: { archiveDate, revision: input.revision } },
    create: { archiveDate, revision: input.revision, ...data },
    update: data
  });
}

export async function markArchiveDayVerified(archiveDate: string, revision: number): Promise<void> {
  await prisma.gpsArchiveDay.update({
    where: { archiveDate_revision: { archiveDate: new Date(`${archiveDate}T00:00:00.000Z`), revision } },
    data: { status: 'VERIFIED', verifiedAt: new Date() }
  });
}

export async function markArchiveDayFailed(
  archiveDate: string,
  revision: number,
  errorCode: string,
  counts?: { clockLocationCount: number; presenceSampleCount: number; coveredThroughCreatedAt: Date }
): Promise<void> {
  const archiveDateD = new Date(`${archiveDate}T00:00:00.000Z`);
  await prisma.gpsArchiveDay.upsert({
    where: { archiveDate_revision: { archiveDate: archiveDateD, revision } },
    create: {
      archiveDate: archiveDateD,
      revision,
      status: 'FAILED',
      clockLocationCount: counts?.clockLocationCount ?? 0,
      presenceSampleCount: counts?.presenceSampleCount ?? 0,
      coveredThroughCreatedAt: counts?.coveredThroughCreatedAt ?? new Date(),
      errorCode
    },
    update: { status: 'FAILED', errorCode }
  });
}
