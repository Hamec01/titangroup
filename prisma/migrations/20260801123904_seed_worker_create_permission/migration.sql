-- Titanor Time — twelfth migration: seed worker.create permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260801005830_seed_site_create_permission /
-- 20260801013520_seed_template_create_permission. POST /api/admin/workers
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5) requires exactly
-- one permission code — worker.create — per
-- 02_ROLE_PERMISSION_MATRIX.md §2.2, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.create', 'Create a worker (Employee+User+Employment) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.2, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'worker.create';
