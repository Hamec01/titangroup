-- Titanor Time — migration: seed period.read.all permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804110000_seed_period_create_permission. GET /api/admin/periods,
-- GET /api/admin/periods/current and GET /api/admin/periods/:periodId
-- (04_ADMIN_FIRST_API_CONTRACTS.md §7) require period.read.all per
-- 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('period.read.all', 'Read any payroll period (list, detail, current) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'period.read.all';
