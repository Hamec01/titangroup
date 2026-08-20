-- T9.7 physical-device acceptance follow-up: close the previously documented gap between
-- POST /api/admin/cities and its permission matrix entry. Pure additive DML; no schema change.

INSERT INTO "Permission" ("code", "description") VALUES
  ('city.create', 'Create cities — held by ADMIN and SUPER_ADMIN')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'city.create'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
