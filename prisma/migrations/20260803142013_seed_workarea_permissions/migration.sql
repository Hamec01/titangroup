-- Titanor Time — migration: seed workarea.read.all + workarea.create + workarea.update permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260803125804_seed_site_read_all_update_permissions.
-- GET/POST /api/admin/sites/:siteId/work-areas and
-- PATCH /api/admin/sites/:siteId/work-areas/:workAreaId
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3) require these three
-- permission codes per 02_ROLE_PERMISSION_MATRIX.md §2.2 ("Объекты"), all
-- held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('workarea.read.all', 'Read all work areas — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('workarea.create', 'Create a work area within a site — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('workarea.update', 'Edit a work area''s name/active — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('workarea.read.all', 'workarea.create', 'workarea.update');
