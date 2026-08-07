-- Titanor Time — seed template.update permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260807090000_seed_template_read_all_permission. PATCH /api/admin/templates/:templateId
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §4) requires exactly one permission code —
-- template.update — per 02_ROLE_PERMISSION_MATRIX.md §2.6, held by ADMIN and SUPER_ADMIN. Creates
-- a new immutable WorkScheduleTemplateVersion, never rewrites an existing one.

INSERT INTO "Permission" ("code", "description") VALUES
  ('template.update', 'Create a new immutable version of a work schedule template via PATCH /api/admin/templates/:templateId — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.6, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'template.update';
