-- Titanor Time — T10-D safety net (docs/titanor-time/T10_DEF_PLAN.md §D).
--
-- The automatic unpaid lunch is sourced from the schedule template's planned break
-- (TimesheetPlannedShift.plannedBreakMinutes). If a SiteAssignment has NO template attached, its
-- planned shifts carry plannedBreakMinutes = 0 and the deduction silently never fires — payroll
-- then sees full hours on a long day with no logged break. That is exactly the kind of error that
-- must not reach a real pay run.
--
-- Fix: a company-wide default. When a day's planned break is 0 AND not explicitly marked paid, the
-- auto-deduction falls back to autoUnpaidBreakMinutes (30 = Finnish lunch norm). A template that
-- sets its own plannedBreakMinutes, or ticks "обед оплачивается" (plannedBreakPaid), still wins.
-- Set to 0 to disable the fallback entirely (template-only behaviour).
--
-- Additive, DEFAULT 30, CHECK 0..1440. Existing timesheets keep their numbers until a
-- report / export / dashboard / card read recomputes on the fly.

ALTER TABLE "CompanyAttendancePolicy" ADD COLUMN "autoUnpaidBreakMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "CompanyAttendancePolicy"
  ADD CONSTRAINT "ck_company_attendance_policy_auto_unpaid_break_minutes_range"
  CHECK ("autoUnpaidBreakMinutes" BETWEEN 0 AND 1440);
