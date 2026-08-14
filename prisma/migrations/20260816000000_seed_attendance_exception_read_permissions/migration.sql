-- Titanor Time — seed attendance.exception.read.{assigned,all} permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260815000000_seed_attendance_clock_sync_permission / 20260814000000_seed_attendance_clock_worker_permissions.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1 lists these as the read-only foundation
-- for future Exception Review (T7A.8A) — resolution permissions
-- (attendance.exception.resolve.assigned/.all), attendance.gps.read.raw, attendance.conflict.read,
-- timesheet.draft.edit.exception and attendance.policy.* are deliberately NOT seeded by this
-- migration; they belong to later slices (§16 item 8, not fully closed by this one).
--
--   GET /api/admin/attendance/exceptions[/:exceptionId]    -- attendance.exception.read.all
--   GET /api/foreman/attendance/exceptions[/:exceptionId]  -- attendance.exception.read.assigned
--
-- SYSTEM never gets a role (ck_user_system_shape/ux_user_single_system guarantee that
-- structurally), so it is not addressed here — same reasoning as every prior attendance.* seed.

INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.exception.read.assigned', 'Read AttendanceException rows with a provable link to one of the caller''s own current ForemanAssignment sites, without raw GPS — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1, held by FOREMAN only'),
  ('attendance.exception.read.all', 'Read all AttendanceException rows company-wide, without raw GPS — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §11/§12.1, held by ADMIN and SUPER_ADMIN only');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'FOREMAN'
  AND p.code = 'attendance.exception.read.assigned';

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'attendance.exception.read.all';
