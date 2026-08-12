-- ============================================================================
-- Preflight — SYSTEM actor username collision guard. Fixed per 2026-08-12 review (item 2);
-- kept outside the explicit transaction below per 2026-08-12 review (item A) — see the note
-- immediately above the BEGIN for why.
--
-- Deliberately the FIRST statement in this migration, before any T7A DDL (CREATE TYPE/TABLE,
-- ALTER TABLE ADD COLUMN) runs and before the explicit transaction below opens. A failure here
-- leaves the database in exactly its pre-migration state — nothing has executed yet, so there is
-- nothing to roll back, and no mutation of the pre-existing "User" row that triggered the failure.
--
-- "userKind" does not exist yet at this point (its ALTER TABLE runs later, in Section A) — this
-- check is deliberately username-only, case-insensitive, matching the exact scenarios required:
-- a HUMAN row already holding 'system.scheduler' (or any case-variant, e.g. 'System.Scheduler')
-- must fail the whole migration with a stable, greppable identifier, not be silently reused or
-- silently ignored. The stable identifier follows the project's uppercase P0001 convention
-- (05_RAW_SQL_REGISTER.md §7) — SYSTEM_SCHEDULER_USERNAME_OCCUPIED, not the ck_user_system_shape/
-- ck_* naming pattern, since this is a trigger-less preflight raised via a plain DO block, not a
-- CHECK constraint or a table trigger.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE lower("username") = lower('system.scheduler')) THEN
    RAISE EXCEPTION 'SYSTEM_SCHEDULER_USERNAME_OCCUPIED' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ============================================================================
-- Atomicity — fixed per 2026-08-12 review (item A). Everything from here through the final seed
-- INSERT runs inside one explicit transaction. Atomicity is guaranteed by this BEGIN/COMMIT pair,
-- not by an assumed/unproven behavior of the Prisma migration runner — the previous revision's
-- comment claimed "Prisma does wrap it for this provider" without an explicit transaction backing
-- that claim; that assertion is removed. All statements below (CREATE TYPE, CREATE TABLE, ALTER
-- TABLE ADD COLUMN/ADD CONSTRAINT, CREATE INDEX — none CONCURRENTLY, CREATE OR REPLACE FUNCTION,
-- CREATE TRIGGER, INSERT) are ordinary transactional DDL/DML on PostgreSQL 16; none require
-- running outside a transaction block.
--
-- The preflight DO block above is deliberately OUTSIDE this transaction, not the first statement
-- inside it — tested empirically on disposable PostgreSQL 16 (2026-08-12): wrapping the preflight
-- itself inside this same explicit transaction caused Prisma's migration engine to keep sending
-- subsequent statements after the preflight's RAISE EXCEPTION aborted the transaction, so the
-- terminal-visible error became Postgres's generic "current transaction is aborted, commands
-- ignored until end of transaction block" instead of SYSTEM_SCHEDULER_USERNAME_OCCUPIED — the
-- real identifier did not appear anywhere, not in stdout, not in `_prisma_migrations.logs`, not
-- under `DEBUG=prisma:*`. That regresses the whole point of the item-2 fix (a stable, greppable
-- failure reason). Keeping the preflight as a standalone statement before any transaction opens
-- avoids this entirely — a failure there was already atomic by construction (nothing precedes it)
-- and reports cleanly, exactly as before. The transaction below still closes the race this task
-- describes: preflight finds no colliding username, then a concurrent writer inserts a
-- "system.scheduler" row before this migration's own seed INSERT runs — that later INSERT's
-- unique_violation on "User_username_key" now rolls back everything opened by this BEGIN (every
-- enum, table, column, constraint, trigger, and the CompanyAttendancePolicy seed), not just itself.
-- ============================================================================
BEGIN;

-- CreateEnum
CREATE TYPE "ClockOperationType" AS ENUM ('CHECK_IN', 'CHECK_OUT');

-- CreateEnum
CREATE TYPE "GpsVerificationState" AS ENUM ('VERIFIED_INSIDE', 'VERIFIED_OUTSIDE', 'NOT_VERIFIED');

-- CreateEnum
CREATE TYPE "GpsUnavailableReason" AS ENUM ('PERMISSION_DENIED', 'TIMEOUT', 'POSITION_UNAVAILABLE', 'LOW_ACCURACY');

