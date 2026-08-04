-- Titanor Time — migration: seed period.read.own permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804120000_seed_worker_read_own_permission. GET /api/worker/periods/current and
-- GET /api/worker/periods/actionable (04_ADMIN_FIRST_API_CONTRACTS.md §9) require
-- period.read.own per 02_ROLE_PERMISSION_MATRIX.md, held by WORKER only.

INSERT INTO "Permission" ("code", "description") VALUES
  ('period.read.own', 'Read own actionable/current PayrollPeriod(s) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code = 'period.read.own';
