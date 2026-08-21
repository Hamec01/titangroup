-- Additive seed: two owner-confirmed submission cadences and their ADMIN/SUPER_ADMIN permissions.

INSERT INTO "TimesheetSubmissionSchedule"
  ("name", "cadence", "weekStartsOn", "anchorDate", "isCompanyDefault", "active", "version", "updatedAt")
VALUES
  ('Weekly', 'WEEKLY', 0, DATE '2020-01-06', true, true, 1, CURRENT_TIMESTAMP),
  ('Every two weeks', 'BIWEEKLY', 0, DATE '2020-01-06', false, true, 1, CURRENT_TIMESTAMP);

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.schedule.read', 'Read company and worker timesheet submission cadence (weekly/biweekly)'),
  ('timesheet.schedule.update', 'Change the company default or a worker timesheet submission cadence with effective-dated history'),
  ('period.update', 'Safely change dates of a legacy/manual OPEN payroll period when no durable data would fall outside the new range')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r."id", p."id"
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r."name" IN ('ADMIN', 'SUPER_ADMIN')
  AND p."code" IN ('timesheet.schedule.read', 'timesheet.schedule.update', 'period.update')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