-- CreateEnum
CREATE TYPE "ClockEventProcessingState" AS ENUM ('ACCEPTED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "SubmissionChannel" AS ENUM ('ONLINE', 'OFFLINE_SYNC');

-- CreateEnum
CREATE TYPE "ClockShiftMaterializationState" AS ENUM ('PENDING', 'MATERIALIZED');

-- CreateEnum
CREATE TYPE "ClockShiftFragmentProjectionState" AS ENUM ('PENDING', 'SETTLED');

-- CreateEnum
CREATE TYPE "ClockShiftAdjustmentType" AS ENUM ('EDITED', 'REMOVED', 'RESTORED_TO_RECORDED');

-- CreateEnum
CREATE TYPE "ClockEventConflictType" AS ENUM ('CLIENT_EVENT_ID_REUSED', 'DEVICE_SEQUENCE_REUSED');

-- CreateEnum
CREATE TYPE "DeviceEventReceiptOutcome" AS ENUM ('ACCEPTED', 'REJECTED_TERMINAL');

-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('HUMAN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TimesheetReturnReason" AS ENUM ('HUMAN_REVIEW_RETURN', 'SYSTEM_LATE_SYNC_REOPEN');

-- CreateEnum
CREATE TYPE "AttendanceExceptionType" AS ENUM ('GPS_NOT_VERIFIED', 'OUTSIDE_GEOFENCE_CHECKOUT', 'SITE_MISMATCH_CHECKOUT', 'DOUBLE_CHECK_IN', 'CHECKOUT_WITHOUT_OPEN_SHIFT', 'STALE_ASSIGNMENT', 'GEOFENCE_VERSION_MISMATCH', 'LATE_SYNC_AFTER_SUBMIT', 'MISSING_CHECKOUT_AT_CUTOFF', 'EXCESSIVE_CLOCK_SKEW', 'CHECKOUT_CHRONOLOGY_ANOMALY', 'EXCESSIVE_SHIFT_DURATION', 'PERIOD_BOUNDARY_SPAN', 'OVERLAPPING_SHIFT');

-- CreateEnum
CREATE TYPE "AttendanceExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AttendanceExceptionResolutionAction" AS ENUM ('DISMISS', 'ACKNOWLEDGE_AS_VALID', 'PAIR_ORPHAN_EVENTS', 'CONFIRM_SOURCE_ASSIGNMENT', 'REASON_EDIT', 'FORCE_CLOSE_OPEN_SHIFT');

-- CreateEnum
CREATE TYPE "SubmissionSource" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "AutoSubmissionResult" AS ENUM ('SUBMITTED_CLEAN', 'SUBMITTED_WITH_EXCEPTIONS', 'SKIPPED_ALREADY_SUBMITTED', 'SKIPPED_NOT_ACTIONABLE');

-- AlterTable
ALTER TABLE "CorrectionDraftSegment" ADD COLUMN     "originClockShiftFragmentId" UUID;

-- AlterTable
ALTER TABLE "Timesheet" ADD COLUMN     "lastReturnedReason" "TimesheetReturnReason",
ADD COLUMN     "systemReopenAt" TIMESTAMPTZ(6),
ADD COLUMN     "systemReopenGeneration" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TimesheetDraftSegment" ADD COLUMN     "originClockShiftFragmentId" UUID;

-- AlterTable
ALTER TABLE "TimesheetVersion" ADD COLUMN     "submissionSource" "SubmissionSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "userKind" "UserKind" NOT NULL DEFAULT 'HUMAN';

-- AlterTable
ALTER TABLE "WorkSegment" ADD COLUMN     "originClockShiftFragmentId" UUID;

-- AlterTable
ALTER TABLE "WorkSite" ADD COLUMN     "currentGeofenceVersionId" UUID;

-- CreateTable
CREATE TABLE "WorkSiteGeofenceVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "siteId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "latitude" DECIMAL(8,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "radiusMeters" INTEGER NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSiteGeofenceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerDeviceInstallation" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "userAgent" TEXT,
    "platform" VARCHAR(32),
    "installedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "lastProcessedSequence" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerDeviceInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClockEvent" (
    "id" UUID NOT NULL,
    "groupId" UUID,
    "employeeId" UUID NOT NULL,
    "deviceInstallationId" UUID,
    "deviceSequence" BIGINT,
    "operationType" "ClockOperationType" NOT NULL,
    "siteId" UUID NOT NULL,
    "assumedSiteId" UUID,
    "workAreaId" UUID,
    "sourceAssignmentId" UUID,
    "clientCapturedAt" TIMESTAMPTZ(6) NOT NULL,
    "capturedOffline" BOOLEAN NOT NULL,
    "serverReceivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveAt" TIMESTAMPTZ(6) NOT NULL,
    "clockSkewMs" BIGINT,
    "gpsAccuracyMeters" DECIMAL(6,1),
    "geofenceVersionId" UUID,
    "gpsVerification" "GpsVerificationState" NOT NULL,
    "gpsUnavailableReason" "GpsUnavailableReason",
    "processingState" "ClockEventProcessingState" NOT NULL,
    "channel" "SubmissionChannel" NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "requestId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClockEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClockEventLocation" (
    "clockEventId" UUID NOT NULL,
    "latitude" DECIMAL(8,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClockEventLocation_pkey" PRIMARY KEY ("clockEventId")
);

-- CreateTable
CREATE TABLE "EmployeeOpenShift" (
    "employeeId" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "openedByClockEventId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "sourceAssignmentId" UUID,
    "openedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmployeeOpenShift_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "ClockShift" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "checkInEventId" UUID NOT NULL,
    "checkOutEventId" UUID,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "sourceAssignmentId" UUID,
    "recordedStartAt" TIMESTAMPTZ(6) NOT NULL,
    "recordedEndAt" TIMESTAMPTZ(6) NOT NULL,
    "endAtProvisional" BOOLEAN NOT NULL DEFAULT false,
    "forceClosedByUserId" UUID,
    "forceClosedReason" TEXT,
    "forceClosedAt" TIMESTAMPTZ(6),
    "materializationState" "ClockShiftMaterializationState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClockShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClockShiftFragment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clockShiftId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "fragmentIndex" INTEGER NOT NULL,
    "payrollPeriodId" UUID NOT NULL,
    "timesheetId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "recordedStartAt" TIMESTAMPTZ(6) NOT NULL,
    "recordedEndAt" TIMESTAMPTZ(6) NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "sourceAssignmentId" UUID,
    "reportedProjectionState" "ClockShiftFragmentProjectionState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClockShiftFragment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClockShiftAdjustment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clockShiftFragmentId" UUID NOT NULL,
    "clockShiftId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "changeType" "ClockShiftAdjustmentType" NOT NULL,
    "changedByUserId" UUID NOT NULL,
    "beforeStartAt" TIMESTAMPTZ(6),
    "afterStartAt" TIMESTAMPTZ(6),
    "beforeEndAt" TIMESTAMPTZ(6),
    "afterEndAt" TIMESTAMPTZ(6),
    "beforeSiteId" UUID,
    "afterSiteId" UUID,
    "beforeWorkAreaId" UUID,
    "afterWorkAreaId" UUID,
    "beforeSourceAssignmentId" UUID,
    "afterSourceAssignmentId" UUID,
    "reason" TEXT NOT NULL,
    "changedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" UUID NOT NULL,

    CONSTRAINT "ClockShiftAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceException" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "AttendanceExceptionType" NOT NULL,
    "employeeId" UUID NOT NULL,
    "timesheetId" UUID,
    "payrollPeriodId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "siteId" UUID,
    "clockEventId" UUID,
    "clockShiftId" UUID,
    "clockShiftFragmentId" UUID,
    "relatedClockShiftId" UUID,
    "status" "AttendanceExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "detail" JSONB,
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolutionNote" TEXT,
    "overlapEndedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClockEventIdConflict" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conflictType" "ClockEventConflictType" NOT NULL,
    "clientEventId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "deviceInstallationId" UUID,
    "sanitizedConflictingPayload" JSONB NOT NULL,
    "conflictingPayloadHash" VARCHAR(64) NOT NULL,
    "requestId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClockEventIdConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyAttendancePolicy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Europe/Helsinki',
    "cutoffDaysAfterPeriodEnd" INTEGER NOT NULL DEFAULT 0,
    "cutoffTime" TIME(0) NOT NULL DEFAULT '23:59:00'::time,
    "systemReopenDebounceMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxShiftDurationHours" INTEGER NOT NULL DEFAULT 16,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyAttendancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoSubmissionAttempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetId" UUID NOT NULL,
    "cutoffAt" TIMESTAMPTZ(6) NOT NULL,
    "systemReopenGeneration" INTEGER NOT NULL,
    "result" "AutoSubmissionResult" NOT NULL,
    "resultingVersionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoSubmissionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceEventReceipt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deviceInstallationId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "deviceSequence" BIGINT NOT NULL,
    "clientEventId" UUID NOT NULL,
    "outcome" "DeviceEventReceiptOutcome" NOT NULL,
    "clockEventId" UUID,
    "rejectionCode" VARCHAR(64),
    "payloadHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkSiteGeofenceVersion_siteId_versionNumber_key" ON "WorkSiteGeofenceVersion"("siteId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSiteGeofenceVersion_siteId_id_key" ON "WorkSiteGeofenceVersion"("siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeviceInstallation_id_employeeId_key" ON "WorkerDeviceInstallation"("id", "employeeId");

-- CreateIndex
CREATE INDEX "ClockEvent_employeeId_serverReceivedAt_idx" ON "ClockEvent"("employeeId", "serverReceivedAt");

-- CreateIndex
CREATE INDEX "ClockEvent_siteId_serverReceivedAt_idx" ON "ClockEvent"("siteId", "serverReceivedAt");

-- CreateIndex
CREATE INDEX "ClockEvent_processingState_idx" ON "ClockEvent"("processingState");

-- CreateIndex
CREATE INDEX "ClockEvent_groupId_idx" ON "ClockEvent"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockEvent_deviceInstallationId_deviceSequence_key" ON "ClockEvent"("deviceInstallationId", "deviceSequence");

-- CreateIndex
CREATE UNIQUE INDEX "ClockEvent_id_deviceInstallationId_employeeId_deviceSequenc_key" ON "ClockEvent"("id", "deviceInstallationId", "employeeId", "deviceSequence");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeOpenShift_id_key" ON "EmployeeOpenShift"("id");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeOpenShift_openedByClockEventId_key" ON "EmployeeOpenShift"("openedByClockEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockShift_checkInEventId_key" ON "ClockShift"("checkInEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockShift_checkOutEventId_key" ON "ClockShift"("checkOutEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockShift_id_employeeId_key" ON "ClockShift"("id", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockShiftFragment_clockShiftId_fragmentIndex_key" ON "ClockShiftFragment"("clockShiftId", "fragmentIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ClockShiftFragment_id_employeeId_key" ON "ClockShiftFragment"("id", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "ClockShiftFragment_id_clockShiftId_employeeId_key" ON "ClockShiftFragment"("id", "clockShiftId", "employeeId");

-- CreateIndex
CREATE INDEX "AttendanceException_siteId_status_idx" ON "AttendanceException"("siteId", "status");

-- CreateIndex
CREATE INDEX "AttendanceException_employeeId_status_idx" ON "AttendanceException"("employeeId", "status");

-- CreateIndex
CREATE INDEX "AttendanceException_type_status_idx" ON "AttendanceException"("type", "status");

-- CreateIndex
CREATE INDEX "AttendanceException_payrollPeriodId_status_idx" ON "AttendanceException"("payrollPeriodId", "status");

-- CreateIndex
CREATE INDEX "ClockEventIdConflict_clientEventId_idx" ON "ClockEventIdConflict"("clientEventId");

-- CreateIndex
CREATE INDEX "ClockEventIdConflict_employeeId_createdAt_idx" ON "ClockEventIdConflict"("employeeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyAttendancePolicy_singleton_key" ON "CompanyAttendancePolicy"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "AutoSubmissionAttempt_timesheetId_systemReopenGeneration_key" ON "AutoSubmissionAttempt"("timesheetId", "systemReopenGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceEventReceipt_deviceInstallationId_deviceSequence_key" ON "DeviceEventReceipt"("deviceInstallationId", "deviceSequence");

-- CreateIndex
CREATE INDEX "CorrectionDraftSegment_originClockShiftFragmentId_idx" ON "CorrectionDraftSegment"("originClockShiftFragmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Timesheet_id_employeeId_periodId_key" ON "Timesheet"("id", "employeeId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraftSegment_originClockShiftFragmentId_employeeId_key" ON "TimesheetDraftSegment"("originClockShiftFragmentId", "employeeId");

-- CreateIndex
CREATE INDEX "WorkSegment_originClockShiftFragmentId_idx" ON "WorkSegment"("originClockShiftFragmentId");

-- AddForeignKey
ALTER TABLE "WorkSite" ADD CONSTRAINT "WorkSite_id_currentGeofenceVersionId_fkey" FOREIGN KEY ("id", "currentGeofenceVersionId") REFERENCES "WorkSiteGeofenceVersion"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftSegment" ADD CONSTRAINT "TimesheetDraftSegment_originClockShiftFragmentId_employeeI_fkey" FOREIGN KEY ("originClockShiftFragmentId", "employeeId") REFERENCES "ClockShiftFragment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_originClockShiftFragmentId_employeeId_fkey" FOREIGN KEY ("originClockShiftFragmentId", "employeeId") REFERENCES "ClockShiftFragment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftSegment" ADD CONSTRAINT "CorrectionDraftSegment_originClockShiftFragmentId_employee_fkey" FOREIGN KEY ("originClockShiftFragmentId", "employeeId") REFERENCES "ClockShiftFragment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSiteGeofenceVersion" ADD CONSTRAINT "WorkSiteGeofenceVersion_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSiteGeofenceVersion" ADD CONSTRAINT "WorkSiteGeofenceVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerDeviceInstallation" ADD CONSTRAINT "WorkerDeviceInstallation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_deviceInstallationId_employeeId_fkey" FOREIGN KEY ("deviceInstallationId", "employeeId") REFERENCES "WorkerDeviceInstallation"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_assumedSiteId_fkey" FOREIGN KEY ("assumedSiteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_siteId_workAreaId_fkey" FOREIGN KEY ("siteId", "workAreaId") REFERENCES "WorkArea"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_sourceAssignmentId_fkey" FOREIGN KEY ("sourceAssignmentId") REFERENCES "SiteAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEvent" ADD CONSTRAINT "ClockEvent_siteId_geofenceVersionId_fkey" FOREIGN KEY ("siteId", "geofenceVersionId") REFERENCES "WorkSiteGeofenceVersion"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEventLocation" ADD CONSTRAINT "ClockEventLocation_clockEventId_fkey" FOREIGN KEY ("clockEventId") REFERENCES "ClockEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOpenShift" ADD CONSTRAINT "EmployeeOpenShift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOpenShift" ADD CONSTRAINT "EmployeeOpenShift_openedByClockEventId_fkey" FOREIGN KEY ("openedByClockEventId") REFERENCES "ClockEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOpenShift" ADD CONSTRAINT "EmployeeOpenShift_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOpenShift" ADD CONSTRAINT "EmployeeOpenShift_workAreaId_fkey" FOREIGN KEY ("workAreaId") REFERENCES "WorkArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeOpenShift" ADD CONSTRAINT "EmployeeOpenShift_sourceAssignmentId_fkey" FOREIGN KEY ("sourceAssignmentId") REFERENCES "SiteAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShift" ADD CONSTRAINT "ClockShift_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShift" ADD CONSTRAINT "ClockShift_checkInEventId_fkey" FOREIGN KEY ("checkInEventId") REFERENCES "ClockEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShift" ADD CONSTRAINT "ClockShift_checkOutEventId_fkey" FOREIGN KEY ("checkOutEventId") REFERENCES "ClockEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShift" ADD CONSTRAINT "ClockShift_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShift" ADD CONSTRAINT "ClockShift_workAreaId_fkey" FOREIGN KEY ("workAreaId") REFERENCES "WorkArea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShift" ADD CONSTRAINT "ClockShift_sourceAssignmentId_fkey" FOREIGN KEY ("sourceAssignmentId") REFERENCES "SiteAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShift" ADD CONSTRAINT "ClockShift_forceClosedByUserId_fkey" FOREIGN KEY ("forceClosedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftFragment" ADD CONSTRAINT "ClockShiftFragment_clockShiftId_employeeId_fkey" FOREIGN KEY ("clockShiftId", "employeeId") REFERENCES "ClockShift"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftFragment" ADD CONSTRAINT "ClockShiftFragment_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftFragment" ADD CONSTRAINT "ClockShiftFragment_timesheetId_employeeId_payrollPeriodId_fkey" FOREIGN KEY ("timesheetId", "employeeId", "payrollPeriodId") REFERENCES "Timesheet"("id", "employeeId", "periodId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftFragment" ADD CONSTRAINT "ClockShiftFragment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftFragment" ADD CONSTRAINT "ClockShiftFragment_siteId_workAreaId_fkey" FOREIGN KEY ("siteId", "workAreaId") REFERENCES "WorkArea"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftFragment" ADD CONSTRAINT "ClockShiftFragment_sourceAssignmentId_employeeId_siteId_fkey" FOREIGN KEY ("sourceAssignmentId", "employeeId", "siteId") REFERENCES "SiteAssignment"("id", "employeeId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftAdjustment" ADD CONSTRAINT "ClockShiftAdjustment_clockShiftFragmentId_clockShiftId_emp_fkey" FOREIGN KEY ("clockShiftFragmentId", "clockShiftId", "employeeId") REFERENCES "ClockShiftFragment"("id", "clockShiftId", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftAdjustment" ADD CONSTRAINT "ClockShiftAdjustment_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockShiftAdjustment" ADD CONSTRAINT "ClockShiftAdjustment_afterSourceAssignmentId_employeeId_af_fkey" FOREIGN KEY ("afterSourceAssignmentId", "employeeId", "afterSiteId") REFERENCES "SiteAssignment"("id", "employeeId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_clockEventId_fkey" FOREIGN KEY ("clockEventId") REFERENCES "ClockEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_clockShiftId_fkey" FOREIGN KEY ("clockShiftId") REFERENCES "ClockShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_relatedClockShiftId_fkey" FOREIGN KEY ("relatedClockShiftId") REFERENCES "ClockShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_clockShiftFragmentId_fkey" FOREIGN KEY ("clockShiftFragmentId") REFERENCES "ClockShiftFragment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEventIdConflict" ADD CONSTRAINT "ClockEventIdConflict_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClockEventIdConflict" ADD CONSTRAINT "ClockEventIdConflict_deviceInstallationId_employeeId_fkey" FOREIGN KEY ("deviceInstallationId", "employeeId") REFERENCES "WorkerDeviceInstallation"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyAttendancePolicy" ADD CONSTRAINT "CompanyAttendancePolicy_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoSubmissionAttempt" ADD CONSTRAINT "AutoSubmissionAttempt_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoSubmissionAttempt" ADD CONSTRAINT "AutoSubmissionAttempt_resultingVersionId_fkey" FOREIGN KEY ("resultingVersionId") REFERENCES "TimesheetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEventReceipt" ADD CONSTRAINT "DeviceEventReceipt_deviceInstallationId_employeeId_fkey" FOREIGN KEY ("deviceInstallationId", "employeeId") REFERENCES "WorkerDeviceInstallation"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEventReceipt" ADD CONSTRAINT "DeviceEventReceipt_clockEventId_deviceInstallationId_emplo_fkey" FOREIGN KEY ("clockEventId", "deviceInstallationId", "employeeId", "deviceSequence") REFERENCES "ClockEvent"("id", "deviceInstallationId", "employeeId", "deviceSequence") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- Source: docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §2.1, §2.2, §4.1, §13
-- (T7A.1 Attendance Clock — schema foundation slice). See
-- docs/titanor-time/05_RAW_SQL_REGISTER.md for the frozen register entry of every
-- object below.
--
-- Exception-identifier note: the design document's own SQL listings (§4.1) use
-- lowercase snake_case RAISE EXCEPTION message text (e.g. 'clock_event_immutable').
-- This migration instead uses this project's established stable-uppercase-identifier
-- convention (05_RAW_SQL_REGISTER.md §7 — "stable uppercase identifier ... substring
-- matching and human-readable message matching are prohibited"), the same convention
-- FN-01..FN-11 already use and the same one 05_RAW_SQL_REGISTER.md's own "Legacy
-- documentation incompatibility" section already applies to retrofit lowercase text
-- elsewhere in this repo's docs. No behavioral content changes — same tables, same
-- conditions, same trigger bindings — only the RAISE EXCEPTION identifier text.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------

-- ck_clock_event_device_sequence_pairing — §2.1 п.3: deviceInstallationId and
-- deviceSequence are NULL or NOT NULL together (a device-originated event always
-- carries both; a server/orphan-repair-originated event carries neither).
ALTER TABLE "ClockEvent"
  ADD CONSTRAINT "ck_clock_event_device_sequence_pairing"
  CHECK (("deviceInstallationId" IS NULL) = ("deviceSequence" IS NULL));

-- ck_clock_shift_recorded_interval — §2.1 п.6.
ALTER TABLE "ClockShift"
  ADD CONSTRAINT "ck_clock_shift_recorded_interval"
  CHECK ("recordedEndAt" > "recordedStartAt");

-- ck_clock_shift_close_mechanism — §2.1 п.6: exactly one of {real checkOutEventId,
-- FORCE_CLOSE_OPEN_SHIFT} applies, never both, never neither.
ALTER TABLE "ClockShift"
  ADD CONSTRAINT "ck_clock_shift_close_mechanism"
  CHECK (
    ("checkOutEventId" IS NOT NULL AND "forceClosedByUserId" IS NULL AND "forceClosedReason" IS NULL AND "forceClosedAt" IS NULL)
    OR
    ("checkOutEventId" IS NULL AND "forceClosedByUserId" IS NOT NULL AND "forceClosedReason" IS NOT NULL AND "forceClosedAt" IS NOT NULL)
  );

-- ck_clock_shift_fragment_recorded_interval — §2.1 п.7.
ALTER TABLE "ClockShiftFragment"
  ADD CONSTRAINT "ck_clock_shift_fragment_recorded_interval"
  CHECK ("recordedEndAt" > "recordedStartAt");

-- ck_clock_shift_adjustment_after_shape — §2.1 п.8: afterX IS NULL iff changeType=REMOVED.
ALTER TABLE "ClockShiftAdjustment"
  ADD CONSTRAINT "ck_clock_shift_adjustment_after_shape"
  CHECK (
    ("changeType" = 'REMOVED' AND "afterStartAt" IS NULL AND "afterEndAt" IS NULL AND "afterSiteId" IS NULL AND "afterSourceAssignmentId" IS NULL)
    OR
    ("changeType" IN ('EDITED', 'RESTORED_TO_RECORDED') AND "afterStartAt" IS NOT NULL AND "afterEndAt" IS NOT NULL AND "afterSiteId" IS NOT NULL)
  );

-- ck_attendance_exception_overlap_shape — §2.1 п.9 (issue 7): relatedClockShiftId/
-- overlapEndedAt are populated (and relatedClockShiftId != clockShiftId) only for
-- type=OVERLAPPING_SHIFT.
ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "ck_attendance_exception_overlap_shape"
  CHECK (
    ("type" != 'OVERLAPPING_SHIFT' AND "relatedClockShiftId" IS NULL AND "overlapEndedAt" IS NULL)
    OR
    ("type" = 'OVERLAPPING_SHIFT' AND "relatedClockShiftId" IS NOT NULL AND "relatedClockShiftId" != "clockShiftId")
  );

-- ck_attendance_exception_open_no_overlap_end — §2.1 п.9 (issue 7): an OPEN occurrence
-- cannot already have an end date.
ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "ck_attendance_exception_open_no_overlap_end"
  CHECK ("status" != 'OPEN' OR "overlapEndedAt" IS NULL);

-- ck_conflict_payload_no_gps_coordinates — §4.1 (issue 7), §4.3: DB-level guarantee
-- that the sanitized payload never carries raw GPS coordinates, defense-in-depth
-- behind the shared sanitization function.
ALTER TABLE "ClockEventIdConflict"
  ADD CONSTRAINT "ck_conflict_payload_no_gps_coordinates"
  CHECK (
    "sanitizedConflictingPayload" #> '{gps,latitude}' IS NULL AND
    "sanitizedConflictingPayload" #> '{gps,longitude}' IS NULL
  );

-- ck_company_attendance_policy_singleton / ck_company_attendance_policy_timezone_frozen
-- — §2.1 п.11, §4.4: singleton pattern (combined with the UNIQUE(singleton) index
-- Prisma already emits in Section A) and the intentionally frozen timezone.
ALTER TABLE "CompanyAttendancePolicy"
  ADD CONSTRAINT "ck_company_attendance_policy_singleton"
  CHECK ("singleton" = true);

ALTER TABLE "CompanyAttendancePolicy"
  ADD CONSTRAINT "ck_company_attendance_policy_timezone_frozen"
  CHECK ("timezone" = 'Europe/Helsinki');

-- ck_device_event_receipt_outcome_shape — §2.1 п.13.
ALTER TABLE "DeviceEventReceipt"
  ADD CONSTRAINT "ck_device_event_receipt_outcome_shape"
  CHECK (
    ("outcome" = 'ACCEPTED' AND "clockEventId" IS NOT NULL AND "rejectionCode" IS NULL)
    OR
    ("outcome" = 'REJECTED_TERMINAL' AND "clockEventId" IS NULL AND "rejectionCode" IS NOT NULL)
  );

-- ck_geofence_version_radius — §2.1 п.1.
ALTER TABLE "WorkSiteGeofenceVersion"
  ADD CONSTRAINT "ck_geofence_version_radius"
  CHECK ("radiusMeters" > 0 AND "radiusMeters" <= 2000);

-- ck_geofence_version_coordinates — §2.1 п.1: latitude/longitude range, previously only a table
-- comment ("−90.000000…90.000000" / "−180.000000…180.000000"), not a DB-level guarantee. Fixed
-- per 2026-08-12 review (item 4) — coordinate bounds now enforced the same way radiusMeters
-- already was.
ALTER TABLE "WorkSiteGeofenceVersion"
  ADD CONSTRAINT "ck_geofence_version_coordinates"
  CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);

-- ck_clock_event_location_coordinates — §2.1 п.4: same bound as ck_geofence_version_coordinates,
-- on the other table that stores raw coordinates (§4.3 — these are the only two).
ALTER TABLE "ClockEventLocation"
  ADD CONSTRAINT "ck_clock_event_location_coordinates"
  CHECK ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180);

-- ck_user_system_shape — §2.2 (issue 7): SYSTEM-user shape guaranteed at the DB level,
-- not only by seed convention. Fixed per 2026-08-12 review (SYSTEM identity race, follow-up to
-- item A of the previous fix): the original predicate only constrained the SYSTEM branch's own
-- shape and said nothing about the reserved username 'system.scheduler' itself — a HUMAN row
-- could freely hold any case-variant of it (User.username's plain UNIQUE index is case-sensitive,
-- so 'System.Scheduler' does not collide with 'system.scheduler'). The preflight guard only runs
-- once, before any T7A DDL; it cannot see a HUMAN row inserted *after* it ran, whether that insert
-- lands before this ALTER TABLE commits (blocking the migration, since the ALTER itself would then
-- reject the pre-existing violating row) or after (in which case only this CHECK — not the
-- preflight, not UNIQUE(username) — stands between a case-variant HUMAN and the reserved identity).
-- New predicate reserves 'system.scheduler' case-insensitively for the SYSTEM row and nowhere
-- else: no HUMAN may hold any case-variant of it, the SYSTEM row must hold the exact lowercase
-- form (not merely case-insensitively equal to it — renaming SYSTEM to 'System.Scheduler' is
-- itself now rejected), and the pre-existing SYSTEM shape fields (employeeId/passwordHash/status)
-- are unchanged. Still exactly one CHECK — this ALTERs the existing ck_user_system_shape predicate
-- in place, no new constraint is added.
ALTER TABLE "User"
  ADD CONSTRAINT "ck_user_system_shape"
  CHECK (
    ("userKind" = 'HUMAN' AND lower("username") <> 'system.scheduler')
    OR
    ("userKind" = 'SYSTEM' AND "username" = 'system.scheduler' AND "employeeId" IS NULL AND "passwordHash" IS NULL AND "status" = 'DEACTIVATED')
  );

-- ---------------------------------------------------------------------------
-- Partial / expression unique indexes (not expressible via Prisma @@unique)
-- ---------------------------------------------------------------------------

-- ux_attendance_exception_missing_checkout_dedup — §2.1 п.9 [3.1] (issue 3): at most
-- one MISSING_CHECKOUT_AT_CUTOFF row per (opening ClockEvent, period).
CREATE UNIQUE INDEX "ux_attendance_exception_missing_checkout_dedup"
  ON "AttendanceException" ("clockEventId", "payrollPeriodId")
  WHERE "type" = 'MISSING_CHECKOUT_AT_CUTOFF';

-- ux_attendance_exception_overlap_pair_open — §2.1 п.9 [3.2.3] (issue 5): at most one
-- simultaneously-OPEN row per unordered {clockShiftId, relatedClockShiftId} pair.
-- Canonicalization (clockShiftId := LEAST(A,B), relatedClockShiftId := GREATEST(A,B))
-- happens at INSERT time in service code (§9.1a), not in this index — this is a plain
-- (non-expression) partial unique index over the literal columns, matching the
-- explicit conflict target INSERT ... ON CONFLICT (clockShiftId, relatedClockShiftId)
-- WHERE type='OVERLAPPING_SHIFT' AND status='OPEN' the design specifies.
CREATE UNIQUE INDEX "ux_attendance_exception_overlap_pair_open"
  ON "AttendanceException" ("clockShiftId", "relatedClockShiftId")
  WHERE "type" = 'OVERLAPPING_SHIFT' AND "status" = 'OPEN';

-- ux_user_single_system — §2.2 (issue 7): at most one SYSTEM user ever, expression
-- index on a constant, same trick as the CompanyAttendancePolicy singleton but without
-- an extra column.
CREATE UNIQUE INDEX "ux_user_single_system" ON "User" ((true)) WHERE "userKind" = 'SYSTEM';

-- ---------------------------------------------------------------------------
-- Trigger functions and bindings — §4.1. 11 functions, 14 CREATE TRIGGER bindings.
-- RAISE EXCEPTION identifiers are stable uppercase per 05_RAW_SQL_REGISTER.md §7 (see
-- note at top of this section) — same conditions/tables as the design document's own
-- lowercase-identifier listings.
-- ---------------------------------------------------------------------------

-- fn_clock_event_immutable — §4.1: full UPDATE/DELETE ban, reused verbatim (same
-- function, same identifier) for ClockEvent, DeviceEventReceipt, and
-- AutoSubmissionAttempt — the design document explicitly reuses this same stub
-- across the three tables ("переиспользует ту же функцию-заглушку").
CREATE OR REPLACE FUNCTION fn_clock_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CLOCK_EVENT_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_event_immutable
  BEFORE UPDATE OR DELETE ON "ClockEvent"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_event_immutable();

CREATE TRIGGER trg_device_event_receipt_immutable
  BEFORE UPDATE OR DELETE ON "DeviceEventReceipt"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_event_immutable();

CREATE TRIGGER trg_auto_submission_attempt_immutable
  BEFORE UPDATE OR DELETE ON "AutoSubmissionAttempt"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_event_immutable();

-- fn_geofence_version_immutable — §4.1: editing a geofence creates a new version,
-- never rewrites the old one.
CREATE OR REPLACE FUNCTION fn_geofence_version_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'GEOFENCE_VERSION_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_geofence_version_immutable
  BEFORE UPDATE OR DELETE ON "WorkSiteGeofenceVersion"
  FOR EACH ROW EXECUTE FUNCTION fn_geofence_version_immutable();

-- fn_clock_event_conflict_immutable — §4.1: pure forensic log, full ban.
CREATE OR REPLACE FUNCTION fn_clock_event_conflict_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CLOCK_EVENT_CONFLICT_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_event_conflict_immutable
  BEFORE UPDATE OR DELETE ON "ClockEventIdConflict"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_event_conflict_immutable();

-- fn_clock_shift_adjustment_immutable — §4.1: full ban, truly immutable append-only.
CREATE OR REPLACE FUNCTION fn_clock_shift_adjustment_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CLOCK_SHIFT_ADJUSTMENT_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_shift_adjustment_immutable
  BEFORE UPDATE OR DELETE ON "ClockShiftAdjustment"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_shift_adjustment_immutable();

-- fn_clock_shift_immutable — §4.1: narrow contract, exactly two allowed transitions
-- (materializationState PENDING->MATERIALIZED once, sourceAssignmentId NULL->value
-- once). The PENDING->MATERIALIZED branch re-checks the same materialization-gate
-- predicate as the service layer (§9.4 step 9) at the DB level.
CREATE OR REPLACE FUNCTION fn_clock_shift_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."id"               IS DISTINCT FROM NEW."id"
     OR OLD."createdAt"     IS DISTINCT FROM NEW."createdAt"
     OR OLD."recordedStartAt" IS DISTINCT FROM NEW."recordedStartAt"
     OR OLD."recordedEndAt"   IS DISTINCT FROM NEW."recordedEndAt"
     OR OLD."siteId"          IS DISTINCT FROM NEW."siteId"
     OR OLD."workAreaId"      IS DISTINCT FROM NEW."workAreaId"
     OR OLD."checkInEventId"  IS DISTINCT FROM NEW."checkInEventId"
     OR OLD."checkOutEventId" IS DISTINCT FROM NEW."checkOutEventId"
     OR OLD."employeeId"      IS DISTINCT FROM NEW."employeeId"
     OR OLD."forceClosedByUserId" IS DISTINCT FROM NEW."forceClosedByUserId"
     OR OLD."forceClosedReason"   IS DISTINCT FROM NEW."forceClosedReason"
     OR OLD."forceClosedAt"       IS DISTINCT FROM NEW."forceClosedAt"
     OR OLD."endAtProvisional"    IS DISTINCT FROM NEW."endAtProvisional"
  THEN
    RAISE EXCEPTION 'CLOCK_SHIFT_IMMUTABLE_FIELD_CHANGED' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."materializationState" = 'MATERIALIZED' AND NEW."materializationState" = 'PENDING' THEN
    RAISE EXCEPTION 'CLOCK_SHIFT_MATERIALIZATION_STATE_CANNOT_REVERT' USING ERRCODE = 'P0001';
  END IF;

  IF OLD."materializationState" = 'PENDING' AND NEW."materializationState" = 'MATERIALIZED' THEN
    IF NOT EXISTS (SELECT 1 FROM "ClockShiftFragment" f WHERE f."clockShiftId" = NEW.id) THEN
      RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENTS_MISSING' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "ClockShiftFragment" f
      WHERE f."clockShiftId" = NEW.id
        AND (f."sourceAssignmentId" IS NULL OR f."reportedProjectionState" <> 'SETTLED')
    ) THEN
      RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_NOT_SETTLED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF OLD."sourceAssignmentId" IS NOT NULL AND NEW."sourceAssignmentId" IS DISTINCT FROM OLD."sourceAssignmentId" THEN
    RAISE EXCEPTION 'CLOCK_SHIFT_SOURCE_ASSIGNMENT_ALREADY_RESOLVED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_shift_immutable
  BEFORE UPDATE ON "ClockShift"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_shift_immutable();

-- fn_clock_shift_no_delete — §4.1: reused verbatim for ClockShift and ClockShiftFragment.
CREATE OR REPLACE FUNCTION fn_clock_shift_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CLOCK_SHIFT_NO_DELETE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_shift_no_delete
  BEFORE DELETE ON "ClockShift"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_shift_no_delete();

-- fn_clock_shift_fragment_immutable — §4.1: same narrow contract as ClockShift, single
-- allowed field (sourceAssignmentId), plus the one-way reportedProjectionState guard
-- with its PENDING->SETTLED prerequisite check ([3.2.5], issue 4).
CREATE OR REPLACE FUNCTION fn_clock_shift_fragment_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."id"               IS DISTINCT FROM NEW."id"
     OR OLD."createdAt"     IS DISTINCT FROM NEW."createdAt"
     OR OLD."recordedStartAt" IS DISTINCT FROM NEW."recordedStartAt"
     OR OLD."recordedEndAt"   IS DISTINCT FROM NEW."recordedEndAt"
     OR OLD."siteId"          IS DISTINCT FROM NEW."siteId"
     OR OLD."workAreaId"      IS DISTINCT FROM NEW."workAreaId"
     OR OLD."clockShiftId"    IS DISTINCT FROM NEW."clockShiftId"
     OR OLD."fragmentIndex"   IS DISTINCT FROM NEW."fragmentIndex"
     OR OLD."employeeId"      IS DISTINCT FROM NEW."employeeId"
     OR OLD."payrollPeriodId" IS DISTINCT FROM NEW."payrollPeriodId"
     OR OLD."timesheetId"     IS DISTINCT FROM NEW."timesheetId"
     OR OLD."date"            IS DISTINCT FROM NEW."date"
  THEN
    RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_IMMUTABLE_FIELD_CHANGED' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."sourceAssignmentId" IS NOT NULL AND NEW."sourceAssignmentId" IS DISTINCT FROM OLD."sourceAssignmentId" THEN
    RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_SOURCE_ASSIGNMENT_ALREADY_RESOLVED' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."reportedProjectionState" = 'SETTLED' AND NEW."reportedProjectionState" = 'PENDING' THEN
    RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_PROJECTION_STATE_CANNOT_REVERT' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."reportedProjectionState" = 'PENDING' AND NEW."reportedProjectionState" = 'SETTLED' THEN
    IF NEW."sourceAssignmentId" IS NULL THEN
      RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_SETTLED_WITHOUT_SOURCE_ASSIGNMENT' USING ERRCODE = 'P0001';
    END IF;
    IF NOT (
      EXISTS (
        SELECT 1
        FROM "TimesheetDraftSegment" s
        JOIN "TimesheetDraft" d ON d.id = s."draftId"
        WHERE s."originClockShiftFragmentId" = NEW.id
          AND d."timesheetId" = NEW."timesheetId"
          AND s."date" = NEW."date"
      )
      OR EXISTS (
        SELECT 1 FROM "Timesheet" t WHERE t.id = NEW."timesheetId" AND t.status = 'FINAL_APPROVED'
      )
    ) THEN
      RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_SETTLED_WITHOUT_PREREQUISITE' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_shift_fragment_immutable
  BEFORE UPDATE ON "ClockShiftFragment"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_shift_fragment_immutable();

CREATE TRIGGER trg_clock_shift_fragment_no_delete
  BEFORE DELETE ON "ClockShiftFragment"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_shift_no_delete();

-- fn_clock_shift_fragment_coverage_check — §2.1 п.7: STATEMENT-level, transition-table
-- coverage check (dense 0..N-1 fragmentIndex range, contiguous recordedStartAt/EndAt,
-- first fragment starts at shift start, last ends at shift end).
CREATE OR REPLACE FUNCTION fn_clock_shift_fragment_coverage_check() RETURNS trigger AS $$
DECLARE
  v_shift RECORD;
  v_touched_shift_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT "clockShiftId") INTO v_touched_shift_ids FROM new_rows;

  FOR v_shift IN
    SELECT cs.id, cs."recordedStartAt", cs."recordedEndAt"
    FROM "ClockShift" cs
    WHERE cs.id = ANY(v_touched_shift_ids)
  LOOP
    PERFORM 1
    FROM (
      SELECT "fragmentIndex", "recordedStartAt", "recordedEndAt",
             lag("recordedEndAt") OVER (ORDER BY "fragmentIndex")   AS prev_end,
             row_number() OVER (ORDER BY "fragmentIndex") - 1        AS expected_index
      FROM "ClockShiftFragment"
      WHERE "clockShiftId" = v_shift.id
    ) f
    WHERE f."fragmentIndex" != f.expected_index
       OR (f.prev_end IS NOT NULL AND f.prev_end != f."recordedStartAt")
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_COVERAGE_GAP_OR_OVERLAP' USING ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM "ClockShiftFragment"
    WHERE "clockShiftId" = v_shift.id AND "fragmentIndex" = 0
      AND "recordedStartAt" != v_shift."recordedStartAt";
    IF FOUND THEN
      RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_COVERAGE_START_MISMATCH' USING ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM "ClockShiftFragment"
    WHERE "clockShiftId" = v_shift.id
      AND "fragmentIndex" = (SELECT max("fragmentIndex") FROM "ClockShiftFragment" WHERE "clockShiftId" = v_shift.id)
      AND "recordedEndAt" != v_shift."recordedEndAt";
    IF FOUND THEN
      RAISE EXCEPTION 'CLOCK_SHIFT_FRAGMENT_COVERAGE_END_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_shift_fragment_coverage_check
  AFTER INSERT ON "ClockShiftFragment"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION fn_clock_shift_fragment_coverage_check();

-- fn_clock_event_location_no_update / fn_clock_event_location_retention_delete_guard
-- — §4.1 [3.1] (issue 7): UPDATE fully banned; DELETE only after the 90-day retention
-- window has elapsed.
CREATE OR REPLACE FUNCTION fn_clock_event_location_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CLOCK_EVENT_LOCATION_NO_UPDATE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_event_location_no_update
  BEFORE UPDATE ON "ClockEventLocation"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_event_location_no_update();

CREATE OR REPLACE FUNCTION fn_clock_event_location_retention_delete_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."createdAt" >= now() - interval '90 days' THEN
    RAISE EXCEPTION 'CLOCK_EVENT_LOCATION_RETENTION_WINDOW_NOT_ELAPSED' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clock_event_location_retention_delete_guard
  BEFORE DELETE ON "ClockEventLocation"
  FOR EACH ROW EXECUTE FUNCTION fn_clock_event_location_retention_delete_guard();

-- fn_company_attendance_policy_no_delete — §4.1 [3.1] (issue 7): the singleton row can
-- never be deleted (UPDATE of policy fields remains allowed — this is admin-editable
-- policy, not a historical fact).
CREATE OR REPLACE FUNCTION fn_company_attendance_policy_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'COMPANY_ATTENDANCE_POLICY_NO_DELETE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_company_attendance_policy_no_delete
  BEFORE DELETE ON "CompanyAttendancePolicy"
  FOR EACH ROW EXECUTE FUNCTION fn_company_attendance_policy_no_delete();

-- ---------------------------------------------------------------------------
-- Seeds — §2.1 п.11 (CompanyAttendancePolicy singleton), §13 (SYSTEM actor).
--
-- The SYSTEM user seed does NOT use ON CONFLICT DO NOTHING (fixed per 2026-08-12 review, item 2):
-- a bare ON CONFLICT ("username") DO NOTHING would silently succeed if a pre-existing HUMAN row
-- already happens to hold the username 'system.scheduler' — the migration would report success
-- while the SYSTEM-actor invariant (§13) silently fails to hold (zero SYSTEM users created). The
-- preflight check at the very top of this file (before any T7A DDL) fails the whole migration
-- loudly instead, with a stable identifier, and never mutates a pre-existing HUMAN row. Because
-- that preflight has already proven no row with a colliding username exists, the INSERT below is
-- a plain unconditional INSERT — if a conflict somehow still occurred here, it MUST surface as a
-- real 23505 unique_violation, not be swallowed.
-- CompanyAttendancePolicy's ON CONFLICT DO NOTHING is unaffected by this fix: unlike User,
-- CompanyAttendancePolicy is a brand-new table this same migration creates, so a pre-existing
-- conflicting row can only mean this exact migration already ran once — a benign re-apply, not a
-- collision with unrelated pre-existing data.
-- ---------------------------------------------------------------------------

INSERT INTO "User" ("username", "email", "passwordHash", "status", "locale", "twoFactorEnabled", "employeeId", "userKind", "updatedAt")
VALUES ('system.scheduler', NULL, NULL, 'DEACTIVATED', 'EN', false, NULL, 'SYSTEM', CURRENT_TIMESTAMP);

INSERT INTO "CompanyAttendancePolicy" ("singleton", "timezone", "cutoffDaysAfterPeriodEnd", "cutoffTime", "systemReopenDebounceMinutes", "maxShiftDurationHours", "updatedAt")
VALUES (true, 'Europe/Helsinki', 0, '23:59:00', 30, 16, CURRENT_TIMESTAMP)
ON CONFLICT ("singleton") DO NOTHING;

COMMIT;
