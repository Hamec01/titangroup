-- Titanor Time — GPS step 4 (docs/titanor-time/T11_GPS_IMPROVEMENTS_DESIGN.md).
--
-- Server-side geofence-verification GPS accuracy gate, moved out of a hard-coded constant
-- (MAX_ACCEPTABLE_ACCURACY_METERS = 75 in lib/attendance-clock.ts / lib/worker-gps.ts) into the
-- singleton CompanyAttendancePolicy so an admin can raise it from /admin/attendance/policy for a
-- site with chronically poor indoor GPS (a shipyard cell). A reading whose accuracyMeters exceeds
-- this value becomes GPS_NOT_VERIFIED (reason LOW_ACCURACY), exactly as before.
--
-- DEFAULT 75 reproduces the previous behaviour for the existing singleton row. Additive column,
-- no data migration.

ALTER TABLE "CompanyAttendancePolicy"
  ADD COLUMN "maxGpsAccuracyMeters" INTEGER NOT NULL DEFAULT 75;

-- Sanity bound: a positive, plausible metre value (10 m .. 5 km).
ALTER TABLE "CompanyAttendancePolicy"
  ADD CONSTRAINT "ck_company_attendance_policy_max_gps_accuracy_range"
  CHECK ("maxGpsAccuracyMeters" BETWEEN 10 AND 5000);
