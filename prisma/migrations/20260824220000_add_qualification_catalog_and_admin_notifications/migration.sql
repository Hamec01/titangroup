-- Titanor Time — migration: Qualifications Matrix + Admin Notification Center schema
--
-- Purely additive. Does not touch existing EmployeeQualification rows (new columns are all
-- nullable or have a default). QualificationDefinition/AdminNotification/
-- AdminNotificationDismissal are new tables.

-- CreateEnum
CREATE TYPE "QualificationScope" AS ENUM ('EMPLOYEE', 'COMPANY_REFERENCE');

-- CreateEnum
CREATE TYPE "QualificationExpiryMode" AS ENUM ('REQUIRED', 'OPTIONAL', 'NONE');

-- CreateEnum
CREATE TYPE "QualificationVerificationState" AS ENUM ('SELF_REPORTED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "AdminNotificationType" AS ENUM ('QUALIFICATION_EXPIRING_SOON', 'QUALIFICATION_CRITICAL', 'QUALIFICATION_EXPIRED', 'QUALIFICATION_MISSING_EXPIRY');

-- CreateEnum
CREATE TYPE "AdminNotificationSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- AlterTable
ALTER TABLE "CompanyAttendancePolicy" ALTER COLUMN "cutoffTime" SET DEFAULT '23:59:00'::time;

-- AlterTable
ALTER TABLE "EmployeeQualification" ADD COLUMN     "certificateNumber" VARCHAR(80),
ADD COLUMN     "definitionId" UUID,
ADD COLUMN     "issuedOn" DATE,
ADD COLUMN     "issuer" VARCHAR(160),
ADD COLUMN     "verificationState" "QualificationVerificationState" NOT NULL DEFAULT 'SELF_REPORTED',
ADD COLUMN     "verifiedAt" TIMESTAMPTZ(6),
ADD COLUMN     "verifiedByUserId" UUID;

-- CreateTable
CREATE TABLE "QualificationDefinition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "scope" "QualificationScope" NOT NULL,
    "nameEn" VARCHAR(160) NOT NULL,
    "nameRu" VARCHAR(160) NOT NULL,
    "descriptionEn" TEXT,
    "descriptionRu" TEXT,
    "expiryMode" "QualificationExpiryMode" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "QualificationDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminNotification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "AdminNotificationType" NOT NULL,
    "severity" "AdminNotificationSeverity" NOT NULL,
    "employeeId" UUID,
    "employeeQualificationId" UUID,
    "threshold" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AdminNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminNotificationDismissal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "notificationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dismissedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNotificationDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QualificationDefinition_code_key" ON "QualificationDefinition"("code");

-- CreateIndex
CREATE INDEX "QualificationDefinition_scope_isActive_sortOrder_idx" ON "QualificationDefinition"("scope", "isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "AdminNotification_resolvedAt_createdAt_idx" ON "AdminNotification"("resolvedAt", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminNotification_employeeQualificationId_idx" ON "AdminNotification"("employeeQualificationId");

-- CreateIndex
CREATE INDEX "AdminNotification_employeeId_idx" ON "AdminNotification"("employeeId");

-- CreateIndex
CREATE INDEX "AdminNotificationDismissal_userId_idx" ON "AdminNotificationDismissal"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminNotificationDismissal_notificationId_userId_key" ON "AdminNotificationDismissal"("notificationId", "userId");

-- CreateIndex
CREATE INDEX "EmployeeQualification_definitionId_idx" ON "EmployeeQualification"("definitionId");

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "QualificationDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminNotification" ADD CONSTRAINT "AdminNotification_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminNotification" ADD CONSTRAINT "AdminNotification_employeeQualificationId_fkey" FOREIGN KEY ("employeeQualificationId") REFERENCES "EmployeeQualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminNotificationDismissal" ADD CONSTRAINT "AdminNotificationDismissal_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "AdminNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminNotificationDismissal" ADD CONSTRAINT "AdminNotificationDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-added (not Prisma-generated): active-notification dedup guard. One active
-- (resolvedAt IS NULL) AdminNotification per (employeeQualificationId, type, threshold) —
-- COALESCE so the MISSING_EXPIRY type (threshold IS NULL) is also deduplicated, since NULL
-- would otherwise never equal NULL in a plain unique index. Prisma's schema DSL cannot express
-- a partial (WHERE) index, so this lives only here, mirroring how other raw-SQL constraints in
-- this project are hand-added into a generated migration (see docs/titanor-time/05_RAW_SQL_REGISTER.md).
CREATE UNIQUE INDEX "ux_admin_notification_active_dedup"
  ON "AdminNotification" ("employeeQualificationId", "type", COALESCE("threshold", -1))
  WHERE "resolvedAt" IS NULL;
