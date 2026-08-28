-- Titanor Time — auto-close an abandoned shift (owner ask 2026-08-28: "если работник не сделал
-- чек-аут, ставится время в табель автоматом; чек-аут уходит после 16 часов").
--
-- A scheduler pass closes an EmployeeOpenShift that has been open longer than
-- CompanyAttendancePolicy.maxShiftDurationHours (16), writing the day's planned end time from the
-- worker's schedule template as a PROVISIONAL end. A real check-out arriving later still wins
-- (it revises the provisional shift). The admin sees a SHIFT_AUTO_CLOSED_MAX_DURATION exception.
--
-- The enum value is added in its own migration so a later one can reference it in an index
-- predicate (Postgres forbids using a just-added enum label inside the same transaction).

ALTER TYPE "AttendanceExceptionType" ADD VALUE IF NOT EXISTS 'SHIFT_AUTO_CLOSED_MAX_DURATION';
