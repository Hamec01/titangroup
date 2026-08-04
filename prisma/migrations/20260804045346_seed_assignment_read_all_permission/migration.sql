-- Titanor Time — migration: seed assignment.read.all permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260803152219_seed_assignment_create_permission. GET /api/admin/assignments
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6) requires
-- assignment.read.all per 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and
-- SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('assignment.read.all', 'Read all site assignments — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'assignment.read.all';
