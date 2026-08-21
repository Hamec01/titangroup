-- T9 physical pilot follow-up: worker-specific weekly/biweekly timesheet submission schedules.
-- Existing PayrollPeriod rows remain legacy/manual (submissionScheduleId IS NULL).

CREATE TYPE "TimesheetSubmissionCadence" AS ENUM ('WEEKLY', 'BIWEEKLY');

CREATE TABLE "TimesheetSubmissionSchedule" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" varchar(80) NOT NULL,
  "cadence" "TimesheetSubmissionCadence" NOT NULL,
  "weekStartsOn" integer NOT NULL DEFAULT 0,
  "anchorDate" date NOT NULL,
  "isCompanyDefault" boolean NOT NULL DEFAULT false,
  "active" boolean NOT NULL DEFAULT true,
  "version" integer NOT NULL DEFAULT 1,
  "createdByUserId" uuid,
  "updatedByUserId" uuid,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz(6) NOT NULL,
  CONSTRAINT "TimesheetSubmissionSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_timesheet_submission_schedule_week_start" CHECK ("weekStartsOn" BETWEEN 0 AND 6),
  CONSTRAINT "ck_timesheet_submission_schedule_anchor_alignment" CHECK (((EXTRACT(ISODOW FROM "anchorDate")::integer - 1) = "weekStartsOn")),
  CONSTRAINT "ck_timesheet_submission_schedule_version" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "ux_timesheet_submission_schedule_company_default"
  ON "TimesheetSubmissionSchedule" ("isCompanyDefault")
  WHERE "isCompanyDefault" = true;
CREATE INDEX "TimesheetSubmissionSchedule_active_cadence_idx"
  ON "TimesheetSubmissionSchedule" ("active", "cadence");

CREATE TABLE "EmployeeTimesheetSchedule" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "employeeId" uuid NOT NULL,
  "scheduleId" uuid NOT NULL,
  "effectiveFrom" date NOT NULL,
  "effectiveTo" date,
  "assignedByUserId" uuid NOT NULL,
  "createdAt" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeTimesheetSchedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_employee_timesheet_schedule_dates" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

CREATE UNIQUE INDEX "EmployeeTimesheetSchedule_employeeId_effectiveFrom_key"
  ON "EmployeeTimesheetSchedule" ("employeeId", "effectiveFrom");
CREATE INDEX "EmployeeTimesheetSchedule_scheduleId_effectiveFrom_effectiveTo_idx"
  ON "EmployeeTimesheetSchedule" ("scheduleId", "effectiveFrom", "effectiveTo");

ALTER TABLE "EmployeeTimesheetSchedule"
  ADD CONSTRAINT "EmployeeTimesheetSchedule_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeTimesheetSchedule_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "TimesheetSubmissionSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeTimesheetSchedule_assignedByUserId_fkey"
  FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeTimesheetSchedule"
  ADD CONSTRAINT "ex_employee_timesheet_schedule_date_overlap"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    daterange("effectiveFrom", COALESCE("effectiveTo" + 1, 'infinity'::date), '[)') WITH &&
  );

ALTER TABLE "PayrollPeriod" ADD COLUMN "submissionScheduleId" uuid;
ALTER TABLE "PayrollPeriod"
  ADD CONSTRAINT "PayrollPeriod_submissionScheduleId_fkey"
  FOREIGN KEY ("submissionScheduleId") REFERENCES "TimesheetSubmissionSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "PayrollPeriod_submissionScheduleId_status_startDate_endDate_idx"
  ON "PayrollPeriod" ("submissionScheduleId", "status", "startDate", "endDate");
CREATE UNIQUE INDEX "PayrollPeriod_submissionScheduleId_startDate_endDate_key"
  ON "PayrollPeriod" ("submissionScheduleId", "startDate", "endDate");

-- The old company-wide constraint made two cohorts (weekly and biweekly) impossible. The new
-- trigger below narrows the invariant to the actual business rule: one expected worker cannot be
-- in two overlapping periods, while different workers may use overlapping schedule periods.
ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "ex_payroll_period_date_overlap";

CREATE OR REPLACE FUNCTION "fn_payroll_period_participant_employee_overlap_check"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_start date;
  v_end date;
  v_conflict uuid;
BEGIN
  IF NOT NEW."expected" THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM "Employee" WHERE "id" = NEW."employeeId" FOR UPDATE;
  SELECT "startDate", "endDate" INTO v_start, v_end
  FROM "PayrollPeriod" WHERE "id" = NEW."periodId";

  SELECT pp."periodId" INTO v_conflict
  FROM "PayrollPeriodParticipant" pp
  JOIN "PayrollPeriod" p ON p."id" = pp."periodId"
  WHERE pp."employeeId" = NEW."employeeId"
    AND pp."expected" = true
    AND pp."id" <> NEW."id"
    AND daterange(p."startDate", p."endDate" + 1, '[)') && daterange(v_start, v_end + 1, '[)')
  ORDER BY pp."periodId"
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_PARTICIPANT_DATE_OVERLAP' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_payroll_period_participant_employee_overlap_check"
BEFORE INSERT OR UPDATE OF "periodId", "employeeId", "expected"
ON "PayrollPeriodParticipant"
FOR EACH ROW EXECUTE FUNCTION "fn_payroll_period_participant_employee_overlap_check"();

CREATE OR REPLACE FUNCTION "fn_payroll_period_date_update_participant_overlap_check"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_conflict uuid;
BEGIN
  IF NEW."startDate" = OLD."startDate" AND NEW."endDate" = OLD."endDate" THEN
    RETURN NEW;
  END IF;

  PERFORM e."id"
  FROM "Employee" e
  JOIN "PayrollPeriodParticipant" mine ON mine."employeeId" = e."id"
  WHERE mine."periodId" = NEW."id" AND mine."expected" = true
  ORDER BY e."id"
  FOR UPDATE OF e;

  SELECT mine."employeeId" INTO v_conflict
  FROM "PayrollPeriodParticipant" mine
  JOIN "PayrollPeriodParticipant" other
    ON other."employeeId" = mine."employeeId"
   AND other."expected" = true
   AND other."periodId" <> mine."periodId"
  JOIN "PayrollPeriod" other_period ON other_period."id" = other."periodId"
  WHERE mine."periodId" = NEW."id"
    AND mine."expected" = true
    AND daterange(other_period."startDate", other_period."endDate" + 1, '[)')
        && daterange(NEW."startDate", NEW."endDate" + 1, '[)')
  ORDER BY mine."employeeId"
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_PARTICIPANT_DATE_OVERLAP' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_payroll_period_date_update_participant_overlap_check"
BEFORE UPDATE OF "startDate", "endDate"
ON "PayrollPeriod"
FOR EACH ROW EXECUTE FUNCTION "fn_payroll_period_date_update_participant_overlap_check"();

ALTER TABLE "TimesheetSubmissionSchedule"
  ADD CONSTRAINT "TimesheetSubmissionSchedule_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "TimesheetSubmissionSchedule_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
