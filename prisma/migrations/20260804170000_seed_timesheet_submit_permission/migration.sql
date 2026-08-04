-- Titanor Time — migration: seed timesheet.submit permission
--
-- Pure data (DML), no schema change. POST /api/worker/timesheets/:timesheetId/submit
-- (04_ADMIN_FIRST_API_CONTRACTS.md §9) requires timesheet.submit per
-- 02_ROLE_PERMISSION_MATRIX.md, held by WORKER only.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.submit', 'Submit own TimesheetDraft, freezing it into a TimesheetVersion — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code = 'timesheet.submit';
