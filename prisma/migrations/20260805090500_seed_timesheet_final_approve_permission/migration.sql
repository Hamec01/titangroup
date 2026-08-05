-- Titanor Time — migration: seed timesheet.final_approve permission
--
-- Pure data (DML), no schema change. POST /api/admin/timesheets/:timesheetId/final-approve
-- (01_SCREEN_MAP.md §2) requires timesheet.final_approve per 02_ROLE_PERMISSION_MATRIX.md,
-- held by ADMIN and SUPER_ADMIN. Clean FOREMAN_APPROVED -> FINAL_APPROVED transition, never
-- changes hour data.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.final_approve', 'Clean FOREMAN_APPROVED -> FINAL_APPROVED transition — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'timesheet.final_approve';
