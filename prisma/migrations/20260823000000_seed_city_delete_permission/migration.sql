-- Allows ADMIN and SUPER_ADMIN to remove an unused City reference record.
-- The API refuses deletion while any WorkSite still references the City.

INSERT INTO "Permission" ("code", "description") VALUES
  ('city.delete', 'Delete unused cities — held by ADMIN and SUPER_ADMIN')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'city.delete'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
