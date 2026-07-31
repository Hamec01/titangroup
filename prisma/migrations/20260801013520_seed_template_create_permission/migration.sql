-- Titanor Time — tenth migration: seed template.create permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260801005830_seed_site_create_permission. POST /api/admin/templates
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4) requires exactly
-- one permission code — template.create — per
-- 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('template.create', 'Create a work schedule template — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'template.create';
