-- CreateEnum
CREATE TYPE "TimesheetReviewScopeType" AS ENUM ('SITE', 'NON_SITE');

-- CreateEnum
CREATE TYPE "TimesheetReviewScopePurpose" AS ENUM ('DATA', 'EMPTY_FALLBACK');

-- CreateEnum
CREATE TYPE "TimesheetReviewScopeStatus" AS ENUM ('PENDING', 'APPROVED', 'RETURNED');

-- CreateTable
CREATE TABLE "TimesheetReviewScope" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetVersionId" UUID NOT NULL,
    "scopeType" "TimesheetReviewScopeType" NOT NULL,
    "scopePurpose" "TimesheetReviewScopePurpose",
    "siteId" UUID,
    "contextSiteId" UUID,
    "status" "TimesheetReviewScopeStatus" NOT NULL,
    "contentHash" VARCHAR(64) NOT NULL,
    "carriedFromScopeId" UUID,
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMPTZ(6),
    "returnReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TimesheetReviewScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimesheetReviewScope_timesheetVersionId_idx" ON "TimesheetReviewScope"("timesheetVersionId");

-- CreateIndex
CREATE INDEX "TimesheetReviewScope_siteId_status_idx" ON "TimesheetReviewScope"("siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetReviewScope_id_timesheetVersionId_key" ON "TimesheetReviewScope"("id", "timesheetVersionId");

-- AddForeignKey
ALTER TABLE "TimesheetReviewScope" ADD CONSTRAINT "TimesheetReviewScope_timesheetVersionId_fkey" FOREIGN KEY ("timesheetVersionId") REFERENCES "TimesheetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetReviewScope" ADD CONSTRAINT "TimesheetReviewScope_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetReviewScope" ADD CONSTRAINT "TimesheetReviewScope_contextSiteId_fkey" FOREIGN KEY ("contextSiteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetReviewScope" ADD CONSTRAINT "TimesheetReviewScope_carriedFromScopeId_fkey" FOREIGN KEY ("carriedFromScopeId") REFERENCES "TimesheetReviewScope"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetReviewScope" ADD CONSTRAINT "TimesheetReviewScope_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- (docs/titanor-time/03_DATA_MODEL_ERD.md §4.6, "TimesheetReviewScope")
-- ============================================================================

-- ck_timesheet_review_scope_shape
-- scopeType/siteId/scopePurpose must agree: SITE always carries a siteId and a null
-- scopePurpose; NON_SITE always has a null siteId and a DATA/EMPTY_FALLBACK purpose.
-- The explicit "scopePurpose" IS NOT NULL guard on the NON_SITE branch matters: `x IN (...)`
-- evaluates to NULL (not FALSE) when x itself is NULL, and Postgres CHECK constraints only
-- reject a FALSE result, not NULL/UNKNOWN — without the guard, a NON_SITE row with a NULL
-- scopePurpose would pass this constraint silently (confirmed empirically on disposable
-- PostgreSQL 16 while testing this migration).
ALTER TABLE "TimesheetReviewScope"
  ADD CONSTRAINT "ck_timesheet_review_scope_shape"
  CHECK (
    ("scopeType" = 'SITE' AND "siteId" IS NOT NULL AND "scopePurpose" IS NULL)
    OR ("scopeType" = 'NON_SITE' AND "siteId" IS NULL AND "scopePurpose" IS NOT NULL AND "scopePurpose" IN ('DATA', 'EMPTY_FALLBACK'))
  );

-- ex_timesheet_review_scope_site_unique / ex_timesheet_review_scope_non_site_unique
-- Prisma's @@unique cannot express a partial index. At most one SITE scope per siteId
-- per version, and at most one NON_SITE scope (of either purpose) per version.
CREATE UNIQUE INDEX "ex_timesheet_review_scope_site_unique" ON "TimesheetReviewScope" ("timesheetVersionId", "siteId") WHERE "scopeType" = 'SITE';
CREATE UNIQUE INDEX "ex_timesheet_review_scope_non_site_unique" ON "TimesheetReviewScope" ("timesheetVersionId") WHERE "scopeType" = 'NON_SITE';
