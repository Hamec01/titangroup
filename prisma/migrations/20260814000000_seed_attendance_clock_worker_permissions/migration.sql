-- Titanor Time — seed attendance.clock.{read,checkin,checkout,switch_site}.own permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260813000000_seed_attendance_geofence_permissions / 20260807120000_seed_template_update_permission.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1 lists all four as WORKER-only — ADMIN,
-- SUPER_ADMIN, FOREMAN and SYSTEM never get any of them (SYSTEM has no roles/permissions at all,
-- ck_user_system_shape/ux_user_single_system already guarantee that structurally). These gate the
-- new online clock endpoints (T7A online clock core):
--   GET  /api/worker/attendance/clock-state    -- attendance.clock.read.own
--   POST /api/worker/attendance/check-in       -- attendance.clock.checkin.own
--   POST /api/worker/attendance/check-out      -- attendance.clock.checkout.own
--   POST /api/worker/attendance/switch-site    -- attendance.clock.switch_site.own

INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.clock.read.own', 'Read own clock-state (open shift, if any) via GET /api/worker/attendance/clock-state — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1, held by WORKER only'),
  ('attendance.clock.checkin.own', 'Record own Check In via POST /api/worker/attendance/check-in — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1/§9.1, held by WORKER only'),
  ('attendance.clock.checkout.own', 'Record own Check Out via POST /api/worker/attendance/check-out — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1/§9.2, held by WORKER only'),
  ('attendance.clock.switch_site.own', 'Record own atomic Switch Site via POST /api/worker/attendance/switch-site — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1/§9.3, held by WORKER only');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code IN (
    'attendance.clock.read.own',
    'attendance.clock.checkin.own',
    'attendance.clock.checkout.own',
    'attendance.clock.switch_site.own'
  );
