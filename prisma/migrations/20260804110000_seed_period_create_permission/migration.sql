-- Titanor Time — migration: seed period.create permission
--
-- Pure data (DML), no schema change. POST /api/admin/periods
-- (04_ADMIN_FIRST_API_CONTRACTS.md §7, PROJECT_ROADMAP.md ЭТАП 7 first
-- sub-task) requires period.create per 02_ROLE_PERMISSION_MATRIX.md, held
-- by ADMIN and SUPER_ADMIN. PayrollPeriod/Timesheet/TimesheetDraft* tables
-- already exist (created in the frozen initial migration) — only the
-- permission code is new here.

INSERT INTO "Permission" ("code", "description") VALUES
  ('period.create', 'Open a new payroll period, generating PayrollPeriodParticipant+Timesheet(DRAFT)+TimesheetDraft for every employee with an intersecting SiteAssignment — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'period.create';
