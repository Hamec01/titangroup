-- Titanor Time — seed attendance.exception.resolve.{assigned,all} permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260816000000_seed_attendance_exception_read_permissions.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1 — gates T7A.8B.1's two base
-- resolution actions (DISMISS, ACKNOWLEDGE_AS_VALID) only. The remaining four actions
-- (PAIR_ORPHAN_EVENTS, CONFIRM_SOURCE_ASSIGNMENT, REASON_EDIT, FORCE_CLOSE_OPEN_SHIFT),
-- attendance.gps.read.raw, attendance.conflict.read, timesheet.draft.edit.exception and
-- attendance.policy.* are deliberately NOT seeded here — later slices.
--
--   POST /api/admin/attendance/exceptions/:exceptionId/resolve    -- attendance.exception.resolve.all (+ .read.all)
--   POST /api/foreman/attendance/exceptions/:exceptionId/resolve  -- attendance.exception.resolve.assigned (+ .read.assigned)
--
-- Resolve does NOT imply read and vice versa — both routes require BOTH the matching read.* and
-- resolve.* permission (a caller who only has resolve.* but was stripped of read.* is still gated
-- out, and a read-only caller can never mutate).
--
-- SYSTEM never gets a role (ck_user_system_shape/ux_user_single_system guarantee that
-- structurally), so it is not addressed here — same reasoning as every prior attendance.* seed.

INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.exception.resolve.assigned', 'Resolve (DISMISS/ACKNOWLEDGE_AS_VALID only, T7A.8B.1) AttendanceException rows with a provable link to ALL of the caller''s own current ForemanAssignment sites — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5/§11/§12.1, held by FOREMAN only. Does not grant read — attendance.exception.read.assigned is required separately.'),
  ('attendance.exception.resolve.all', 'Resolve (DISMISS/ACKNOWLEDGE_AS_VALID only, T7A.8B.1) any AttendanceException row company-wide — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §8.5/§11/§12.1, held by ADMIN and SUPER_ADMIN only. Does not grant read — attendance.exception.read.all is required separately.');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'FOREMAN'
  AND p.code = 'attendance.exception.resolve.assigned';

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'attendance.exception.resolve.all';
