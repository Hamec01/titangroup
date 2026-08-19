-- Titanor Time — T8.4A CSV Export Schema Foundation
--
-- Design per docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4A" (written before this
-- migration). Schema only — zero CSV generation, zero export API, zero download endpoint, zero
-- admin UI, zero PDF, zero payroll/TES categories. That is all deferred to T8.4B (generation/API/
-- download) and T8.4C (admin UI).
--
-- CSV_V1 is a worked-time report (T8.1/T8.2/T8.3's own canonical (employeeId, siteId, date)
-- bucket), not a payroll export — no money fields anywhere in ExportBatch/ExportItem.
--
-- Documented discrepancy (Addendum "T8.4A" §AI): ExportItem.workedMinutes uses
-- GREATEST(0, gross - paid - unpaid) per this slice's own explicit spec — this is NOT the same
-- formula as lib/reporting/worked-time.ts's workedMs = grossMs - unpaidBreakMs (paid stays inside
-- worked there). lib/reporting/worked-time.ts is unchanged; T8.1/T8.2/T8.3 keep using their own
-- formula unmodified. A future T8.4B generation step must compute this column with ITS OWN
-- formula, not copy T8.1/T8.2/T8.3's workedMinutes verbatim.
--
-- Immutable bytes decision (§AK): ExportBatch.content stores the exact generated CSV bytes
-- (bytea), not a file path or a reconstruction — a later download (T8.4B) never depends on
-- employee/site names that may have since changed (per-row snapshot columns on ExportItem cover
-- that at the row level) or on regenerating byte-identical output from a formatter that may itself
-- have changed between generation and download.
--
-- Period-status gating (FULL only for a LOCKED period; CORRECTION only for an EXPORTED period
-- with an APPROVED CorrectionRequest.pendingExport=true) is documented in the design doc but
-- deliberately NOT enforced by a constraint/trigger here — it requires reading a mutable column on
-- a different table (PayrollPeriod.status, CorrectionRequest.status/pendingExport) at batch-
-- creation time, which is a create-batch SERVICE concern (T8.4B, which does not exist yet), not a
-- structural property of an ExportBatch/ExportItem row itself.
--
-- A note on one line NOT in this migration: `prisma migrate dev --create-only` also proposed
-- `ALTER TABLE "CompanyAttendancePolicy" ALTER COLUMN "cutoffTime" SET DEFAULT '23:59:00'::time`
-- — a pre-existing, unrelated diff-detection artifact (the column's default is already exactly
-- this value; Prisma's schema-vs-migration-history diff flags a representation difference in how
-- the `dbgenerated(...)` default is recorded, not an actual behavior change). Removed from this
-- migration as out of scope — T8.4A does not touch CompanyAttendancePolicy, and the project's own
-- convention is to never edit unrelated tables inside a feature migration.

-- ============================================================================
-- Section A — structural SQL matching prisma/schema.prisma (tables, indexes, foreign keys)
-- ============================================================================

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV_V1');

-- CreateEnum
CREATE TYPE "ExportBatchKind" AS ENUM ('FULL', 'CORRECTION');

-- CreateTable
CREATE TABLE "ExportBatch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "periodId" UUID NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "kind" "ExportBatchKind" NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "correctsBatchId" UUID,
    "fileName" VARCHAR(255) NOT NULL,
    "fileHash" VARCHAR(64) NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exportBatchId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "timesheetVersionId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "employeeNumberSnapshot" TEXT NOT NULL,
    "employeeNameSnapshot" TEXT NOT NULL,
    "siteNameSnapshot" TEXT NOT NULL,
    "grossMinutes" INTEGER NOT NULL,
    "paidBreakMinutes" INTEGER NOT NULL,
    "unpaidBreakMinutes" INTEGER NOT NULL,
    "workedMinutes" INTEGER NOT NULL,
    "segmentCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Explicitly requested by task spec: list batches for a period, newest first, stable cursor pagination.
CREATE INDEX "ExportBatch_periodId_createdAt_id_idx" ON "ExportBatch"("periodId", "createdAt" DESC, "id" DESC);

-- CreateIndex — FK support, not covered as a leading column by any other index above.
CREATE INDEX "ExportBatch_createdByUserId_idx" ON "ExportBatch"("createdByUserId");

-- CreateIndex — FK support (self-FK), not covered by any other index above.
CREATE INDEX "ExportBatch_correctsBatchId_idx" ON "ExportBatch"("correctsBatchId");

