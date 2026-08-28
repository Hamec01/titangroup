-- Titanor Time — T10-D: automatic unpaid lunch (docs/titanor-time/T10_DEF_PLAN.md §D).
--
-- Finland: a 07:00–15:30 shift is 8 PAID hours, not 8:30 — the 30-min lunch is unpaid. The break
-- model exists (BreakSegment.paid) but nothing is deducted automatically: if the worker doesn't
-- log a break, the whole shift counts, and payroll sees full hours with "Unpaid brk 0 h".
--
-- Fix: a worked day whose GROSS duration is >= CompanyAttendancePolicy.autoUnpaidBreakThresholdMinutes
-- and that has NO break logged gets its PLANNED break auto-deducted from worked time — UNLESS the
-- planned break is marked paid (plannedBreakPaid, a per-template-day flag copied onto the frozen /
-- draft planned shift so reports never join back to the template). All additive, all DEFAULT
-- false / 360 (= Finnish 6 h norm) so existing rows keep their current numbers until recomputed
-- on the fly by a report/export/dashboard read.

ALTER TABLE "WorkScheduleTemplateVersionDay" ADD COLUMN "plannedBreakPaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TimesheetPlannedShift"          ADD COLUMN "plannedBreakPaid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TimesheetDraftPlannedShift"     ADD COLUMN "plannedBreakPaid" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "CompanyAttendancePolicy" ADD COLUMN "autoUnpaidBreakThresholdMinutes" INTEGER NOT NULL DEFAULT 360;
ALTER TABLE "CompanyAttendancePolicy"
  ADD CONSTRAINT "ck_company_attendance_policy_auto_unpaid_break_threshold_range"
  CHECK ("autoUnpaidBreakThresholdMinutes" BETWEEN 0 AND 1440);
