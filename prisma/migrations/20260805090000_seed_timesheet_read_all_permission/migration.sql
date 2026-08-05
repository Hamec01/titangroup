-- Titanor Time — migration: seed timesheet.read.all permission
--
-- Pure data (DML), no schema change. GET /api/admin/timesheets[/:timesheetId]
-- (01_SCREEN_MAP.md §2) require timesheet.read.all per 02_ROLE_PERMISSION_MATRIX.md,
-- held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.read.all', 'Read any Timesheet, all scopes including NON_SITE — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'timesheet.read.all';
