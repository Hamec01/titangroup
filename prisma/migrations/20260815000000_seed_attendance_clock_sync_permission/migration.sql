-- Titanor Time — seed attendance.clock.sync.own permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260814000000_seed_attendance_clock_worker_permissions / 20260813000000_seed_attendance_geofence_permissions.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1 lists this as WORKER-only — ADMIN,
-- SUPER_ADMIN, FOREMAN and SYSTEM never get it (SYSTEM has no roles/permissions at all,
-- ck_user_system_shape/ux_user_single_system already guarantee that structurally). Gates the new
-- offline batch sync endpoint (T7A.7A):
--   POST /api/worker/attendance/sync    -- attendance.clock.sync.own
--
-- GET /api/worker/attendance/context (device bootstrap) reuses the already-seeded
-- attendance.clock.read.own permission (20260814000000) — no new grant needed for it.

INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.clock.sync.own', 'Submit own offline attendance batch via POST /api/worker/attendance/sync — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1/§9.11, held by WORKER only');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code = 'attendance.clock.sync.own';
