-- Titanor Time — R15-D7 unified assignment lifecycle, migration 1 of 2.
-- Design: docs/titanor-time/R15_ASSIGNMENT_LIFECYCLE_DESIGN_RU.md §5. Owner-approved 2026-09-02.
--
-- Additive only. Existing SiteAssignment.validFrom/validTo (dates) are NOT touched — they stay the
-- payroll/historical boundary. This adds the *operational* lever and the structured history:
--   1. SiteAssignment.clockInDisabledAt — the exact instant after which no new shift may start on
--      this assignment. Read by every "current assignment" consumer (lib/assignment-lifecycle.ts
--      isAssignmentLiveNow). NULL = operationally live. Backfilled to (validTo + 1 day, Helsinki)
--      for assignments already historically ended (validTo strictly before today), so the
--      operational gate agrees with the calendar gate from day one; assignments with validTo in
--      the future or NULL keep clockInDisabledAt = NULL.
--   2. WorkSite.finishedAt — a "finish this site" action operationally closed it. Distinct from
--      `active` (list/picker visibility). Backfilled to now() for sites that are already
--      inactive, so a currently-closed site reads as "finished" rather than "unknown".
--   3. AssignmentTransition — append-only structured record per lifecycle action. AuditEvent is
--      still written alongside. The timesheet "место работы изменено в HH:MM" marker reads this,
--      not AuditEvent JSON.
--
-- Deliberately NOT here (migration 2, Deploy D, after the owner fixes Nazar Druz's double primary):
--   the partial unique index ux_site_assignment_one_live_primary.
--
-- migrate deploy is idempotent: a second run is a no-op (Prisma tracks _prisma_migrations; the
-- backfill UPDATEs are guarded so re-running the raw SQL by hand would also be safe).

-- ============================================================================
-- Section A — structural SQL matching prisma/schema.prisma
-- ============================================================================

-- CreateEnum
CREATE TYPE "AssignmentTransitionKind" AS ENUM ('CHANGE', 'REMOVE', 'SITE_FINISH', 'CUSTOMER_DISABLE', 'GROUP_CHANGE');

-- CreateEnum
CREATE TYPE "AssignmentTransitionOpenShift" AS ENUM ('AFTER_CHECK_OUT', 'MOVED_TO_NEW', 'NONE');

-- CreateEnum
CREATE TYPE "AssignmentTransitionReason" AS ENUM ('PROJECT_DONE', 'TRANSFER', 'ASSIGNED_BY_MISTAKE', 'OTHER');

-- AlterTable (harmless no-op re-set of an already-correct default — recurring Prisma diff artifact,
-- same line is in several earlier migrations, see 20260819150000_add_export_batch_schema)
ALTER TABLE "CompanyAttendancePolicy" ALTER COLUMN "cutoffTime" SET DEFAULT '23:59:00'::time;

-- AlterTable
ALTER TABLE "SiteAssignment" ADD COLUMN     "clockInDisabledAt" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "WorkSite" ADD COLUMN     "finishedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "AssignmentTransition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employeeId" UUID NOT NULL,
    "kind" "AssignmentTransitionKind" NOT NULL,
    "fromAssignmentId" UUID,
    "toAssignmentId" UUID,
    "actedAt" TIMESTAMPTZ(6) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "openShiftHandling" "AssignmentTransitionOpenShift",
    "actorUserId" UUID NOT NULL,
    "groupId" UUID,
    "reasonCode" "AssignmentTransitionReason" NOT NULL,
    "reasonText" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssignmentTransition_employeeId_actedAt_idx" ON "AssignmentTransition"("employeeId", "actedAt" DESC);

-- CreateIndex
CREATE INDEX "AssignmentTransition_groupId_idx" ON "AssignmentTransition"("groupId");

-- CreateIndex
CREATE INDEX "AssignmentTransition_fromAssignmentId_idx" ON "AssignmentTransition"("fromAssignmentId");

-- CreateIndex
CREATE INDEX "AssignmentTransition_toAssignmentId_idx" ON "AssignmentTransition"("toAssignmentId");

-- CreateIndex
CREATE INDEX "SiteAssignment_employeeId_clockInDisabledAt_idx" ON "SiteAssignment"("employeeId", "clockInDisabledAt");

-- AddForeignKey
ALTER TABLE "AssignmentTransition" ADD CONSTRAINT "AssignmentTransition_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTransition" ADD CONSTRAINT "AssignmentTransition_fromAssignmentId_fkey" FOREIGN KEY ("fromAssignmentId") REFERENCES "SiteAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTransition" ADD CONSTRAINT "AssignmentTransition_toAssignmentId_fkey" FOREIGN KEY ("toAssignmentId") REFERENCES "SiteAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentTransition" ADD CONSTRAINT "AssignmentTransition_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- ============================================================================

-- Backfill 1 — SiteAssignment.clockInDisabledAt for assignments already historically ended.
-- "Ended" = validTo is a date strictly before today's Europe/Helsinki calendar date. The
-- operational close instant is the start of the day after validTo, in Helsinki wall clock,
-- converted to an absolute instant. Guarded by "IS NULL" so a hand re-run is a no-op.
UPDATE "SiteAssignment"
SET "clockInDisabledAt" = (("validTo" + 1)::text || ' 00:00:00 Europe/Helsinki')::timestamptz
WHERE "validTo" IS NOT NULL
  AND "validTo" < (now() AT TIME ZONE 'Europe/Helsinki')::date
  AND "clockInDisabledAt" IS NULL;

-- Backfill 2 — WorkSite.finishedAt for sites that are already inactive.
UPDATE "WorkSite"
SET "finishedAt" = now()
WHERE "active" = false
  AND "finishedAt" IS NULL;

-- trg_assignment_transition_immutable
-- AssignmentTransition is append-only (design §4). Enforced physically, like trg_audit_event_immutable
-- (migration 20260730232202). Unconditional — every UPDATE and DELETE is rejected for every actor.
-- Same P0001 / frozen-identifier convention as every other business-rule trigger in this schema.
CREATE OR REPLACE FUNCTION fn_assignment_transition_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ASSIGNMENT_TRANSITION_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assignment_transition_immutable
  BEFORE UPDATE OR DELETE
  ON "AssignmentTransition"
  FOR EACH ROW
  EXECUTE FUNCTION fn_assignment_transition_immutable();
