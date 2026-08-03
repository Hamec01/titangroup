-- Titanor Time — migration: seed assignment.create permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260803142013_seed_workarea_permissions. POST /api/admin/assignments and
-- POST /api/admin/assignments/validate-overlap
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6) both require
-- assignment.create per 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and
-- SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('assignment.create', 'Create a site assignment for a worker — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'assignment.create';
