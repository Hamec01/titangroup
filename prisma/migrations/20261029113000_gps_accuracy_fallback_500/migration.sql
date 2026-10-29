ALTER TABLE "CompanyAttendancePolicy"
    ALTER COLUMN "maxGpsAccuracyMeters" DROP NOT NULL,
    ALTER COLUMN "maxGpsAccuracyMeters" DROP DEFAULT;

UPDATE "CompanyAttendancePolicy" AS policy
SET "maxGpsAccuracyMeters" = NULL
WHERE policy."maxGpsAccuracyMeters" = 75
  AND NOT EXISTS (
    SELECT 1
    FROM "AuditEvent" AS event
    WHERE event."eventType" = 'ATTENDANCE_POLICY_UPDATED'
      AND event."entityType" = 'COMPANY_ATTENDANCE_POLICY'
      AND event."afterValue"->>'maxGpsAccuracyMeters' = '75'
      AND event."beforeValue"->>'maxGpsAccuracyMeters' IS DISTINCT FROM '75'
  );
