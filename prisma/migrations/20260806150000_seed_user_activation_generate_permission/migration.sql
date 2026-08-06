-- Titanor Time — seed user.activation.generate permission
--
-- Pure data (DML), no schema change. Issues/reissues the one-time UserActivationToken code for a
-- standalone FOREMAN User (POST /api/admin/users/:userId/activation) — separate from, and does not
-- change, worker.activation.generate / ActivationToken.

INSERT INTO "Permission" ("code", "description") VALUES
  ('user.activation.generate', 'Issue or reissue a one-time activation code for a standalone FOREMAN User (employeeId IS NULL) via POST /api/admin/users/:userId/activation — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.12, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'user.activation.generate';
