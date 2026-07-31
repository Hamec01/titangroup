-- Titanor Time — ninth migration: seed site.create permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260730221710_seed_city_read_all_permission. POST /api/admin/sites
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §3) requires exactly
-- one permission code — site.create — per
-- 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('site.create', 'Create a work site — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'site.create';
