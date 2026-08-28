-- Titanor Time — T13.2: seed the worker.profession.manage permission.
--
-- Pure data (DML), no schema change. Idempotent: ON CONFLICT DO NOTHING on the stable unique
-- columns (Permission.code / the RolePermission pair). Same pattern as every other permission seed
-- (docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md).
--
-- worker.profession.manage — add/remove a worker's professions. Held by ADMIN and SUPER_ADMIN
-- only; WORKER/FOREMAN never get it. A separate code (not worker.profile.update.all) so a future
-- HR/office role could manage professions without full profile-edit rights. Listing the catalog
-- (GET /api/admin/professions, GET .../professions) uses the existing worker.read.all.

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.profession.manage', 'Add or remove a worker''s professions (trade/speciality) - docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'worker.profession.manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
