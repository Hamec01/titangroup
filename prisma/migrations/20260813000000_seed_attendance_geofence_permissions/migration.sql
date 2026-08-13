-- Titanor Time — seed attendance.geofence.read / attendance.geofence.update permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260807120000_seed_template_update_permission / 20260806140000_seed_user_admin_permissions.
-- docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1 lists both as ADMIN/SUPER_ADMIN only —
-- FOREMAN and WORKER never get either. attendance.geofence.update creates a new immutable
-- WorkSiteGeofenceVersion (GET/POST /api/admin/sites/:siteId/geofence-versions), never rewrites an
-- existing one.

INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.geofence.read', 'Read a site''s current geofence and version history via GET /api/admin/sites/:siteId/geofence-versions — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1, held by ADMIN and SUPER_ADMIN'),
  ('attendance.geofence.update', 'Create a new immutable WorkSiteGeofenceVersion via POST /api/admin/sites/:siteId/geofence-versions — docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md §12.1, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('attendance.geofence.read', 'attendance.geofence.update');
