import { prisma } from '@/lib/prisma';

// docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md Addendum "T7A.10C.1" §A — raw GPS retention.
// Single set-based DELETE, boundary computed by Postgres's own now() so it is byte-identical to
// the DB-level guard (fn_clock_event_location_retention_delete_guard, trg_clock_event_location_
// retention_delete_guard — 20260812000000_add_attendance_clock_schema_foundation) that has always
// existed but nothing has ever called into the window it permits. Never touches the parent
// ClockEvent row or its gpsVerification/gpsAccuracyMeters/geofenceVersionId columns — those live on
// a different table entirely, and the FK's onDelete: Cascade only flows ClockEvent deletion ->
// ClockEventLocation deletion, never the reverse.

export interface LocationRetentionResult {
  deletedCount: number;
  /** T12 §2b — ShiftPresenceSample carries raw coordinates too, same 90-day window. */
  presenceDeletedCount: number;
}

export async function runAttendanceLocationRetention(): Promise<LocationRetentionResult> {
  const deletedCount = await prisma.$executeRaw`
    DELETE FROM "ClockEventLocation" WHERE "createdAt" < now() - interval '90 days'
  `;
  const presenceDeletedCount = await prisma.$executeRaw`
    DELETE FROM "ShiftPresenceSample" WHERE "createdAt" < now() - interval '90 days'
  `;
  return { deletedCount, presenceDeletedCount };
}
