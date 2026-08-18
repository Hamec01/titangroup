-- Titanor Time — seed attendance.policy.read / attendance.policy.update permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260818010000_seed_attendance_conflict_read_permission.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1 (row already listed there as
-- "not yet implemented") / Addendum "T7A.10A Attendance Auto-submit Backend + Company Policy API"
-- — gates:
--
--   GET   /api/admin/attendance/policy  -- attendance.policy.read
--   PATCH /api/admin/attendance/policy  -- attendance.policy.update
--
-- Both ADMIN and SUPER_ADMIN only. FOREMAN and WORKER receive neither — CompanyAttendancePolicy
-- (cutoff/debounce/max-shift-duration tuning) is an operational/administrative concern, not
-- something either role has ever needed read or write access to in this project. SYSTEM never
-- gets a role (ck_user_system_shape/ux_user_single_system guarantee that structurally), so it is
-- not addressed here — same reasoning as every prior attendance.* permission seed.

INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.policy.read', 'Read CompanyAttendancePolicy (cutoff/debounce/max-shift-duration settings) via GET /api/admin/attendance/policy — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1, held by ADMIN and SUPER_ADMIN only.'),
  ('attendance.policy.update', 'Update CompanyAttendancePolicy (cutoffDaysAfterPeriodEnd/cutoffTime/systemReopenDebounceMinutes/maxShiftDurationHours only — timezone is frozen and never accepted) via PATCH /api/admin/attendance/policy — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1, held by ADMIN and SUPER_ADMIN only.');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('attendance.policy.read', 'attendance.policy.update');
