import { prisma } from '@/lib/prisma';
import { isGpsArchiveKeyConfigured } from './gps-archive';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §A — raw GPS retention,
// now archive-gated (R08 — docs/titanor-time/R08_GPS_ARCHIVE_REPORT_RU.md, TZ §9).
//
// A raw row is deleted only when BOTH hold:
//   1. it is older than the 90-day operational window (also enforced by the DB trigger
//      fn_clock_event_location_retention_delete_guard for ClockEventLocation), and
//   2. its UTC reading-day is fully covered by a VERIFIED GpsArchiveDay — every revision for the
//      day is VERIFIED and no raw row for the day was inserted after the latest archive watermark.
// If GPS_ARCHIVE_ENCRYPTION_KEY is missing/malformed, NOTHING is deleted (archiving is impossible,
// so no coordinate may be discarded). A day whose archive failed or is only WRITTEN keeps its raw
// GPS. The 2-day seal margin never shortens the 90-day window — a day is not even eligible here
// until its rows are 90 days old, long after it was sealed.

export interface LocationRetentionResult {
  deletedCount: number;
  /** T12 §2b — ShiftPresenceSample carries raw coordinates too, same 90-day window. */
  presenceDeletedCount: number;
  /** R08 — set when the pass deleted nothing on purpose: 'skipped_no_archive_key'. */
  gateSkippedReason?: 'skipped_no_archive_key';
  /** R08 — UTC reading-days that are 90+ days old but still hold raw GPS (archive not VERIFIED). */
  unarchivedOldDayCount: number;
}

export async function runAttendanceLocationRetention(): Promise<LocationRetentionResult> {
  if (!isGpsArchiveKeyConfigured()) {
    return {
      deletedCount: 0,
      presenceDeletedCount: 0,
      gateSkippedReason: 'skipped_no_archive_key',
      unarchivedOldDayCount: await countUnarchivedOldDays()
    };
  }

  const safeDays = (
    await prisma.$queryRaw<{ d: Date }[]>`
      WITH covered AS (
        SELECT g."archiveDate" AS d, max(g."coveredThroughCreatedAt") AS wm
          FROM "GpsArchiveDay" g
         GROUP BY g."archiveDate"
        HAVING bool_and(g."status" = 'VERIFIED')
      )
      SELECT c.d
        FROM covered c
       WHERE NOT EXISTS (
               SELECT 1
                 FROM "ClockEventLocation" x
                 JOIN "ClockEvent" xe ON xe."id" = x."clockEventId"
                WHERE (xe."effectiveAt" AT TIME ZONE 'UTC')::date = c.d
                  AND x."createdAt" > c.wm
             )
         AND NOT EXISTS (
               SELECT 1
                 FROM "ShiftPresenceSample" y
                WHERE (y."capturedAt" AT TIME ZONE 'UTC')::date = c.d
                  AND y."createdAt" > c.wm
             )
    `
  ).map((r) => r.d.toISOString().slice(0, 10));

  if (safeDays.length === 0) {
    return { deletedCount: 0, presenceDeletedCount: 0, unarchivedOldDayCount: await countUnarchivedOldDays() };
  }

  const deletedCount = await prisma.$executeRaw`
    DELETE FROM "ClockEventLocation" cel
      USING "ClockEvent" ce
     WHERE ce."id" = cel."clockEventId"
       AND cel."createdAt" < now() - interval '90 days'
       AND (ce."effectiveAt" AT TIME ZONE 'UTC')::date = ANY(${safeDays}::date[])
  `;
  const presenceDeletedCount = await prisma.$executeRaw`
    DELETE FROM "ShiftPresenceSample" sps
     WHERE sps."createdAt" < now() - interval '90 days'
       AND (sps."capturedAt" AT TIME ZONE 'UTC')::date = ANY(${safeDays}::date[])
  `;

  return {
    deletedCount,
    presenceDeletedCount,
    unarchivedOldDayCount: await countUnarchivedOldDays()
  };
}

/** Diagnostic only — UTC reading-days with raw GPS 90+ days old that a VERIFIED archive does not
 *  yet cover. A non-zero value means the archive job is behind and retention is (correctly) held. */
async function countUnarchivedOldDays(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    WITH old_days AS (
      SELECT (ce."effectiveAt" AT TIME ZONE 'UTC')::date AS d
        FROM "ClockEventLocation" cel
        JOIN "ClockEvent" ce ON ce."id" = cel."clockEventId"
       WHERE cel."createdAt" < now() - interval '90 days'
      UNION
      SELECT (sps."capturedAt" AT TIME ZONE 'UTC')::date AS d
        FROM "ShiftPresenceSample" sps
       WHERE sps."createdAt" < now() - interval '90 days'
    ),
    verified_days AS (
      SELECT g."archiveDate" AS d
        FROM "GpsArchiveDay" g
       GROUP BY g."archiveDate"
      HAVING bool_and(g."status" = 'VERIFIED')
    )
    SELECT count(*) AS n FROM old_days o WHERE NOT EXISTS (SELECT 1 FROM verified_days v WHERE v.d = o.d)
  `;
  return rows[0] ? Number(rows[0].n) : 0;
}
