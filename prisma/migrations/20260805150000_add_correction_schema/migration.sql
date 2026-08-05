-- CreateEnum
CREATE TYPE "CorrectionRequestStatus" AS ENUM ('PENDING', 'DRAFT_OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "CorrectionRequest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timesheetId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CorrectionRequestStatus" NOT NULL,
    "draftId" UUID,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "resultingVersionId" UUID,
    "approvalOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "pendingExport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CorrectionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionDraft" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "correctionRequestId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "basedOnVersionId" UUID NOT NULL,
    "openedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMPTZ(6),

    CONSTRAINT "CorrectionDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionDraftDay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "dayType" "DayType" NOT NULL,
    "confirmedZero" BOOLEAN NOT NULL DEFAULT false,
    "sourceAbsenceId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CorrectionDraftDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionDraftSegment" (
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

    CONSTRAINT "CorrectionDraftSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionDraftBreakSegment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "draftSegmentId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(6) NOT NULL,
    "endAt" TIMESTAMPTZ(6) NOT NULL,
    "paid" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CorrectionDraftBreakSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionRequest_draftId_key" ON "CorrectionRequest"("draftId");

-- CreateIndex
CREATE INDEX "CorrectionRequest_timesheetId_status_idx" ON "CorrectionRequest"("timesheetId", "status");

-- CreateIndex
CREATE INDEX "CorrectionRequest_requestedByUserId_idx" ON "CorrectionRequest"("requestedByUserId");

-- CreateIndex
CREATE INDEX "CorrectionRequest_decidedByUserId_idx" ON "CorrectionRequest"("decidedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionDraft_correctionRequestId_key" ON "CorrectionDraft"("correctionRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionDraft_id_employeeId_key" ON "CorrectionDraft"("id", "employeeId");

-- CreateIndex
CREATE INDEX "CorrectionDraftDay_sourceAbsenceId_idx" ON "CorrectionDraftDay"("sourceAbsenceId");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionDraftDay_draftId_date_key" ON "CorrectionDraftDay"("draftId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionDraftDay_id_draftId_key" ON "CorrectionDraftDay"("id", "draftId");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionDraftDay_id_draftId_date_key" ON "CorrectionDraftDay"("id", "draftId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionDraftDay_id_date_key" ON "CorrectionDraftDay"("id", "date");

-- CreateIndex
CREATE INDEX "CorrectionDraftSegment_draftDayId_draftId_idx" ON "CorrectionDraftSegment"("draftDayId", "draftId");

-- CreateIndex
CREATE INDEX "CorrectionDraftSegment_draftId_employeeId_idx" ON "CorrectionDraftSegment"("draftId", "employeeId");

-- CreateIndex
CREATE INDEX "CorrectionDraftSegment_sourceAssignmentId_employeeId_siteId_idx" ON "CorrectionDraftSegment"("sourceAssignmentId", "employeeId", "siteId");

-- CreateIndex
CREATE INDEX "CorrectionDraftSegment_siteId_date_idx" ON "CorrectionDraftSegment"("siteId", "date");

-- CreateIndex
CREATE INDEX "CorrectionDraftBreakSegment_draftSegmentId_idx" ON "CorrectionDraftBreakSegment"("draftSegmentId");

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_timesheetId_fkey" FOREIGN KEY ("timesheetId") REFERENCES "Timesheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_resultingVersionId_fkey" FOREIGN KEY ("resultingVersionId") REFERENCES "TimesheetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionRequest" ADD CONSTRAINT "CorrectionRequest_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CorrectionDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraft" ADD CONSTRAINT "CorrectionDraft_correctionRequestId_fkey" FOREIGN KEY ("correctionRequestId") REFERENCES "CorrectionRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraft" ADD CONSTRAINT "CorrectionDraft_basedOnVersionId_fkey" FOREIGN KEY ("basedOnVersionId") REFERENCES "TimesheetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraft" ADD CONSTRAINT "CorrectionDraft_openedByUserId_fkey" FOREIGN KEY ("openedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftDay" ADD CONSTRAINT "CorrectionDraftDay_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "CorrectionDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftDay" ADD CONSTRAINT "CorrectionDraftDay_sourceAbsenceId_fkey" FOREIGN KEY ("sourceAbsenceId") REFERENCES "Absence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftSegment" ADD CONSTRAINT "CorrectionDraftSegment_draftDayId_draftId_date_fkey" FOREIGN KEY ("draftDayId", "draftId", "date") REFERENCES "CorrectionDraftDay"("id", "draftId", "date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftSegment" ADD CONSTRAINT "CorrectionDraftSegment_draftId_employeeId_fkey" FOREIGN KEY ("draftId", "employeeId") REFERENCES "CorrectionDraft"("id", "employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftSegment" ADD CONSTRAINT "CorrectionDraftSegment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "WorkSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftSegment" ADD CONSTRAINT "CorrectionDraftSegment_siteId_workAreaId_fkey" FOREIGN KEY ("siteId", "workAreaId") REFERENCES "WorkArea"("siteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftSegment" ADD CONSTRAINT "CorrectionDraftSegment_sourceAssignmentId_employeeId_siteI_fkey" FOREIGN KEY ("sourceAssignmentId", "employeeId", "siteId") REFERENCES "SiteAssignment"("id", "employeeId", "siteId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionDraftBreakSegment" ADD CONSTRAINT "CorrectionDraftBreakSegment_draftSegmentId_fkey" FOREIGN KEY ("draftSegmentId") REFERENCES "CorrectionDraftSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Section B — raw SQL not expressible in Prisma schema syntax
-- (docs/titanor-time/03_DATA_MODEL_ERD.md §4.7 "CorrectionRequest"/"CorrectionDraft*",
-- §5 "Break-инварианты" — CorrectionDraftBreakSegment is explicitly one of the three
-- tables that section's invariants apply to)
-- ============================================================================

-- ck_correction_draft_segment_interval / ck_correction_draft_segment_local_date
-- Same shape as TimesheetDraftSegment's ck_timesheet_draft_segment_interval/_local_date.
ALTER TABLE "CorrectionDraftSegment"
  ADD CONSTRAINT "ck_correction_draft_segment_interval"
  CHECK ("endAt" > "startAt");

ALTER TABLE "CorrectionDraftSegment"
  ADD CONSTRAINT "ck_correction_draft_segment_local_date"
  CHECK ("date" = ("startAt" AT TIME ZONE 'Europe/Helsinki')::date);

-- ck_correction_draft_break_segment_interval
-- Same shape as TimesheetDraftBreakSegment's ck_timesheet_draft_break_segment_interval.
ALTER TABLE "CorrectionDraftBreakSegment"
  ADD CONSTRAINT "ck_correction_draft_break_segment_interval"
  CHECK ("endAt" > "startAt");

-- ck_correction_request_override_reason_shape
-- §4.7: approvalOverride=true requires overrideReason (SUPER_ADMIN four-eyes override).
-- approvalOverride is NOT NULL with a default, so no NULL-vs-FALSE CHECK gotcha here
-- (unlike ck_timesheet_review_scope_shape's scopePurpose lesson — that column is nullable).
ALTER TABLE "CorrectionRequest"
  ADD CONSTRAINT "ck_correction_request_override_reason_shape"
  CHECK (NOT "approvalOverride" OR "overrideReason" IS NOT NULL);

-- ex_correction_draft_segment_time_overlap
-- Same shape as TimesheetDraftSegment's ex_timesheet_draft_segment_time_overlap, scoped by
-- draftId — a second CorrectionDraft of the same employee (re-copying the same historical
-- interval as an already-approved first draft) does not conflict, different draftId.
ALTER TABLE "CorrectionDraftSegment"
  ADD CONSTRAINT "ex_correction_draft_segment_time_overlap"
  EXCLUDE USING gist (
    "draftId" WITH =,
    "employeeId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  );

-- ex_correction_draft_break_segment_time_overlap
-- Same shape as TimesheetDraftBreakSegment's ex_timesheet_draft_break_segment_time_overlap
-- (§5: breaks of the same parent segment must not overlap each other).
ALTER TABLE "CorrectionDraftBreakSegment"
  ADD CONSTRAINT "ex_correction_draft_break_segment_time_overlap"
  EXCLUDE USING gist (
    "draftSegmentId" WITH =,
    tstzrange("startAt", "endAt", '[)') WITH &&
  );

-- fn_correction_draft_day_state_check (day-side, CorrectionDraftDay)
-- Same shape as fn_timesheet_draft_day_state_check, querying CorrectionDraftSegment instead
-- of TimesheetDraftSegment — the existing function hard-codes its table name in the FROM
-- clause, so it cannot be reused as-is across different segment tables (unlike
-- fn_segment_assignment_scope_check below, which is generic and is reused directly).
-- Row-lock: target day row already locked by the UPDATE itself.
CREATE OR REPLACE FUNCTION fn_correction_draft_day_state_check()
RETURNS trigger AS $$
DECLARE
  v_segment_count integer;
BEGIN
  SELECT count(*) INTO v_segment_count
    FROM "CorrectionDraftSegment"
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

-- fn_correction_draft_segment_day_state_check (child-side, CorrectionDraftSegment)
-- Same shape as fn_timesheet_draft_segment_day_state_check.
-- Row-lock: parent CorrectionDraftDay FOR UPDATE, first action, before reading dayType/confirmedZero.
CREATE OR REPLACE FUNCTION fn_correction_draft_segment_day_state_check()
RETURNS trigger AS $$
DECLARE
  v_day RECORD;
BEGIN
  SELECT "dayType", "confirmedZero"
    INTO v_day
    FROM "CorrectionDraftDay"
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

-- fn_correction_draft_break_segment_containment_check (child-side, CorrectionDraftBreakSegment)
-- Same shape as fn_timesheet_draft_break_segment_containment_check.
-- Row-lock: parent segment FOR UPDATE, first action.
CREATE OR REPLACE FUNCTION fn_correction_draft_break_segment_containment_check()
RETURNS trigger AS $$
DECLARE
  v_parent RECORD;
BEGIN
  SELECT "startAt", "endAt"
    INTO v_parent
    FROM "CorrectionDraftSegment"
    WHERE "id" = NEW."draftSegmentId"
    FOR UPDATE;

  IF v_parent."startAt" > NEW."startAt" OR NEW."endAt" > v_parent."endAt" THEN
    RAISE EXCEPTION 'BREAK_OUTSIDE_PARENT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- fn_correction_draft_segment_breaks_guard — DEC-02 (parent-side)
-- Same shape as fn_timesheet_draft_segment_breaks_guard: prevents shrinking a segment
-- (UPDATE of startAt/endAt) below breaks that already exist inside it.
-- Parent: CorrectionDraftSegment. Child: CorrectionDraftBreakSegment.
-- Does not lock child break rows (FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE / FOR KEY SHARE forbidden).
CREATE OR REPLACE FUNCTION fn_correction_draft_segment_breaks_guard()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CorrectionDraftBreakSegment"
    WHERE "draftSegmentId" = NEW."id"
      AND (NEW."startAt" > "startAt" OR "endAt" > NEW."endAt")
  ) THEN
    RAISE EXCEPTION 'BREAK_OUTSIDE_PARENT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- fn_site_assignment_dependents_guard — closing a gap explicitly flagged in the frozen
-- initial migration's own comment ("CorrectionDraftSegment is out of current scope and is
-- not checked here"). Same defense-in-depth boundary check as the other three EXISTS
-- clauses, now covering the fourth dependent table.
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

  IF EXISTS (
    SELECT 1 FROM "CorrectionDraftSegment"
    WHERE "sourceAssignmentId" = NEW."id"
      AND ("date" < NEW."validFrom" OR "date" > v_valid_to)
  ) THEN
    RAISE EXCEPTION 'ASSIGNMENT_DEPENDENTS_CONFLICT' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- trg_segment_assignment_scope_check — third instance, reusing the existing generic
-- function as-is (same column shape as TimesheetDraftSegment/WorkSegment).
CREATE TRIGGER trg_segment_assignment_scope_check
  BEFORE INSERT OR UPDATE OF "sourceAssignmentId", "employeeId", "date", "siteId", "workAreaId"
  ON "CorrectionDraftSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_segment_assignment_scope_check();

CREATE TRIGGER trg_correction_draft_day_state_check
  BEFORE UPDATE OF "dayType", "confirmedZero"
  ON "CorrectionDraftDay"
  FOR EACH ROW
  WHEN (OLD."dayType" IS DISTINCT FROM NEW."dayType" OR OLD."confirmedZero" IS DISTINCT FROM NEW."confirmedZero")
  EXECUTE FUNCTION fn_correction_draft_day_state_check();

CREATE TRIGGER trg_correction_draft_segment_day_state_check
  BEFORE INSERT OR UPDATE OF "draftDayId", "draftId", "employeeId", "date", "startAt", "endAt", "siteId", "workAreaId", "sourceAssignmentId"
  ON "CorrectionDraftSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_correction_draft_segment_day_state_check();

CREATE TRIGGER trg_correction_draft_break_segment_containment_check
  BEFORE INSERT OR UPDATE OF "draftSegmentId", "startAt", "endAt"
  ON "CorrectionDraftBreakSegment"
  FOR EACH ROW
  EXECUTE FUNCTION fn_correction_draft_break_segment_containment_check();

CREATE TRIGGER trg_correction_draft_segment_breaks_guard
  BEFORE UPDATE OF "startAt", "endAt"
  ON "CorrectionDraftSegment"
  FOR EACH ROW
  WHEN (OLD."startAt" IS DISTINCT FROM NEW."startAt" OR OLD."endAt" IS DISTINCT FROM NEW."endAt")
  EXECUTE FUNCTION fn_correction_draft_segment_breaks_guard();
