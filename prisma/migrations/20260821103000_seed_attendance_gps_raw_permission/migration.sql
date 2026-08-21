INSERT INTO "Permission" ("code", "description") VALUES
  ('attendance.gps.read.raw', 'Read retained raw worker Check In/Out GPS coordinates on the restricted admin map')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r CROSS JOIN "Permission" p
WHERE r."name" IN ('ADMIN', 'SUPER_ADMIN') AND p."code" = 'attendance.gps.read.raw'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
