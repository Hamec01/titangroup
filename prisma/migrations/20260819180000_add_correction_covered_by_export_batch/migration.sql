-- Titanor Time — T8.4B schema completion: CorrectionRequest.coveredByExportBatchId
--
-- Design per docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B" §BE (written before this
-- migration). Additive only — does not edit 20260819150000_add_export_batch_schema or
-- 20260819170000_fix_export_item_worked_minutes_bounds.
--
-- Architectural gap this migration closes: T8.4A's CorrectionRequest.pendingExport=false alone
-- does not say WHICH ExportBatch covered a correction. This column + its invariants make that
-- relation explicit and DB-enforced.
--
-- Registered docs/titanor-time/05_RAW_SQL_REGISTER.md §13 (CK-45/CK-46, FN-26, TRG-31).

-- ============================================================================
-- Section A — structural SQL matching prisma/schema.prisma (column, index, foreign key)
-- ============================================================================

-- AlterTable
ALTER TABLE "CorrectionRequest" ADD COLUMN "coveredByExportBatchId" UUID;

-- CreateIndex
CREATE INDEX "CorrectionRequest_coveredByExportBatchId_idx" ON "CorrectionRequest"("coveredByExportBatchId");

-- AddForeignKey
-- RESTRICT — a correction that references a batch as its coverage must never be left dangling by
-- deleting the batch out from under it. ExportBatch is already structurally undeletable
-- (trg_export_batch_immutable, T8.4A FN-23) — this RESTRICT is defense-in-depth against any future
-- change to that trigger, not an operational path exercised today.
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_coveredByExportBatchId_fkey" FOREIGN KEY ("coveredByExportBatchId") REFERENCES "ExportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- ============================================================================
-- Registered in docs/titanor-time/05_RAW_SQL_REGISTER.md §13 (CK-45, CK-46, FN-26, TRG-31).

-- CK-45 ck_correction_request_pending_export_shape
-- pendingExport=true is only ever valid while status=APPROVED, resultingVersionId is set, and the
-- row has not yet been covered by any batch.
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "ck_correction_request_pending_export_shape" CHECK (
  NOT "pendingExport" OR (
    "status" = 'APPROVED' AND
    "resultingVersionId" IS NOT NULL AND
    "coveredByExportBatchId" IS NULL
  )
);

-- CK-46 ck_correction_request_covered_shape
-- coveredByExportBatchId is only ever valid while status=APPROVED, resultingVersionId is set, and
-- pendingExport has already been cleared (a row cannot be both still-pending and already-covered).
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "ck_correction_request_covered_shape" CHECK (
  "coveredByExportBatchId" IS NULL OR (
    "status" = 'APPROVED' AND
    "resultingVersionId" IS NOT NULL AND
    NOT "pendingExport"
  )
);

-- FN-26 fn_correction_request_covered_batch_check / TRG-31 trg_correction_request_covered_batch_check
-- BEFORE INSERT OR UPDATE — unlike ExportBatch/ExportItem (fully immutable via FN-23/FN-24),
-- CorrectionRequest remains a mutable table, so this needs an UPDATE path too, not just INSERT.
--
--   1. Immutability of this one column: once set, coveredByExportBatchId can never be cleared or
--      replaced by a different batch. Checked unconditionally first.
--   2. Only at the NULL -> value transition: validates the referenced batch exists (own explicit
--      check, belt-and-suspenders alongside the FK above — same style as FN-25's own predecessor
--      check for ExportBatch.correctsBatchId), has kind='CORRECTION' (a FULL batch can never
--      "cover" a correction — FULL batches only ever happen for a LOCKED period, before any
--      correction could exist), and belongs to the SAME period as the CorrectionRequest's own
--      Timesheet (not expressible as a CHECK or a plain FK — neither can compare one row's column
--      against a DIFFERENT table's row).
CREATE OR REPLACE FUNCTION fn_correction_request_covered_batch_check()
RETURNS trigger AS $$
DECLARE
  batch_kind "ExportBatchKind";
  batch_period_id UUID;
  ts_period_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."coveredByExportBatchId" IS NOT NULL
     AND NEW."coveredByExportBatchId" IS DISTINCT FROM OLD."coveredByExportBatchId" THEN
    RAISE EXCEPTION 'CORRECTION_REQUEST_COVERED_BATCH_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  IF NEW."coveredByExportBatchId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."coveredByExportBatchId" IS NULL) THEN
    SELECT "kind", "periodId" INTO batch_kind, batch_period_id FROM "ExportBatch" WHERE "id" = NEW."coveredByExportBatchId";
    IF batch_kind IS NULL THEN
      RAISE EXCEPTION 'CORRECTION_REQUEST_COVERED_BATCH_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF batch_kind != 'CORRECTION' THEN
      RAISE EXCEPTION 'CORRECTION_REQUEST_COVERED_BATCH_WRONG_KIND' USING ERRCODE = 'P0001';
    END IF;

    SELECT "periodId" INTO ts_period_id FROM "Timesheet" WHERE "id" = NEW."timesheetId";
    IF ts_period_id IS NULL OR ts_period_id != batch_period_id THEN
      RAISE EXCEPTION 'CORRECTION_REQUEST_COVERED_BATCH_PERIOD_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_correction_request_covered_batch_check
  BEFORE INSERT OR UPDATE
  ON "CorrectionRequest"
  FOR EACH ROW
  EXECUTE FUNCTION fn_correction_request_covered_batch_check();