-- CreateIndex — composite FK support (ExportItem_timesheetVersionId_employeeId_fkey below), not
-- covered by the (exportBatchId, employeeId, siteId, date) unique index (employeeId isn't its
-- leading column, timesheetVersionId isn't in it at all).
CREATE INDEX "ExportItem_timesheetVersionId_employeeId_idx" ON "ExportItem"("timesheetVersionId", "employeeId");

-- CreateIndex
-- Unique item identity (task requirement) — its own backing btree index also satisfies the task's
-- separately-listed "ExportItem(exportBatchId, employeeId, siteId, date)" index requirement; no
-- second, duplicate plain index is added alongside it.
CREATE UNIQUE INDEX "ExportItem_exportBatchId_employeeId_siteId_date_key" ON "ExportItem"("exportBatchId", "employeeId", "siteId", "date");

-- AddForeignKey
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ExportBatch_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ExportBatch_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- CASCADE here is FK-semantics-only (task-authorized) — trg_export_batch_immutable (Section B)
-- unconditionally bans DELETE on ExportBatch before any cascade could fire, so this path never
-- actually executes; it is not a real operational route to deleting correction children.
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ExportBatch_correctsBatchId_fkey" FOREIGN KEY ("correctsBatchId") REFERENCES "ExportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Same CASCADE-is-FK-semantics-only reasoning as above, one level down: trg_export_batch_immutable
-- blocks the parent DELETE before this could ever cascade in practice.
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_exportBatchId_fkey" FOREIGN KEY ("exportBatchId") REFERENCES "ExportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- Composite FK — timesheetVersionId must belong to employeeId, expressed via TimesheetVersion's
-- own pre-existing @@unique([id, employeeId]) (05_RAW_SQL_REGISTER.md §11.3 FK-pattern precedent),
-- not an application-level check.
ALTER TABLE "ExportItem" ADD CONSTRAINT "ExportItem_timesheetVersionId_employeeId_fkey" FOREIGN KEY ("timesheetVersionId", "employeeId") REFERENCES "TimesheetVersion"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- ============================================================================
-- Registered in docs/titanor-time/05_RAW_SQL_REGISTER.md §12 (CK-37..CK-43, UX-04, FK-17, FN-23..
-- FN-25, TRG-28..TRG-30).

-- CK-37 ck_export_batch_kind_correction_shape
-- FULL <=> correctsBatchId IS NULL; CORRECTION <=> correctsBatchId IS NOT NULL.
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ck_export_batch_kind_correction_shape" CHECK (
  ("kind" = 'FULL' AND "correctsBatchId" IS NULL) OR
  ("kind" = 'CORRECTION' AND "correctsBatchId" IS NOT NULL)
);

-- CK-38 ck_export_batch_no_self_correction
-- A batch can never correct itself (predecessor must be a distinct, already-existing row).
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ck_export_batch_no_self_correction" CHECK (
  "correctsBatchId" IS NULL OR "correctsBatchId" != "id"
);

-- CK-39 ck_export_batch_file_hash_format
-- Exactly 64 lowercase hex characters (SHA-256 hex digest).
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ck_export_batch_file_hash_format" CHECK (
  "fileHash" ~ '^[0-9a-f]{64}$'
);

-- CK-40 ck_export_batch_file_size_matches_content
-- fileSizeBytes must literally equal the stored content's own byte length — the two can never
-- silently diverge (e.g. a caller passing a stale/miscalculated size alongside real content).
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ck_export_batch_file_size_matches_content" CHECK (
  "fileSizeBytes" = octet_length("content")
);

-- CK-41 ck_export_batch_counts_nonnegative
ALTER TABLE "ExportBatch" ADD CONSTRAINT "ck_export_batch_counts_nonnegative" CHECK (
  "fileSizeBytes" >= 0 AND "rowCount" >= 0
);

-- CK-42 ck_export_item_minutes_nonnegative
ALTER TABLE "ExportItem" ADD CONSTRAINT "ck_export_item_minutes_nonnegative" CHECK (
  "grossMinutes" >= 0 AND
  "paidBreakMinutes" >= 0 AND
  "unpaidBreakMinutes" >= 0 AND
  "workedMinutes" >= 0 AND
  "segmentCount" >= 0
);

