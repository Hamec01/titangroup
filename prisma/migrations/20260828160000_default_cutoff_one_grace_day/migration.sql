-- Titanor Time — T12: the worker owns the timesheet for the whole cycle + one grace day.
-- (docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md — owner model 2026-08-28.)
--
-- cutoffDaysAfterPeriodEnd 0 -> 1: a Mon–Sun weekly timesheet now auto-submits at 23:59 the
-- FOLLOWING Monday (8 editable days) instead of Sunday 23:59; a 14-day cycle at day 15. Also
-- moves the existing singleton row so the pilot picks it up without a manual UPDATE.

ALTER TABLE "CompanyAttendancePolicy" ALTER COLUMN "cutoffDaysAfterPeriodEnd" SET DEFAULT 1;

UPDATE "CompanyAttendancePolicy" SET "cutoffDaysAfterPeriodEnd" = 1 WHERE "cutoffDaysAfterPeriodEnd" = 0;
