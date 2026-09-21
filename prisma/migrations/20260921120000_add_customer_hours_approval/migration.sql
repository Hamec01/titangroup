-- Titanor Time — UT2: CustomerHoursApprovalBatch / CustomerHoursApprovalItem schema foundation.
-- Additive only. Does not touch Timesheet, TimesheetVersion, WorkSegment, TimesheetReviewScope, or
-- any other existing table/column/constraint. No backfill — both new tables start empty and stay
-- empty until a later, separate checkpoint wires an approval endpoint to write to them.
--
-- docs/titanor-time/05_RAW_SQL_REGISTER.md — new identifiers CK-59..CK-66, UX-05..UX-06,
-- FN-27..FN-28, TRG-32..TRG-33 (checkpoint UT2-A, owner-approved before this migration).
--
-- ============================================================================
-- Section A — Prisma-generated DDL (verified via `prisma migrate diff` against a disposable
-- PostgreSQL 16 migrated to the pre-UT2 head, then hand-copied here — same convention as every
-- prior migration.sql in this repo: Prisma authors CreateEnum/CreateTable/CreateIndex/
-- AddForeignKey, raw SQL is appended by hand in Section B).
-- ============================================================================

-- CreateEnum
CREATE TYPE "CustomerHoursApprovalSourceKind" AS ENUM ('DRAFT', 'VERSION');

