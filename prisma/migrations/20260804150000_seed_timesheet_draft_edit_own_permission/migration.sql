-- Titanor Time — migration: seed timesheet.draft.edit.own permission
--
-- Pure data (DML), no schema change. PATCH /api/worker/timesheets/:timesheetId/days/:date
-- (04_ADMIN_FIRST_API_CONTRACTS.md §9) requires timesheet.draft.edit.own per
-- 02_ROLE_PERMISSION_MATRIX.md, held by WORKER only — deliberately separate from
-- timesheet.read.own (v5.2 mistakenly hung this mutation off the read permission).

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.draft.edit.own', 'Edit a day of own TimesheetDraft (PATCH .../days/:date) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code = 'timesheet.draft.edit.own';
