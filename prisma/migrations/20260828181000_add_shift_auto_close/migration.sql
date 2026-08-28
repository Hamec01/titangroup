-- Titanor Time — auto-close an abandoned shift (see 20260828180000_add_shift_auto_close_enum).
--
-- - autoCloseShiftFallbackHours: when the worker's schedule template has no usable planned end for
--   that day (no template, day off, or a planned end that is already before check-in), the shift is
--   closed at openedAt + this many hours instead. 8 = a normal working day. CHECK 1..24; the value
--   is additionally capped at maxShiftDurationHours at compute time.
-- - ux_attendance_exception_auto_closed_shift_dedup: one open SHIFT_AUTO_CLOSED_MAX_DURATION per
--   opening ClockEvent, so a re-run of the pass never double-raises it.

ALTER TABLE "CompanyAttendancePolicy" ADD COLUMN "autoCloseShiftFallbackHours" INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "CompanyAttendancePolicy"
  ADD CONSTRAINT "ck_company_attendance_policy_auto_close_fallback_hours_range"
  CHECK ("autoCloseShiftFallbackHours" BETWEEN 1 AND 24);

CREATE UNIQUE INDEX "ux_attendance_exception_auto_closed_shift_dedup"
  ON "AttendanceException" ("clockEventId")
  WHERE type = 'SHIFT_AUTO_CLOSED_MAX_DURATION' AND "clockEventId" IS NOT NULL;
