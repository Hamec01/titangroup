-- Titanor Time — seed user.read / user.create.foreman permissions
--
-- Pure data (DML), no schema change. docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.12 lists
-- both as ADMIN/SUPER_ADMIN. user.create.foreman only ever creates/grants the FOREMAN role
-- (standalone User or dual-role on an existing worker's User) — ADMIN/SUPER_ADMIN creation and
-- general role.assign are separate, later slices.

INSERT INTO "Permission" ("code", "description") VALUES
  ('user.read', 'List system users (FOREMAN/ADMIN/SUPER_ADMIN, incl. dual-role FOREMAN+WORKER) via GET /api/admin/users — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.12, held by ADMIN and SUPER_ADMIN'),
  ('user.create.foreman', 'Create a standalone FOREMAN User or grant the FOREMAN role to an existing worker''s User via POST /api/admin/users — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.12, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('user.read', 'user.create.foreman');
