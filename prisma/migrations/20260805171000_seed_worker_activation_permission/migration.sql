-- Titanor Time — seed worker.activation.generate permission
--
-- The activation endpoint is implemented in the preceding ActivationToken vertical slice and is
-- ADMIN/SUPER_ADMIN-only per docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.2.

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.activation.generate', 'Issue or replace a one-time worker activation code — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.2, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'worker.activation.generate';
