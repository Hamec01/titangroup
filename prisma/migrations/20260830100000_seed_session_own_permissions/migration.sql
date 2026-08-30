-- Titanor Time — R03.7: self-service session management permissions (TZ §6.1/§6.2).
--
-- session.revoke_all.own already exists (migration 20260821..._seed... "выйти на всех
-- устройствах"). These two add the read + single-revoke that the profile "Active sessions" panel
-- needs. Held by every authenticated role — a worker manages their own sessions exactly like an
-- admin does. Pure DML, idempotent.

INSERT INTO "Permission" ("code", "description") VALUES
  ('session.read.own', 'List one''s own active sessions with device/IP metadata - docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.1, held by all authenticated roles'),
  ('session.revoke.own', 'Revoke one of one''s own other sessions - docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.1, held by all authenticated roles')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('WORKER', 'FOREMAN', 'ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('session.read.own', 'session.revoke.own')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
