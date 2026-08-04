-- Titanor Time — migration: seed foreman_assignment.read.all permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804085737_seed_foreman_assignment_create_permission. GET
-- /api/admin/foreman-assignments (contract designed by this task,
-- confirmed by the owner) requires foreman_assignment.read.all per
-- 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('foreman_assignment.read.all', 'Read all foreman assignments — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'foreman_assignment.read.all';
