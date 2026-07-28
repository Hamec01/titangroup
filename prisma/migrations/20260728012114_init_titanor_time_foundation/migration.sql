-- Titanor Time — initial migration
-- Generated from prisma/schema.prisma (offline: prisma migrate diff --from-empty --to-schema-datamodel) plus
-- the current raw-SQL objects frozen in docs/titanor-time/05_RAW_SQL_REGISTER.md.
-- This migration.sql has NOT been applied to any PostgreSQL database.

-- ============================================================================
-- Section A — structural SQL matching prisma/schema.prisma (enums, tables, indexes, foreign keys)
-- ============================================================================

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('FI', 'EN', 'RU');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'OFFBOARDING', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "AbsenceType" AS ENUM ('SICK_LEAVE', 'VACATION', 'UNPAID_LEAVE', 'OTHER');

-- CreateEnum
CREATE TYPE "AbsenceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('OPEN', 'LOCKED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "TimesheetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'FOREMAN_APPROVED', 'FINAL_APPROVED');

-- CreateEnum
CREATE TYPE "DayType" AS ENUM ('WORK', 'SICK_LEAVE', 'VACATION', 'UNPAID_LEAVE', 'PUBLIC_HOLIDAY', 'OTHER');

-- CreateEnum
CREATE TYPE "TimesheetVersionSource" AS ENUM ('WORKER', 'CORRECTION');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "username" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255),
    "passwordHash" TEXT,
    "status" "UserStatus" NOT NULL,
    "locale" "Locale" NOT NULL,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "employeeId" UUID,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "deactivationReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Employment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Absence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "type" "AbsenceType" NOT NULL,
    "status" "AbsenceStatus" NOT NULL,
    "note" TEXT,
    "createdByUserId" UUID NOT NULL,
    "approvedByUserId" UUID,
    "approvedAt" TIMESTAMPTZ(6),
    "overlayAppliedDates" JSONB,
    "overlayConflicts" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Absence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "cityId" UUID,
    "address" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultForemanUserId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkArea" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkScheduleTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkScheduleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkScheduleTemplateVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "templateId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkScheduleTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkScheduleTemplateVersionDay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "templateVersionId" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "isWorkingDay" BOOLEAN NOT NULL,
    "plannedStartTime" TIME(0),
    "plannedEndTime" TIME(0),
    "plannedBreakMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkScheduleTemplateVersionDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "templateVersionId" UUID,
    "isPrimary" BOOLEAN NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "assignedByUserId" UUID NOT NULL,
    "endedReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SiteAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL,
    "openedByUserId" UUID NOT NULL,
    "lockedAt" TIMESTAMPTZ(6),
    "lockedByUserId" UUID,
    "exportedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriodParticipant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "periodId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "expected" BOOLEAN NOT NULL DEFAULT true,
    "exclusionReason" TEXT,
    "excludedByUserId" UUID,
    "excludedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollPeriodParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Timesheet" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "status" "TimesheetStatus" NOT NULL,
    "currentVersionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Timesheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetDraft" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "basedOnVersionId" UUID,
    "contentRevision" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimesheetDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetDraftDay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "dayType" "DayType" NOT NULL,
    "confirmedZero" BOOLEAN NOT NULL DEFAULT false,
    "sourceAbsenceId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimesheetDraftDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetDraftPlannedShift" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "siteId" UUID NOT NULL,
    "sourceAssignmentId" UUID NOT NULL,
    "templateVersionDayId" UUID,
    "plannedStartAt" TIMESTAMPTZ(6),
    "plannedEndAt" TIMESTAMPTZ(6),
    "plannedBreakMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetDraftPlannedShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetDraftSegment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftDayId" UUID NOT NULL,
    "draftId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6) NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "sourceAssignmentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimesheetDraftSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetDraftBreakSegment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftSegmentId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6) NOT NULL,
    "paid" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimesheetDraftBreakSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetVersion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "source" "TimesheetVersionSource" NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetDay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetVersionId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "dayType" "DayType" NOT NULL,
    "confirmedZero" BOOLEAN NOT NULL,
    "sourceAbsenceId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetPlannedShift" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetVersionId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "siteId" UUID NOT NULL,
    "sourceAssignmentId" UUID NOT NULL,
    "templateVersionDayId" UUID,
    "plannedStartAt" TIMESTAMPTZ(6),
    "plannedEndAt" TIMESTAMPTZ(6),
    "plannedBreakMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetPlannedShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkSegment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetDayId" UUID NOT NULL,
    "timesheetVersionId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6) NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "sourceAssignmentId" UUID NOT NULL,
    "crossesMidnight" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakSegment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workSegmentId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6) NOT NULL,
    "paid" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BreakSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeNumber_key" ON "Employee"("employeeNumber");

-- CreateIndex
CREATE INDEX "Employment_employeeId_active_idx" ON "Employment"("employeeId", "active");