-- CreateEnum
CREATE TYPE "CustomerHoursApprovalState" AS ENUM ('CURRENT', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "CustomerHoursApprovalBatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "approvedByUserId" UUID NOT NULL,
    "approvedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "selectionSnapshot" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "workedMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerHoursApprovalBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerHoursApprovalItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "batchId" UUID NOT NULL,
    "timesheetId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workAreaId" UUID,
    "weekStart" DATE NOT NULL,
    "weekEnd" DATE NOT NULL,
    "sourceKind" "CustomerHoursApprovalSourceKind" NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceRevision" BIGINT,
    "fingerprint" CHAR(64) NOT NULL,
    "workedMinutes" INTEGER NOT NULL,
    "grossMinutes" INTEGER NOT NULL,
    "breakMinutes" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "approvalState" "CustomerHoursApprovalState" NOT NULL DEFAULT 'CURRENT',
    "supersededAt" TIMESTAMPTZ(6),
    "supersededBySourceId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerHoursApprovalItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerHoursApprovalBatch_approvedAt_idx" ON "CustomerHoursApprovalBatch"("approvedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerHoursApprovalBatch_approvedByUserId_idempotencyKey_key" ON "CustomerHoursApprovalBatch"("approvedByUserId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CustomerHoursApprovalItem_timesheetId_employeeId_idx" ON "CustomerHoursApprovalItem"("timesheetId", "employeeId");

-- CreateIndex
CREATE INDEX "CustomerHoursApprovalItem_weekStart_workAreaId_siteId_idx" ON "CustomerHoursApprovalItem"("weekStart", "workAreaId", "siteId");

-- CreateIndex
CREATE INDEX "CustomerHoursApprovalItem_batchId_idx" ON "CustomerHoursApprovalItem"("batchId");

-- CreateIndex
CREATE INDEX "CustomerHoursApprovalItem_employeeId_siteId_workAreaId_week_idx" ON "CustomerHoursApprovalItem"("employeeId", "siteId", "workAreaId", "weekStart", "approvalState");

-- AddForeignKey
ALTER TABLE "CustomerHoursApprovalBatch" ADD CONSTRAINT "CustomerHoursApprovalBatch_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "CustomerHoursApprovalItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CustomerHoursApprovalBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — composite FK #1 of 2: guarantees timesheetId+employeeId belong to the same
-- Timesheet row (via the existing Timesheet.@@unique([id, employeeId])), same pattern
-- TimesheetDraft/TimesheetVersion already use.
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "CustomerHoursApprovalItem_timesheetId_employeeId_fkey" FOREIGN KEY ("timesheetId", "employeeId") REFERENCES "Timesheet"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "CustomerHoursApprovalItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "CustomerHoursApprovalItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — composite FK #2 of 2: guarantees a non-null workAreaId belongs to the same site
-- as the row itself (via WorkArea.@@unique([siteId, id])), same pattern WorkSegment.workArea uses.
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "CustomerHoursApprovalItem_siteId_workAreaId_fkey" FOREIGN KEY ("siteId", "workAreaId") REFERENCES "WorkArea"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax (CHECK shape constraints, the two
-- partial unique indexes, immutability triggers). Same convention as every prior migration's own
-- "Section B" (e.g. 20260730232202_add_audit_event, 20260902180000_add_primary_period_exclusion).
-- ============================================================================

-- CK-59 ck_customer_hours_approval_item_week_range
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "ck_customer_hours_approval_item_week_range"
  CHECK ("weekEnd" = "weekStart" + 6);

-- CK-60 ck_customer_hours_approval_item_week_start_monday
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "ck_customer_hours_approval_item_week_start_monday"
  CHECK (EXTRACT(ISODOW FROM "weekStart") = 1);

-- CK-61 ck_customer_hours_approval_item_minutes_nonnegative
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "ck_customer_hours_approval_item_minutes_nonnegative"
  CHECK ("workedMinutes" >= 0 AND "grossMinutes" >= 0 AND "breakMinutes" >= 0);

-- CK-62 ck_customer_hours_approval_item_minutes_balance
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "ck_customer_hours_approval_item_minutes_balance"
  CHECK ("grossMinutes" = "workedMinutes" + "breakMinutes");

-- CK-63 ck_customer_hours_approval_item_source_revision_shape
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "ck_customer_hours_approval_item_source_revision_shape"
  CHECK (
    ("sourceKind" = 'DRAFT'   AND "sourceRevision" IS NOT NULL) OR
    ("sourceKind" = 'VERSION' AND "sourceRevision" IS NULL)
  );

-- CK-64 ck_customer_hours_approval_item_superseded_shape
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "ck_customer_hours_approval_item_superseded_shape"
  CHECK (
    ("approvalState" = 'CURRENT'    AND "supersededAt" IS NULL     AND "supersededBySourceId" IS NULL) OR
    ("approvalState" = 'SUPERSEDED' AND "supersededAt" IS NOT NULL AND "supersededBySourceId" IS NOT NULL)
  );

-- CK-65 ck_customer_hours_approval_item_fingerprint_format
ALTER TABLE "CustomerHoursApprovalItem" ADD CONSTRAINT "ck_customer_hours_approval_item_fingerprint_format"
  CHECK ("fingerprint" ~ '^[0-9a-f]{64}$');

-- CK-66 ck_customer_hours_approval_batch_counts_nonnegative
ALTER TABLE "CustomerHoursApprovalBatch" ADD CONSTRAINT "ck_customer_hours_approval_batch_counts_nonnegative"
  CHECK ("itemCount" >= 0 AND "workedMinutes" >= 0);

-- UX-05 ux_customer_hours_approval_item_active_with_customer
-- UX-06 ux_customer_hours_approval_item_active_no_customer
-- Two partial unique indexes instead of one COALESCE-sentinel index (owner decision, UT2-A §3):
-- NULL <> NULL under a plain unique index, so a single index on (employeeId, timesheetId, siteId,
-- workAreaId, weekStart) would never catch two simultaneous CURRENT rows both carrying
-- workAreaId = NULL ("Без заказчика"). Splitting by "workAreaId IS NOT NULL" / "IS NULL" closes
-- that gap without a fabricated sentinel UUID.
CREATE UNIQUE INDEX "ux_customer_hours_approval_item_active_with_customer"
  ON "CustomerHoursApprovalItem" ("employeeId", "timesheetId", "siteId", "workAreaId", "weekStart")
  WHERE "approvalState" = 'CURRENT' AND "workAreaId" IS NOT NULL;

CREATE UNIQUE INDEX "ux_customer_hours_approval_item_active_no_customer"
  ON "CustomerHoursApprovalItem" ("employeeId", "timesheetId", "siteId", "weekStart")
  WHERE "approvalState" = 'CURRENT' AND "workAreaId" IS NULL;

-- FN-27 fn_customer_hours_approval_item_guard / TRG-32 trg_customer_hours_approval_item_guard
--
-- Append-only with exactly one legal mutation: CURRENT -> SUPERSEDED, changing only
-- approvalState/supersededAt/supersededBySourceId. No early-return for a no-op UPDATE (owner
-- correction, UT2-B): every UPDATE that isn't that one exact transition is rejected, including
-- CURRENT->CURRENT and SUPERSEDED->SUPERSEDED with byte-identical values — an append-only audit
-- trail records that a write was attempted and refused, it does not silently succeed at doing
-- nothing. A second attempt to supersede an already-SUPERSEDED row is therefore never a "harmless"
-- idempotent no-op at the trigger level; the calling business operation is responsible for
-- checking approvalState BEFORE issuing the UPDATE if it wants idempotent behavior.
CREATE OR REPLACE FUNCTION fn_customer_hours_approval_item_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CUSTOMER_HOURS_APPROVAL_ITEM_NO_DELETE' USING ERRCODE = 'P0001';
  END IF;

  IF OLD."approvalState" = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'CUSTOMER_HOURS_APPROVAL_ITEM_ALREADY_SUPERSEDED' USING ERRCODE = 'P0001';
  END IF;

  -- OLD.approvalState = 'CURRENT' here. The only legal change: -> SUPERSEDED, with
  -- supersededAt/supersededBySourceId newly set, and every other column — including
  -- approvalState itself staying CURRENT — unchanged. A byte-identical CURRENT->CURRENT UPDATE
  -- fails this too (NEW.approvalState <> 'SUPERSEDED' is true when it stays 'CURRENT').
  IF NEW."approvalState" <> 'SUPERSEDED'
     OR NEW."supersededAt" IS NULL
     OR NEW."supersededBySourceId" IS NULL
     OR NEW."id"                   IS DISTINCT FROM OLD."id"
     OR NEW."batchId"               IS DISTINCT FROM OLD."batchId"
     OR NEW."timesheetId"           IS DISTINCT FROM OLD."timesheetId"
     OR NEW."employeeId"            IS DISTINCT FROM OLD."employeeId"
     OR NEW."siteId"                IS DISTINCT FROM OLD."siteId"
     OR NEW."workAreaId"            IS DISTINCT FROM OLD."workAreaId"
     OR NEW."weekStart"             IS DISTINCT FROM OLD."weekStart"
     OR NEW."weekEnd"               IS DISTINCT FROM OLD."weekEnd"
     OR NEW."sourceKind"            IS DISTINCT FROM OLD."sourceKind"
     OR NEW."sourceId"              IS DISTINCT FROM OLD."sourceId"
     OR NEW."sourceRevision"        IS DISTINCT FROM OLD."sourceRevision"
     OR NEW."fingerprint"           IS DISTINCT FROM OLD."fingerprint"
     OR NEW."workedMinutes"         IS DISTINCT FROM OLD."workedMinutes"
     OR NEW."grossMinutes"          IS DISTINCT FROM OLD."grossMinutes"
     OR NEW."breakMinutes"          IS DISTINCT FROM OLD."breakMinutes"
     OR NEW."snapshot"              IS DISTINCT FROM OLD."snapshot"
     OR NEW."createdAt"             IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'CUSTOMER_HOURS_APPROVAL_ITEM_IMMUTABLE_FIELD_CHANGED' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_hours_approval_item_guard
  BEFORE UPDATE OR DELETE
  ON "CustomerHoursApprovalItem"
  FOR EACH ROW
  EXECUTE FUNCTION fn_customer_hours_approval_item_guard();

-- FN-28 fn_customer_hours_approval_batch_immutable / TRG-33 trg_customer_hours_approval_batch_immutable
-- Unconditional ban, same shape as fn_audit_event_immutable / fn_clock_event_immutable — a batch
-- describes one already-completed admin action; nothing about it is ever supposed to change.
CREATE OR REPLACE FUNCTION fn_customer_hours_approval_batch_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMER_HOURS_APPROVAL_BATCH_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_hours_approval_batch_immutable
  BEFORE UPDATE OR DELETE
  ON "CustomerHoursApprovalBatch"
  FOR EACH ROW
  EXECUTE FUNCTION fn_customer_hours_approval_batch_immutable();

-- ============================================================================
-- Section C — permission seed (additive data only). Idempotent: Permission.code is @unique,
-- RolePermission has @@unique([roleId, permissionId]) — both ON CONFLICT clauses target real
-- constraints, same idempotent-seed style already used for the system.scheduler /
-- CompanyAttendancePolicy singleton seeds (05_RAW_SQL_REGISTER.md §11.6).
-- ============================================================================

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.customer_hours_approve.all', 'Approve weekly customer hours for all workers and sites.')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'timesheet.customer_hours_approve.all'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
