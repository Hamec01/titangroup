-- Titanor Time — T8.4B FOLLOW-UP: fix excluded correction export lifecycle
--
-- Corrective migration. Does NOT edit 20260819180000_add_correction_covered_by_export_batch or any
-- other prior migration. Design per docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4B
-- FOLLOW-UP".
--
-- Root cause: CorrectionRequest.pendingExport was previously set to
-- `period.status === 'EXPORTED'` alone (lib/corrections.ts::decideCorrection), regardless of
-- whether the correcting Timesheet's employee is even part of the export population
-- (PayrollPeriodParticipant.expected=true, T8_REPORTS_DESIGN.md §BA/§BC — FULL/CORRECTION export
-- population is ALWAYS expected=true only). A correction on an EXCLUDED participant's timesheet
-- could reach pendingExport=true and then stay there forever — no CORRECTION export batch will ever
-- cover it, because the export snapshot never includes that employee's rows in the first place, so
-- nothing in the existing code path (lib/csv-export.ts) would ever clear it back to false. An
-- impossible permanent "pending forever" state.
--
-- Fix: pendingExport now means "a real export snapshot could cover this correction and has not yet"
-- — not just "this correction was approved after the period became EXPORTED":
--
--   pendingExport = period.status === 'EXPORTED' AND PayrollPeriodParticipant.expected === true
--
-- lib/corrections.ts::decideCorrection now reads participant.expected inside the SAME authoritative,
-- already-FOR-UPDATE-locked transaction read it already uses for period.status (no separate
-- unlocked pre-read) and applies this formula. No other correction semantics change — the new
-- TimesheetVersion, currentVersionId switch, ClockShiftAdjustment writes, AuditEvent, and the export
-- population itself (still exactly expected=true participants) are all untouched.
--
-- DB enforcement: ck_correction_request_pending_export_shape (CK-45, T8.4B) already requires, for
-- any row with pendingExport=true: status=APPROVED, resultingVersionId IS NOT NULL,
-- coveredByExportBatchId IS NULL — those three conditions are unchanged and NOT reimplemented here.
-- This migration extends fn_correction_request_covered_batch_check (FN-26/TRG-31, T8.4B) — the same
-- trigger, not a new one — with the two additional cross-table conditions a CHECK constraint cannot
-- express (a plain CHECK can only see the row's own columns): the correction's own Timesheet's
-- PayrollPeriod.status must be EXPORTED, and its PayrollPeriodParticipant.expected must be true.
-- Every check FN-26 already performed (coveredByExportBatchId immutability, referenced-batch
-- kind=CORRECTION, referenced-batch same period as the correction's Timesheet) is preserved
-- unchanged below — see docs/titanor-time/05_RAW_SQL_REGISTER.md §13 (FN-26 entry, extended, not
-- replaced) for the full before/after text.
--
-- Legacy repair: any pre-existing row with pendingExport=true whose participant is missing or
-- expected=false is atomically corrected to pendingExport=false, coveredByExportBatchId=NULL (the
-- latter is already guaranteed NULL by CK-45 whenever pendingExport=true — set explicitly anyway,
-- per spec, for defense-in-depth). The affected row COUNT is reported via RAISE NOTICE — no
-- employee/correction/reason data, only an integer.

-- ============================================================================
-- Section A — legacy data repair (before enforcement changes, so a subsequent read of this
-- migration's own history shows the count that was actually repaired).
-- ============================================================================

DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected_count
  FROM "CorrectionRequest" cr
  JOIN "Timesheet" t ON t."id" = cr."timesheetId"
  LEFT JOIN "PayrollPeriodParticipant" ppp
    ON ppp."periodId" = t."periodId" AND ppp."employeeId" = t."employeeId"
  WHERE cr."pendingExport" = true
    AND (ppp."expected" IS NULL OR ppp."expected" = false);

  RAISE NOTICE 'T8.4B FOLLOW-UP: repairing % legacy CorrectionRequest row(s) with pendingExport=true for a missing/excluded participant', affected_count;
END $$;

UPDATE "CorrectionRequest" cr
SET "pendingExport" = false, "coveredByExportBatchId" = NULL
FROM "Timesheet" t
LEFT JOIN "PayrollPeriodParticipant" ppp
  ON ppp."periodId" = t."periodId" AND ppp."employeeId" = t."employeeId"
WHERE cr."timesheetId" = t."id"
  AND cr."pendingExport" = true
  AND (ppp."expected" IS NULL OR ppp."expected" = false);

-- ============================================================================
-- Section B — FN-26 extended (same function/trigger identifiers as T8.4A/T8.4B — TRG-31 stays
-- BEFORE INSERT OR UPDATE on CorrectionRequest, not a new trigger instance).
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_correction_request_covered_batch_check()
RETURNS trigger AS $$
DECLARE
  batch_kind "ExportBatchKind";
  batch_period_id UUID;
  ts_period_id UUID;
  ts_period_status "PayrollPeriodStatus";
  participant_expected BOOLEAN;
BEGIN
  -- [unchanged, T8.4B] Immutability of coveredByExportBatchId once set.
  IF TG_OP = 'UPDATE' AND OLD."coveredByExportBatchId" IS NOT NULL
     AND NEW."coveredByExportBatchId" IS DISTINCT FROM OLD."coveredByExportBatchId" THEN
    RAISE EXCEPTION 'CORRECTION_REQUEST_COVERED_BATCH_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  -- [unchanged, T8.4B] Reference validation at the NULL -> value transition: batch exists, is
  -- kind=CORRECTION, and belongs to the same period as this correction's own Timesheet.
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

  -- [NEW, T8.4B FOLLOW-UP] pendingExport=true eligibility — cross-table conditions a CHECK cannot
  -- express (ck_correction_request_pending_export_shape, CK-45, already covers the same-row
  -- conditions: status=APPROVED, resultingVersionId IS NOT NULL, coveredByExportBatchId IS NULL —
  -- not reimplemented here). Re-validated on every INSERT/UPDATE where pendingExport ends up true
  -- (not only at a false->true transition) — pendingExport is expected to flip true/false over a
  -- row's lifetime (unlike coveredByExportBatchId, which is genuinely write-once), so this is the
  -- correct, conservative scope for the check.
  IF NEW."pendingExport" THEN
    SELECT pp."status", ppp."expected"
    INTO ts_period_status, participant_expected
    FROM "Timesheet" t
    JOIN "PayrollPeriod" pp ON pp."id" = t."periodId"
    LEFT JOIN "PayrollPeriodParticipant" ppp ON ppp."periodId" = t."periodId" AND ppp."employeeId" = t."employeeId"
    WHERE t."id" = NEW."timesheetId";

    -- Structurally unreachable through the exposed application path (Timesheet.timesheetId is a
    -- NOT NULL FK to an always-existing Timesheet row, and Timesheet(periodId, employeeId) has its
    -- own composite FK to PayrollPeriodParticipant, so a Timesheet can never exist without a
    -- matching participant) — kept as defense-in-depth and for direct-SQL testability, same
    -- reasoning as FN-25's own correction-chain cycle check.
    IF ts_period_status IS NULL THEN
      RAISE EXCEPTION 'CORRECTION_REQUEST_PENDING_EXPORT_TIMESHEET_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF ts_period_status != 'EXPORTED' THEN
      RAISE EXCEPTION 'CORRECTION_REQUEST_PENDING_EXPORT_PERIOD_NOT_EXPORTED' USING ERRCODE = 'P0001';
    END IF;
    IF participant_expected IS NULL THEN
      RAISE EXCEPTION 'CORRECTION_REQUEST_PENDING_EXPORT_PARTICIPANT_NOT_FOUND' USING ERRCODE = 'P0001';
    END IF;
    IF NOT participant_expected THEN
      RAISE EXCEPTION 'CORRECTION_REQUEST_PENDING_EXPORT_PARTICIPANT_EXCLUDED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger instance (TRG-31) is unchanged — CREATE OR REPLACE FUNCTION above already rebinds its
-- existing body; no DROP/CREATE TRIGGER needed.