-- CreateIndex
CREATE INDEX "Absence_employeeId_status_startDate_endDate_idx" ON "Absence"("employeeId", "status", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "City_name_key" ON "City"("name");

-- CreateIndex
CREATE INDEX "WorkSite_cityId_idx" ON "WorkSite"("cityId");

-- CreateIndex
CREATE INDEX "WorkSite_active_idx" ON "WorkSite"("active");

-- CreateIndex
CREATE INDEX "WorkArea_siteId_active_idx" ON "WorkArea"("siteId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "WorkArea_siteId_name_key" ON "WorkArea"("siteId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkArea_siteId_id_key" ON "WorkArea"("siteId", "id");

-- CreateIndex
CREATE INDEX "WorkScheduleTemplateVersion_createdByUserId_idx" ON "WorkScheduleTemplateVersion"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkScheduleTemplateVersion_templateId_versionNumber_key" ON "WorkScheduleTemplateVersion"("templateId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WorkScheduleTemplateVersionDay_templateVersionId_weekday_key" ON "WorkScheduleTemplateVersionDay"("templateVersionId", "weekday");

-- CreateIndex
CREATE INDEX "SiteAssignment_employeeId_validFrom_validTo_idx" ON "SiteAssignment"("employeeId", "validFrom", "validTo");

-- CreateIndex
CREATE INDEX "SiteAssignment_siteId_validFrom_validTo_idx" ON "SiteAssignment"("siteId", "validFrom", "validTo");

-- CreateIndex
CREATE INDEX "SiteAssignment_templateVersionId_idx" ON "SiteAssignment"("templateVersionId");

-- CreateIndex
CREATE INDEX "SiteAssignment_assignedByUserId_idx" ON "SiteAssignment"("assignedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteAssignment_id_employeeId_siteId_key" ON "SiteAssignment"("id", "employeeId", "siteId");

-- CreateIndex
CREATE INDEX "PayrollPeriod_status_startDate_endDate_idx" ON "PayrollPeriod"("status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "PayrollPeriodParticipant_employeeId_expected_idx" ON "PayrollPeriodParticipant"("employeeId", "expected");

-- CreateIndex
CREATE INDEX "PayrollPeriodParticipant_periodId_expected_idx" ON "PayrollPeriodParticipant"("periodId", "expected");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriodParticipant_periodId_employeeId_key" ON "PayrollPeriodParticipant"("periodId", "employeeId");

-- CreateIndex
CREATE INDEX "Timesheet_periodId_status_idx" ON "Timesheet"("periodId", "status");

-- CreateIndex
CREATE INDEX "Timesheet_currentVersionId_idx" ON "Timesheet"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Timesheet_employeeId_periodId_key" ON "Timesheet"("employeeId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "Timesheet_id_employeeId_key" ON "Timesheet"("id", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraft_timesheetId_key" ON "TimesheetDraft"("timesheetId");

-- CreateIndex
CREATE INDEX "TimesheetDraft_timesheetId_employeeId_idx" ON "TimesheetDraft"("timesheetId", "employeeId");

-- CreateIndex
CREATE INDEX "TimesheetDraft_basedOnVersionId_idx" ON "TimesheetDraft"("basedOnVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraft_id_employeeId_key" ON "TimesheetDraft"("id", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraft_timesheetId_employeeId_key" ON "TimesheetDraft"("timesheetId", "employeeId");

-- CreateIndex
CREATE INDEX "TimesheetDraftDay_sourceAbsenceId_idx" ON "TimesheetDraftDay"("sourceAbsenceId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraftDay_draftId_date_key" ON "TimesheetDraftDay"("draftId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraftDay_id_draftId_key" ON "TimesheetDraftDay"("id", "draftId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraftDay_id_draftId_date_key" ON "TimesheetDraftDay"("id", "draftId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraftDay_id_date_key" ON "TimesheetDraftDay"("id", "date");

-- CreateIndex
CREATE INDEX "TimesheetDraftPlannedShift_draftId_employeeId_idx" ON "TimesheetDraftPlannedShift"("draftId", "employeeId");

-- CreateIndex
CREATE INDEX "TimesheetDraftPlannedShift_siteId_date_idx" ON "TimesheetDraftPlannedShift"("siteId", "date");

-- CreateIndex
CREATE INDEX "TimesheetDraftPlannedShift_sourceAssignmentId_employeeId_si_idx" ON "TimesheetDraftPlannedShift"("sourceAssignmentId", "employeeId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDraftPlannedShift_draftId_date_sourceAssignmentId_key" ON "TimesheetDraftPlannedShift"("draftId", "date", "sourceAssignmentId");

-- CreateIndex
CREATE INDEX "TimesheetDraftSegment_draftDayId_draftId_idx" ON "TimesheetDraftSegment"("draftDayId", "draftId");

-- CreateIndex
CREATE INDEX "TimesheetDraftSegment_draftId_employeeId_idx" ON "TimesheetDraftSegment"("draftId", "employeeId");

-- CreateIndex
CREATE INDEX "TimesheetDraftSegment_draftId_date_sourceAssignmentId_idx" ON "TimesheetDraftSegment"("draftId", "date", "sourceAssignmentId");

-- CreateIndex
CREATE INDEX "TimesheetDraftSegment_sourceAssignmentId_employeeId_siteId_idx" ON "TimesheetDraftSegment"("sourceAssignmentId", "employeeId", "siteId");

-- CreateIndex
CREATE INDEX "TimesheetDraftSegment_siteId_date_idx" ON "TimesheetDraftSegment"("siteId", "date");

-- CreateIndex
CREATE INDEX "TimesheetDraftBreakSegment_draftSegmentId_idx" ON "TimesheetDraftBreakSegment"("draftSegmentId");

-- CreateIndex
CREATE INDEX "TimesheetVersion_timesheetId_employeeId_idx" ON "TimesheetVersion"("timesheetId", "employeeId");

-- CreateIndex
CREATE INDEX "TimesheetVersion_createdByUserId_idx" ON "TimesheetVersion"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetVersion_timesheetId_versionNumber_key" ON "TimesheetVersion"("timesheetId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetVersion_id_employeeId_key" ON "TimesheetVersion"("id", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetVersion_id_timesheetId_key" ON "TimesheetVersion"("id", "timesheetId");

-- CreateIndex
CREATE INDEX "TimesheetDay_sourceAbsenceId_idx" ON "TimesheetDay"("sourceAbsenceId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDay_timesheetVersionId_date_key" ON "TimesheetDay"("timesheetVersionId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDay_id_timesheetVersionId_key" ON "TimesheetDay"("id", "timesheetVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDay_id_timesheetVersionId_date_key" ON "TimesheetDay"("id", "timesheetVersionId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetDay_id_date_key" ON "TimesheetDay"("id", "date");

-- CreateIndex
CREATE INDEX "TimesheetPlannedShift_timesheetVersionId_employeeId_idx" ON "TimesheetPlannedShift"("timesheetVersionId", "employeeId");

-- CreateIndex
CREATE INDEX "TimesheetPlannedShift_siteId_date_idx" ON "TimesheetPlannedShift"("siteId", "date");

-- CreateIndex
CREATE INDEX "TimesheetPlannedShift_sourceAssignmentId_employeeId_siteId_idx" ON "TimesheetPlannedShift"("sourceAssignmentId", "employeeId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetPlannedShift_timesheetVersionId_date_sourceAssignm_key" ON "TimesheetPlannedShift"("timesheetVersionId", "date", "sourceAssignmentId");

-- CreateIndex
CREATE INDEX "WorkSegment_timesheetDayId_timesheetVersionId_idx" ON "WorkSegment"("timesheetDayId", "timesheetVersionId");

-- CreateIndex
CREATE INDEX "WorkSegment_timesheetVersionId_employeeId_idx" ON "WorkSegment"("timesheetVersionId", "employeeId");

-- CreateIndex
CREATE INDEX "WorkSegment_timesheetVersionId_date_sourceAssignmentId_idx" ON "WorkSegment"("timesheetVersionId", "date", "sourceAssignmentId");

-- CreateIndex
CREATE INDEX "WorkSegment_sourceAssignmentId_employeeId_siteId_idx" ON "WorkSegment"("sourceAssignmentId", "employeeId", "siteId");

-- CreateIndex
CREATE INDEX "WorkSegment_siteId_date_idx" ON "WorkSegment"("siteId", "date");

-- CreateIndex
CREATE INDEX "BreakSegment_workSegmentId_idx" ON "BreakSegment"("workSegmentId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employment" ADD CONSTRAINT "Employment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Absence" ADD CONSTRAINT "Absence_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSite" ADD CONSTRAINT "WorkSite_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSite" ADD CONSTRAINT "WorkSite_defaultForemanUserId_fkey" FOREIGN KEY ("defaultForemanUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkArea" ADD CONSTRAINT "WorkArea_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkScheduleTemplateVersion" ADD CONSTRAINT "WorkScheduleTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WorkScheduleTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkScheduleTemplateVersion" ADD CONSTRAINT "WorkScheduleTemplateVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkScheduleTemplateVersionDay" ADD CONSTRAINT "WorkScheduleTemplateVersionDay_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "WorkScheduleTemplateVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAssignment" ADD CONSTRAINT "SiteAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAssignment" ADD CONSTRAINT "SiteAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAssignment" ADD CONSTRAINT "SiteAssignment_siteId_workAreaId_fkey" FOREIGN KEY ("siteId", "workAreaId") REFERENCES "WorkArea"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAssignment" ADD CONSTRAINT "SiteAssignment_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "WorkScheduleTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAssignment" ADD CONSTRAINT "SiteAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_openedByUserId_fkey" FOREIGN KEY ("openedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_lockedByUserId_fkey" FOREIGN KEY ("lockedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriodParticipant" ADD CONSTRAINT "PayrollPeriodParticipant_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriodParticipant" ADD CONSTRAINT "PayrollPeriodParticipant_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriodParticipant" ADD CONSTRAINT "PayrollPeriodParticipant_excludedByUserId_fkey" FOREIGN KEY ("excludedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_periodId_employeeId_fkey" FOREIGN KEY ("periodId", "employeeId") REFERENCES "PayrollPeriodParticipant"("periodId", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Timesheet" ADD CONSTRAINT "Timesheet_currentVersionId_id_fkey" FOREIGN KEY ("currentVersionId", "id") REFERENCES "TimesheetVersion"("id", "timesheetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraft" ADD CONSTRAINT "TimesheetDraft_timesheetId_employeeId_fkey" FOREIGN KEY ("timesheetId", "employeeId") REFERENCES "Timesheet"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraft" ADD CONSTRAINT "TimesheetDraft_basedOnVersionId_timesheetId_fkey" FOREIGN KEY ("basedOnVersionId", "timesheetId") REFERENCES "TimesheetVersion"("id", "timesheetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftDay" ADD CONSTRAINT "TimesheetDraftDay_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "TimesheetDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftDay" ADD CONSTRAINT "TimesheetDraftDay_sourceAbsenceId_fkey" FOREIGN KEY ("sourceAbsenceId") REFERENCES "Absence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftPlannedShift" ADD CONSTRAINT "TimesheetDraftPlannedShift_draftId_employeeId_fkey" FOREIGN KEY ("draftId", "employeeId") REFERENCES "TimesheetDraft"("id", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftPlannedShift" ADD CONSTRAINT "TimesheetDraftPlannedShift_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftPlannedShift" ADD CONSTRAINT "TimesheetDraftPlannedShift_sourceAssignmentId_employeeId_s_fkey" FOREIGN KEY ("sourceAssignmentId", "employeeId", "siteId") REFERENCES "SiteAssignment"("id", "employeeId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftPlannedShift" ADD CONSTRAINT "TimesheetDraftPlannedShift_templateVersionDayId_fkey" FOREIGN KEY ("templateVersionDayId") REFERENCES "WorkScheduleTemplateVersionDay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftSegment" ADD CONSTRAINT "TimesheetDraftSegment_draftDayId_draftId_date_fkey" FOREIGN KEY ("draftDayId", "draftId", "date") REFERENCES "TimesheetDraftDay"("id", "draftId", "date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftSegment" ADD CONSTRAINT "TimesheetDraftSegment_draftId_employeeId_fkey" FOREIGN KEY ("draftId", "employeeId") REFERENCES "TimesheetDraft"("id", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftSegment" ADD CONSTRAINT "TimesheetDraftSegment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftSegment" ADD CONSTRAINT "TimesheetDraftSegment_siteId_workAreaId_fkey" FOREIGN KEY ("siteId", "workAreaId") REFERENCES "WorkArea"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftSegment" ADD CONSTRAINT "TimesheetDraftSegment_sourceAssignmentId_employeeId_siteId_fkey" FOREIGN KEY ("sourceAssignmentId", "employeeId", "siteId") REFERENCES "SiteAssignment"("id", "employeeId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftSegment" ADD CONSTRAINT "TimesheetDraftSegment_draftId_date_sourceAssignmentId_fkey" FOREIGN KEY ("draftId", "date", "sourceAssignmentId") REFERENCES "TimesheetDraftPlannedShift"("draftId", "date", "sourceAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDraftBreakSegment" ADD CONSTRAINT "TimesheetDraftBreakSegment_draftSegmentId_fkey" FOREIGN KEY ("draftSegmentId") REFERENCES "TimesheetDraftSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetVersion" ADD CONSTRAINT "TimesheetVersion_timesheetId_employeeId_fkey" FOREIGN KEY ("timesheetId", "employeeId") REFERENCES "Timesheet"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetVersion" ADD CONSTRAINT "TimesheetVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDay" ADD CONSTRAINT "TimesheetDay_timesheetVersionId_fkey" FOREIGN KEY ("timesheetVersionId") REFERENCES "TimesheetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetDay" ADD CONSTRAINT "TimesheetDay_sourceAbsenceId_fkey" FOREIGN KEY ("sourceAbsenceId") REFERENCES "Absence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetPlannedShift" ADD CONSTRAINT "TimesheetPlannedShift_timesheetVersionId_employeeId_fkey" FOREIGN KEY ("timesheetVersionId", "employeeId") REFERENCES "TimesheetVersion"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetPlannedShift" ADD CONSTRAINT "TimesheetPlannedShift_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetPlannedShift" ADD CONSTRAINT "TimesheetPlannedShift_sourceAssignmentId_employeeId_siteId_fkey" FOREIGN KEY ("sourceAssignmentId", "employeeId", "siteId") REFERENCES "SiteAssignment"("id", "employeeId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetPlannedShift" ADD CONSTRAINT "TimesheetPlannedShift_templateVersionDayId_fkey" FOREIGN KEY ("templateVersionDayId") REFERENCES "WorkScheduleTemplateVersionDay"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_timesheetDayId_timesheetVersionId_date_fkey" FOREIGN KEY ("timesheetDayId", "timesheetVersionId", "date") REFERENCES "TimesheetDay"("id", "timesheetVersionId", "date") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_timesheetVersionId_employeeId_fkey" FOREIGN KEY ("timesheetVersionId", "employeeId") REFERENCES "TimesheetVersion"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_siteId_workAreaId_fkey" FOREIGN KEY ("siteId", "workAreaId") REFERENCES "WorkArea"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_sourceAssignmentId_employeeId_siteId_fkey" FOREIGN KEY ("sourceAssignmentId", "employeeId", "siteId") REFERENCES "SiteAssignment"("id", "employeeId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSegment" ADD CONSTRAINT "WorkSegment_timesheetVersionId_date_sourceAssignmentId_fkey" FOREIGN KEY ("timesheetVersionId", "date", "sourceAssignmentId") REFERENCES "TimesheetPlannedShift"("timesheetVersionId", "date", "sourceAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakSegment" ADD CONSTRAINT "BreakSegment_workSegmentId_fkey" FOREIGN KEY ("workSegmentId") REFERENCES "WorkSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Section B — current raw-SQL objects from docs/titanor-time/05_RAW_SQL_REGISTER.md
-- ============================================================================

-- ============================================================================
-- Titanor Time — frozen raw-SQL objects
-- Source of truth: docs/titanor-time/05_RAW_SQL_REGISTER.md (Status: FROZEN)
-- Scope: current foundation initial migration only.
-- Excludes: CK-F01 (CorrectionRequest.approvalOverride) and all future
-- correction/review-layer objects — CorrectionRequest/CorrectionDraft* and
-- TimesheetReviewProposal do not exist in the current foundation schema.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- EXT-01 — required PostgreSQL extension
-- Reason: scalar uuid equality operators inside GiST-backed EXCLUDE
-- constraints (EX-01..EX-06) require the operator class btree_gist provides.
-- ----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ----------------------------------------------------------------------------
-- Section 1 — Current CHECK constraint register (CK-01..CK-21)
-- ----------------------------------------------------------------------------

-- CK-01 ck_employment_date_range
ALTER TABLE "Employment"
  ADD CONSTRAINT "ck_employment_date_range"
  CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

-- CK-02 ck_employment_inactive_metadata_shape
ALTER TABLE "Employment"
  ADD CONSTRAINT "ck_employment_inactive_metadata_shape"
  CHECK (
    "active" = true
    OR (
      "active" = false
      AND "endDate" IS NOT NULL
      AND "deactivationReason" IS NOT NULL
    )
  );

-- CK-03 ck_absence_date_range
ALTER TABLE "Absence"
  ADD CONSTRAINT "ck_absence_date_range"
  CHECK ("endDate" >= "startDate");

-- CK-04 ck_absence_status_metadata_shape
ALTER TABLE "Absence"
  ADD CONSTRAINT "ck_absence_status_metadata_shape"
  CHECK (
    (
      "status" = 'PENDING'
      AND "approvedByUserId" IS NULL
      AND "approvedAt" IS NULL
      AND "overlayAppliedDates" IS NULL
      AND "overlayConflicts" IS NULL
    )
    OR (
      "status" = 'REJECTED'
      AND "approvedByUserId" IS NULL
      AND "approvedAt" IS NULL
      AND "overlayAppliedDates" IS NULL
      AND "overlayConflicts" IS NULL
    )
    OR (
      "status" = 'APPROVED'
      AND "approvedByUserId" IS NOT NULL
      AND "approvedAt" IS NOT NULL
      AND "overlayAppliedDates" IS NOT NULL
      AND jsonb_typeof("overlayAppliedDates") = 'array'
      AND "overlayConflicts" IS NOT NULL
      AND jsonb_typeof("overlayConflicts") = 'array'
    )
  );

-- CK-05 ck_site_assignment_date_range
ALTER TABLE "SiteAssignment"
  ADD CONSTRAINT "ck_site_assignment_date_range"
  CHECK ("validTo" IS NULL OR "validTo" >= "validFrom");

-- CK-06 ck_work_schedule_template_version_day_weekday_range
ALTER TABLE "WorkScheduleTemplateVersionDay"
  ADD CONSTRAINT "ck_work_schedule_template_version_day_weekday_range"
  CHECK ("weekday" BETWEEN 0 AND 6);

-- CK-07 ck_work_schedule_template_version_day_shape
ALTER TABLE "WorkScheduleTemplateVersionDay"
  ADD CONSTRAINT "ck_work_schedule_template_version_day_shape"
  CHECK (
    (
      "isWorkingDay" = true
      AND "plannedStartTime" IS NOT NULL
      AND "plannedEndTime" IS NOT NULL
    )
    OR (
      "isWorkingDay" = false
      AND "plannedStartTime" IS NULL
      AND "plannedEndTime" IS NULL
      AND "plannedBreakMinutes" = 0
    )
  );

-- CK-08 ck_schedule_template_version_day_break_minutes_nonnegative
ALTER TABLE "WorkScheduleTemplateVersionDay"
  ADD CONSTRAINT "ck_schedule_template_version_day_break_minutes_nonnegative"
  CHECK ("plannedBreakMinutes" >= 0);

-- CK-09 ck_payroll_period_date_range
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "ck_payroll_period_date_range"
  CHECK ("endDate" >= "startDate");

-- CK-10 ck_payroll_period_status_metadata_shape
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "ck_payroll_period_status_metadata_shape"
  CHECK (
    (
      "status" = 'OPEN'
      AND "lockedAt" IS NULL
      AND "lockedByUserId" IS NULL
      AND "exportedAt" IS NULL
    )
    OR (
      "status" = 'LOCKED'
      AND "lockedAt" IS NOT NULL
      AND "lockedByUserId" IS NOT NULL
      AND "exportedAt" IS NULL
    )
    OR (
      "status" = 'EXPORTED'
      AND "lockedAt" IS NOT NULL
      AND "lockedByUserId" IS NOT NULL
      AND "exportedAt" IS NOT NULL
    )
  );

-- CK-11 ck_payroll_period_participant_exclusion_metadata_shape
ALTER TABLE "PayrollPeriodParticipant"
  ADD CONSTRAINT "ck_payroll_period_participant_exclusion_metadata_shape"
  CHECK (
    (
      "expected" = true
      AND "exclusionReason" IS NULL
      AND "excludedByUserId" IS NULL
      AND "excludedAt" IS NULL
    )
    OR (
      "expected" = false
      AND "exclusionReason" IS NOT NULL
      AND "excludedByUserId" IS NOT NULL
      AND "excludedAt" IS NOT NULL
    )
  );

-- CK-12 ck_timesheet_draft_planned_shift_shape
ALTER TABLE "TimesheetDraftPlannedShift"
  ADD CONSTRAINT "ck_timesheet_draft_planned_shift_shape"
  CHECK (
    (
      "plannedStartAt" IS NOT NULL
      AND "plannedEndAt" IS NOT NULL
      AND "plannedEndAt" > "plannedStartAt"
    )
    OR (
      "plannedStartAt" IS NULL
      AND "plannedEndAt" IS NULL
      AND "plannedBreakMinutes" = 0
    )
  );

-- CK-13 ck_timesheet_draft_shift_break_minutes_nonnegative
ALTER TABLE "TimesheetDraftPlannedShift"
  ADD CONSTRAINT "ck_timesheet_draft_shift_break_minutes_nonnegative"
  CHECK ("plannedBreakMinutes" >= 0);

-- CK-14 ck_timesheet_draft_segment_interval
ALTER TABLE "TimesheetDraftSegment"
  ADD CONSTRAINT "ck_timesheet_draft_segment_interval"
  CHECK ("endAt" > "startAt");

-- CK-15 ck_timesheet_draft_segment_local_date
ALTER TABLE "TimesheetDraftSegment"
  ADD CONSTRAINT "ck_timesheet_draft_segment_local_date"
  CHECK ("date" = ("startAt" AT TIME ZONE 'Europe/Helsinki')::date);

-- CK-16 ck_timesheet_draft_break_segment_interval
ALTER TABLE "TimesheetDraftBreakSegment"
  ADD CONSTRAINT "ck_timesheet_draft_break_segment_interval"
  CHECK ("endAt" > "startAt");

-- CK-17 ck_timesheet_planned_shift_shape
ALTER TABLE "TimesheetPlannedShift"
  ADD CONSTRAINT "ck_timesheet_planned_shift_shape"
  CHECK (
    (
      "plannedStartAt" IS NOT NULL
      AND "plannedEndAt" IS NOT NULL
      AND "plannedEndAt" > "plannedStartAt"
    )
    OR (
      "plannedStartAt" IS NULL
      AND "plannedEndAt" IS NULL
      AND "plannedBreakMinutes" = 0
    )
  );

-- CK-18 ck_timesheet_planned_shift_planned_break_minutes_nonnegative
ALTER TABLE "TimesheetPlannedShift"
  ADD CONSTRAINT "ck_timesheet_planned_shift_planned_break_minutes_nonnegative"
  CHECK ("plannedBreakMinutes" >= 0);

-- CK-19 ck_work_segment_interval
ALTER TABLE "WorkSegment"
  ADD CONSTRAINT "ck_work_segment_interval"
  CHECK ("endAt" > "startAt");

-- CK-20 ck_work_segment_local_date
ALTER TABLE "WorkSegment"
  ADD CONSTRAINT "ck_work_segment_local_date"
  CHECK ("date" = ("startAt" AT TIME ZONE 'Europe/Helsinki')::date);

-- CK-21 ck_break_segment_interval
ALTER TABLE "BreakSegment"
  ADD CONSTRAINT "ck_break_segment_interval"
  CHECK ("endAt" > "startAt");

-- ----------------------------------------------------------------------------
-- Section 3 — Current EXCLUDE constraint register (EX-01..EX-06)
-- ----------------------------------------------------------------------------

-- EX-01 ex_absence_active_date_overlap
ALTER TABLE "Absence"
  ADD CONSTRAINT "ex_absence_active_date_overlap"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    daterange("startDate", "endDate" + 1, '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'APPROVED'));

-- EX-02 ex_site_assignment_scope_date_overlap
ALTER TABLE "SiteAssignment"
  ADD CONSTRAINT "ex_site_assignment_scope_date_overlap"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    "siteId" WITH =,
    COALESCE("workAreaId", '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    daterange("validFrom", COALESCE("validTo" + 1, 'infinity'::date), '[)') WITH &&
  );

-- EX-03 ex_payroll_period_date_overlap
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "ex_payroll_period_date_overlap"
  EXCLUDE USING gist (
    daterange("startDate", "endDate" + 1, '[)') WITH &&
  );

-- EX-04 ex_timesheet_draft_segment_time_overlap
ALTER TABLE "TimesheetDraftSegment"
  ADD CONSTRAINT "ex_timesheet_draft_segment_time_overlap"
  EXCLUDE USING gist (
    "draftId" WITH =,
    "employeeId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  );

-- EX-05 ex_timesheet_draft_break_segment_time_overlap
ALTER TABLE "TimesheetDraftBreakSegment"
  ADD CONSTRAINT "ex_timesheet_draft_break_segment_time_overlap"
  EXCLUDE USING gist (
    "draftSegmentId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  );

-- EX-06 ex_break_segment_time_overlap
ALTER TABLE "BreakSegment"
  ADD CONSTRAINT "ex_break_segment_time_overlap"
  EXCLUDE USING gist (
    "workSegmentId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  );

-- ----------------------------------------------------------------------------
-- Section 5 — Trigger function register (FN-01..FN-11)
-- ----------------------------------------------------------------------------

-- FN-01 fn_segment_assignment_scope_check
-- Affected tables: TimesheetDraftSegment, WorkSegment.
-- Row-lock: SiteAssignment FOR SHARE before reading its scope/validity.
CREATE OR REPLACE FUNCTION fn_segment_assignment_scope_check()
RETURNS trigger AS $$
DECLARE
  v_assignment RECORD;
BEGIN
  SELECT "employeeId", "siteId", "validFrom", "validTo"
    INTO v_assignment
    FROM "SiteAssignment"
    WHERE "id" = NEW."sourceAssignmentId"
    FOR SHARE;

  IF v_assignment."employeeId" IS DISTINCT FROM NEW."employeeId"
     OR v_assignment."siteId" IS DISTINCT FROM NEW."siteId" THEN
    RAISE EXCEPTION 'ASSIGNMENT_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF NEW."workAreaId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "WorkArea"
      WHERE "id" = NEW."workAreaId" AND "siteId" = v_assignment."siteId"
    ) THEN
      RAISE EXCEPTION 'ASSIGNMENT_SCOPE_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW."date" < v_assignment."validFrom"
     OR (v_assignment."validTo" IS NOT NULL AND NEW."date" > v_assignment."validTo") THEN
    RAISE EXCEPTION 'ASSIGNMENT_DATE_OUTSIDE_VALIDITY' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-02 fn_planned_shift_validity_check
-- Affected tables: TimesheetDraftPlannedShift, TimesheetPlannedShift.
-- Row-lock: SiteAssignment FOR SHARE before reading its validity.
CREATE OR REPLACE FUNCTION fn_planned_shift_validity_check()
RETURNS trigger AS $$
DECLARE
  v_assignment RECORD;
BEGIN
  SELECT "validFrom", "validTo"
    INTO v_assignment
    FROM "SiteAssignment"
    WHERE "id" = NEW."sourceAssignmentId"
    FOR SHARE;

  IF NEW."date" < v_assignment."validFrom"
     OR (v_assignment."validTo" IS NOT NULL AND NEW."date" > v_assignment."validTo") THEN
    RAISE EXCEPTION 'PLANNED_SHIFT_OUTSIDE_ASSIGNMENT_VALIDITY' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-03 fn_timesheet_draft_day_state_check (day-side, TimesheetDraftDay)
-- Row-lock: target day row already locked by the UPDATE itself.
CREATE OR REPLACE FUNCTION fn_timesheet_draft_day_state_check()
RETURNS trigger AS $$
DECLARE
  v_segment_count integer;
BEGIN
  SELECT count(*) INTO v_segment_count
    FROM "TimesheetDraftSegment"
    WHERE "draftDayId" = OLD."id";

  IF v_segment_count > 0 THEN
    IF NEW."dayType" <> 'WORK' THEN
      RAISE EXCEPTION 'DAY_TYPE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."confirmedZero" THEN
      RAISE EXCEPTION 'DAY_STATE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW."confirmedZero" AND NEW."dayType" <> 'WORK' THEN
    RAISE EXCEPTION 'DAY_STATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-04 fn_timesheet_draft_segment_day_state_check (child-side, TimesheetDraftSegment)
-- Row-lock: parent TimesheetDraftDay FOR UPDATE, first action, before reading dayType/confirmedZero.
CREATE OR REPLACE FUNCTION fn_timesheet_draft_segment_day_state_check()
RETURNS trigger AS $$
DECLARE
  v_day RECORD;
BEGIN
  SELECT "dayType", "confirmedZero"
    INTO v_day
    FROM "TimesheetDraftDay"
    WHERE "id" = NEW."draftDayId"
    FOR UPDATE;

  IF v_day."dayType" <> 'WORK' THEN
    RAISE EXCEPTION 'DAY_TYPE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF v_day."confirmedZero" THEN
    RAISE EXCEPTION 'DAY_STATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-05 fn_timesheet_day_state_check (day-side, TimesheetDay)
-- Row-lock: target day row already locked by the UPDATE itself.
CREATE OR REPLACE FUNCTION fn_timesheet_day_state_check()
RETURNS trigger AS $$
DECLARE
  v_segment_count integer;
BEGIN
  SELECT count(*) INTO v_segment_count
    FROM "WorkSegment"
    WHERE "timesheetDayId" = OLD."id";

  IF v_segment_count > 0 THEN
    IF NEW."dayType" <> 'WORK' THEN
      RAISE EXCEPTION 'DAY_TYPE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."confirmedZero" THEN
      RAISE EXCEPTION 'DAY_STATE_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW."confirmedZero" AND NEW."dayType" <> 'WORK' THEN
    RAISE EXCEPTION 'DAY_STATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-06 fn_work_segment_day_state_check (child-side, WorkSegment)
-- Row-lock: parent TimesheetDay FOR UPDATE, first action, before reading dayType/confirmedZero.
CREATE OR REPLACE FUNCTION fn_work_segment_day_state_check()
RETURNS trigger AS $$
DECLARE
  v_day RECORD;
BEGIN
  SELECT "dayType", "confirmedZero"
    INTO v_day
    FROM "TimesheetDay"
    WHERE "id" = NEW."timesheetDayId"
    FOR UPDATE;

  IF v_day."dayType" <> 'WORK' THEN
    RAISE EXCEPTION 'DAY_TYPE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF v_day."confirmedZero" THEN
    RAISE EXCEPTION 'DAY_STATE_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-07 fn_timesheet_draft_break_segment_containment_check
-- Child: TimesheetDraftBreakSegment. Parent: TimesheetDraftSegment.
-- Row-lock: parent segment FOR UPDATE, first action.
CREATE OR REPLACE FUNCTION fn_timesheet_draft_break_segment_containment_check()
RETURNS trigger AS $$
DECLARE
  v_parent RECORD;
BEGIN
  SELECT "startAt", "endAt"
    INTO v_parent
    FROM "TimesheetDraftSegment"
    WHERE "id" = NEW."draftSegmentId"
    FOR UPDATE;

  IF v_parent."startAt" > NEW."startAt" OR NEW."endAt" > v_parent."endAt" THEN
    RAISE EXCEPTION 'BREAK_OUTSIDE_PARENT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-08 fn_break_segment_containment_check
-- Child: BreakSegment. Parent: WorkSegment.
-- Row-lock: parent segment FOR UPDATE, first action.
CREATE OR REPLACE FUNCTION fn_break_segment_containment_check()
RETURNS trigger AS $$
DECLARE
  v_parent RECORD;
BEGIN
  SELECT "startAt", "endAt"
    INTO v_parent
    FROM "WorkSegment"
    WHERE "id" = NEW."workSegmentId"
    FOR UPDATE;

  IF v_parent."startAt" > NEW."startAt" OR NEW."endAt" > v_parent."endAt" THEN
    RAISE EXCEPTION 'BREAK_OUTSIDE_PARENT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-09 fn_site_assignment_dependents_guard — DEC-01
-- Serializing point: the SiteAssignment row being updated itself.
-- Does not take row locks on dependent rows (defense-in-depth boundary check only).
-- CorrectionDraftSegment is out of current scope and is not checked here.
CREATE OR REPLACE FUNCTION fn_site_assignment_dependents_guard()
RETURNS trigger AS $$
DECLARE
  v_valid_to date;
BEGIN
  v_valid_to := COALESCE(NEW."validTo", 'infinity'::date);

  IF EXISTS (
    SELECT 1 FROM "WorkSegment"
    WHERE "sourceAssignmentId" = NEW."id"
      AND ("date" < NEW."validFrom" OR "date" > v_valid_to)
  ) THEN
    RAISE EXCEPTION 'ASSIGNMENT_DEPENDENTS_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "TimesheetPlannedShift"
    WHERE "sourceAssignmentId" = NEW."id"
      AND ("date" < NEW."validFrom" OR "date" > v_valid_to)
  ) THEN
    RAISE EXCEPTION 'ASSIGNMENT_DEPENDENTS_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "TimesheetDraftSegment"
    WHERE "sourceAssignmentId" = NEW."id"
      AND ("date" < NEW."validFrom" OR "date" > v_valid_to)
  ) THEN
    RAISE EXCEPTION 'ASSIGNMENT_DEPENDENTS_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "TimesheetDraftPlannedShift"
    WHERE "sourceAssignmentId" = NEW."id"
      AND ("date" < NEW."validFrom" OR "date" > v_valid_to)
  ) THEN
    RAISE EXCEPTION 'ASSIGNMENT_DEPENDENTS_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-10 fn_timesheet_draft_segment_breaks_guard — DEC-02 (parent-side)
-- Parent: TimesheetDraftSegment. Child: TimesheetDraftBreakSegment.
-- Does not lock child break rows (FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE forbidden).
CREATE OR REPLACE FUNCTION fn_timesheet_draft_segment_breaks_guard()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "TimesheetDraftBreakSegment"
    WHERE "draftSegmentId" = NEW."id"
      AND (NEW."startAt" > "startAt" OR "endAt" > NEW."endAt")
  ) THEN
    RAISE EXCEPTION 'BREAK_OUTSIDE_PARENT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FN-11 fn_work_segment_breaks_guard — DEC-02 (parent-side)
-- Parent: WorkSegment. Child: BreakSegment.
-- Does not lock child break rows (FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE forbidden).
CREATE OR REPLACE FUNCTION fn_work_segment_breaks_guard()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BreakSegment"
    WHERE "workSegmentId" = NEW."id"
      AND (NEW."startAt" > "startAt" OR "endAt" > NEW."endAt")
  ) THEN
    RAISE EXCEPTION 'BREAK_OUTSIDE_PARENT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Section 6 — Trigger instance register (TRG-01..TRG-13)
-- Full identity is table + trigger name; repeated trigger names on different
-- tables (trg_segment_assignment_scope_check, trg_planned_shift_validity_check)
-- are intentional — PostgreSQL requires trigger-name uniqueness per table, not globally.
-- ----------------------------------------------------------------------------

-- TRG-01
CREATE TRIGGER trg_segment_assignment_scope_check
  BEFORE INSERT OR UPDATE OF "sourceAssignmentId", "employeeId", "date", "siteId", "workAreaId"
  ON "TimesheetDraftSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_segment_assignment_scope_check();

-- TRG-02
CREATE TRIGGER trg_segment_assignment_scope_check
  BEFORE INSERT OR UPDATE OF "sourceAssignmentId", "employeeId", "date", "siteId", "workAreaId"
  ON "WorkSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_segment_assignment_scope_check();

-- TRG-03
CREATE TRIGGER trg_planned_shift_validity_check
  BEFORE INSERT OR UPDATE OF "sourceAssignmentId", "employeeId", "siteId", "date", "plannedStartAt", "plannedEndAt"
  ON "TimesheetDraftPlannedShift"
  FOR EACH ROW
  EXECUTE FUNCTION fn_planned_shift_validity_check();

-- TRG-04
CREATE TRIGGER trg_planned_shift_validity_check
  BEFORE INSERT OR UPDATE OF "sourceAssignmentId", "employeeId", "siteId", "date", "plannedStartAt", "plannedEndAt"
  ON "TimesheetPlannedShift"
  FOR EACH ROW
  EXECUTE FUNCTION fn_planned_shift_validity_check();

-- TRG-05
CREATE TRIGGER trg_timesheet_draft_day_state_check
  BEFORE UPDATE OF "dayType", "confirmedZero"
  ON "TimesheetDraftDay"
  FOR EACH ROW
  WHEN (OLD."dayType" IS DISTINCT FROM NEW."dayType" OR OLD."confirmedZero" IS DISTINCT FROM NEW."confirmedZero")
  EXECUTE FUNCTION fn_timesheet_draft_day_state_check();

-- TRG-06 — DEC-03
CREATE TRIGGER trg_timesheet_draft_segment_day_state_check
  BEFORE INSERT OR UPDATE OF "draftDayId", "draftId", "employeeId", "date", "startAt", "endAt", "siteId", "workAreaId", "sourceAssignmentId"
  ON "TimesheetDraftSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_timesheet_draft_segment_day_state_check();

-- TRG-07
CREATE TRIGGER trg_timesheet_day_state_check
  BEFORE UPDATE OF "dayType", "confirmedZero"
  ON "TimesheetDay"
  FOR EACH ROW
  WHEN (OLD."dayType" IS DISTINCT FROM NEW."dayType" OR OLD."confirmedZero" IS DISTINCT FROM NEW."confirmedZero")
  EXECUTE FUNCTION fn_timesheet_day_state_check();

-- TRG-08 — DEC-03
CREATE TRIGGER trg_work_segment_day_state_check
  BEFORE INSERT OR UPDATE OF "timesheetDayId", "timesheetVersionId", "employeeId", "date", "startAt", "endAt", "siteId", "workAreaId", "sourceAssignmentId"
  ON "WorkSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_work_segment_day_state_check();

-- TRG-09
CREATE TRIGGER trg_timesheet_draft_break_segment_containment_check
  BEFORE INSERT OR UPDATE OF "draftSegmentId", "startAt", "endAt"
  ON "TimesheetDraftBreakSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_timesheet_draft_break_segment_containment_check();

-- TRG-10
CREATE TRIGGER trg_break_segment_containment_check
  BEFORE INSERT OR UPDATE OF "workSegmentId", "startAt", "endAt"
  ON "BreakSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_break_segment_containment_check();

-- TRG-11 — DEC-01
CREATE TRIGGER trg_site_assignment_dependents_guard
  BEFORE UPDATE OF "validFrom", "validTo"
  ON "SiteAssignment"
  FOR EACH ROW
  WHEN (OLD."validFrom" IS DISTINCT FROM NEW."validFrom" OR OLD."validTo" IS DISTINCT FROM NEW."validTo")
  EXECUTE FUNCTION fn_site_assignment_dependents_guard();

-- TRG-12 — DEC-02
CREATE TRIGGER trg_timesheet_draft_segment_breaks_guard
  BEFORE UPDATE OF "startAt", "endAt"
  ON "TimesheetDraftSegment"
  FOR EACH ROW
  WHEN (OLD."startAt" IS DISTINCT FROM NEW."startAt" OR OLD."endAt" IS DISTINCT FROM NEW."endAt")
  EXECUTE FUNCTION fn_timesheet_draft_segment_breaks_guard();

-- TRG-13 — DEC-02
CREATE TRIGGER trg_work_segment_breaks_guard
  BEFORE UPDATE OF "startAt", "endAt"
  ON "WorkSegment"
  FOR EACH ROW
  WHEN (OLD."startAt" IS DISTINCT FROM NEW."startAt" OR OLD."endAt" IS DISTINCT FROM NEW."endAt")
  EXECUTE FUNCTION fn_work_segment_breaks_guard();
