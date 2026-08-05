-- Titanor Time — migration: seed timesheet.return permission
--
-- Pure data (DML), no schema change. POST /api/admin/timesheets/:timesheetId/return
-- (03_DATA_MODEL_ERD.md §4.7 "Admin override-возврат всего табеля") requires timesheet.return
-- per 02_ROLE_PERMISSION_MATRIX.md. That matrix row also lists FOREMAN for their own
-- scope-level return, but no /api/foreman/* route exists yet to consume it — seeded for
-- ADMIN/SUPER_ADMIN only here, the only role with a real endpoint today.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.return', 'Admin override-return of a whole Timesheet from FOREMAN_APPROVED, forcing every scope of the current version to RETURNED — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held here by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'timesheet.return';