-- CK-43 ck_export_item_worked_minutes_formula
-- Deliberately GREATEST(0, gross - paid - unpaid) — see this migration's header comment and
-- docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4A" §AI for why this differs from
-- lib/reporting/worked-time.ts's own workedMs = grossMs - unpaidBreakMs.
ALTER TABLE "ExportItem" ADD CONSTRAINT "ck_export_item_worked_minutes_formula" CHECK (
  "workedMinutes" = GREATEST(0, "grossMinutes" - "paidBreakMinutes" - "unpaidBreakMinutes")
);

-- UX-04 ux_export_batch_full_per_period
-- Partial unique index — at most one FULL batch per period. Not expressible via Prisma @@unique
-- (filtered by a column, "kind", other than the indexed column's own nullability).
CREATE UNIQUE INDEX "ux_export_batch_full_per_period" ON "ExportBatch"("periodId") WHERE "kind" = 'FULL';

-- FN-23 fn_export_batch_immutable / TRG-28 trg_export_batch_immutable
-- Unconditional UPDATE/DELETE ban, same P0001/frozen-uppercase-identifier convention as every
-- other immutable-entity trigger in this schema (see fn_audit_event_immutable, the first instance
-- of this exact pattern).
CREATE OR REPLACE FUNCTION fn_export_batch_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EXPORT_BATCH_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_export_batch_immutable
  BEFORE UPDATE OR DELETE
  ON "ExportBatch"
  FOR EACH ROW
  EXECUTE FUNCTION fn_export_batch_immutable();

-- FN-24 fn_export_item_immutable / TRG-29 trg_export_item_immutable
CREATE OR REPLACE FUNCTION fn_export_item_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'EXPORT_ITEM_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_export_item_immutable
  BEFORE UPDATE OR DELETE
  ON "ExportItem"
  FOR EACH ROW
  EXECUTE FUNCTION fn_export_item_immutable();

-- FN-25 fn_export_batch_correction_chain_check / TRG-30 trg_export_batch_correction_chain_check
-- (BEFORE INSERT only — a BEFORE UPDATE variant is unnecessary: trg_export_batch_immutable already
-- rejects every UPDATE unconditionally, so correctsBatchId can never actually change post-insert).
--
-- Validates, for CORRECTION rows only (FULL rows always have correctsBatchId IS NULL, already
-- covered by CK-37, so this function is a no-op for them):
--   1. the predecessor row exists (own explicit check — belt-and-suspenders alongside the
--      ExportBatch_correctsBatchId_fkey FK, which independently rejects a missing predecessor with
--      23503 regardless of this trigger's own outcome);
--   2. the predecessor belongs to the SAME periodId (not expressible as a CHECK or a plain FK —
--      neither can compare one row's column against a DIFFERENT row's column);
--   3. the correction chain contains no cycle. A cycle is structurally unreachable through the
--      exposed INSERT-only interface (a row can only reference an ALREADY-EXISTING predecessor,
--      and rows are immutable once inserted, so nothing can later "become" an ancestor of a batch
--      created before it) — this check exists as defense-in-depth and to make the invariant
--      directly testable, not as the sole guard.
CREATE OR REPLACE FUNCTION fn_export_batch_correction_chain_check()
RETURNS trigger AS $$
DECLARE
  predecessor_period_id UUID;
  cycle_hit BOOLEAN;
BEGIN
  IF NEW."kind" = 'CORRECTION' THEN
    SELECT "periodId" INTO predecessor_period_id FROM "ExportBatch" WHERE "id" = NEW."correctsBatchId";
    IF predecessor_period_id IS NULL THEN
      RAISE EXCEPTION 'EXPORT_BATCH_CORRECTION_PREDECESSOR_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF predecessor_period_id != NEW."periodId" THEN
      RAISE EXCEPTION 'EXPORT_BATCH_CORRECTION_PERIOD_MISMATCH' USING ERRCODE = 'P0001';
    END IF;

    WITH RECURSIVE chain AS (
      SELECT "id", "correctsBatchId" FROM "ExportBatch" WHERE "id" = NEW."correctsBatchId"
      UNION ALL
      SELECT eb."id", eb."correctsBatchId"
      FROM "ExportBatch" eb
      JOIN chain c ON eb."id" = c."correctsBatchId"
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE "id" = NEW."id") INTO cycle_hit;
    IF cycle_hit THEN
      RAISE EXCEPTION 'EXPORT_BATCH_CORRECTION_CYCLE' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_export_batch_correction_chain_check
  BEFORE INSERT
  ON "ExportBatch"
  FOR EACH ROW
  EXECUTE FUNCTION fn_export_batch_correction_chain_check();
