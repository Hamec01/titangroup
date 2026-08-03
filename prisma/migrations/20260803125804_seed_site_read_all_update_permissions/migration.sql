-- Titanor Time — fourteenth migration: seed site.read.all + site.update permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260803123201_seed_worker_update_deactivate_permissions.
-- GET /api/admin/sites, GET /api/admin/sites/:siteId, and
-- PATCH /api/admin/sites/:siteId (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md
-- §3) require these two permission codes per 02_ROLE_PERMISSION_MATRIX.md
-- §2.2-equivalent (§3, "Объекты"), both held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('site.read.all', 'Read all work sites — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('site.update', 'Edit a work site''s name/city/address/description/active — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('site.read.all', 'site.update');
