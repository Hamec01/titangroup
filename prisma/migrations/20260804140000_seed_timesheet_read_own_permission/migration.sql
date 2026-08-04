-- Titanor Time — migration: seed timesheet.read.own permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804120000_seed_worker_read_own_permission. GET /api/worker/timesheets/:timesheetId,
-- .../draft and .../current-version (04_ADMIN_FIRST_API_CONTRACTS.md §9) require
-- timesheet.read.own per 02_ROLE_PERMISSION_MATRIX.md, held by WORKER only.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.read.own', 'Read own Timesheet summary/draft/current-version — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code = 'timesheet.read.own';
