-- Titanor Time — migration: seed period.lock permission
--
-- Pure data (DML), no schema change. POST /api/admin/periods/:periodId/lock
-- (PROJECT_ROADMAP.md T7.10, "Закрытие периода") requires period.lock per
-- 02_ROLE_PERMISSION_MATRIX.md §2.7, held by ADMIN and SUPER_ADMIN.
-- PayrollPeriod.status/lockedAt/lockedByUserId (and the CHECK constraint
-- enforcing their shape, ck_payroll_period_status_metadata_shape) already
-- exist from the frozen initial migration — only the permission code is
-- new here.

INSERT INTO "Permission" ("code", "description") VALUES
  ('period.lock', 'Lock an OPEN payroll period once every expected=true participant has reached FINAL_APPROVED — no override — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'period.lock';
