-- Titanor Time — fifth migration: seed session.revoke_all.own permission
--
-- Pure data (DML), no schema change. POST /api/auth/logout-all
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §1) has required
-- session.revoke_all.own since it was first implemented, but the permission
-- row didn't exist yet, so the endpoint was gated on "authenticated" only
-- (see IMPLEMENTATION_STATUS.md §9/§11 history). Per
-- docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.1, this permission's
-- holders are "все аутентифицированные" (all authenticated) — i.e. every one
-- of the four defined roles, not a subset like the admin-only permissions.

INSERT INTO "Permission" ("code", "description") VALUES
  ('session.revoke_all.own', 'Revoke all of one''s own sessions, including the current one — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.1, held by all authenticated roles');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('SUPER_ADMIN', 'ADMIN', 'FOREMAN', 'WORKER')
  AND p.code = 'session.revoke_all.own';
