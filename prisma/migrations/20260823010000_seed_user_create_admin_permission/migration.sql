-- Titanor Time — seed user.create.admin permission
--
-- Pure data (DML), no schema change. Mirrors 20260806140000_seed_user_admin_permissions'
-- user.create.foreman exactly, one level up the hierarchy: creates a standalone ADMIN User
-- (PENDING_ACTIVATION, same activation-code flow as a standalone FOREMAN). Held by SUPER_ADMIN
-- ONLY, not ADMIN — an ADMIN can create FOREMAN/WORKER accounts (user.create.foreman, worker
-- creation) but must never be able to create another ADMIN. This is the "ADMIN/SUPER_ADMIN
-- creation... separate, later slice" that migration's own comment already called out.

INSERT INTO "Permission" ("code", "description") VALUES
  ('user.create.admin', 'Create a standalone ADMIN User via POST /api/admin/users/admins — held by SUPER_ADMIN only, never ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.code = 'user.create.admin';
