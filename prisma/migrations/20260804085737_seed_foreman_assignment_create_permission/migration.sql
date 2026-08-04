-- Titanor Time — migration: seed foreman_assignment.create permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804065030_seed_assignment_end_permission. POST
-- /api/admin/foreman-assignments (contract designed by this task,
-- confirmed by the owner — not documented in
-- 04_ADMIN_FIRST_API_CONTRACTS.md) requires foreman_assignment.create per
-- 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('foreman_assignment.create', 'Assign a foreman (or substitute) to a site — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'foreman_assignment.create';
