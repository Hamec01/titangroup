-- Titanor Time — seed template.read.all permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260801013520_seed_template_create_permission. GET /api/admin/templates
-- and GET /api/admin/templates/:templateId (docs/titanor-time/
-- 04_ADMIN_FIRST_API_CONTRACTS.md §4) require exactly one permission code —
-- template.read.all — per 02_ROLE_PERMISSION_MATRIX.md §2.6, held by ADMIN
-- and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('template.read.all', 'Read all work schedule templates and their current version — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.6, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'template.read.all';
