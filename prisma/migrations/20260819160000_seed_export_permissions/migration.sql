-- Titanor Time — migration: seed period.export + export.create + export.read permissions
--
-- Pure data (DML), no schema change — same pattern as 20260819000000_seed_site_period_read_
-- assigned_permissions. T8.4A (docs/titanor-time/T8_REPORTS_DESIGN.md Addendum "T8.4A") — schema
-- foundation only; these permissions have no consuming endpoint yet (T8.4B adds the create/download
-- API that will require them). Verified by direct SQL against a disposable database before writing
-- this migration: none of the three codes existed (zero Permission rows, zero RolePermission
-- grants).
--
-- Held by ADMIN and SUPER_ADMIN only. FOREMAN/WORKER get zero new grants. SYSTEM (userKind='SYSTEM')
-- never holds a Role at all in this schema, so it structurally cannot receive these either.

INSERT INTO "Permission" ("code", "description") VALUES
  ('period.export', 'Export a payroll period''s worked-time data as a CSV batch — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('export.create', 'Create a new ExportBatch (FULL or CORRECTION) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('export.read', 'Read/list/download existing ExportBatch history — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('period.export', 'export.create', 'export.read');
