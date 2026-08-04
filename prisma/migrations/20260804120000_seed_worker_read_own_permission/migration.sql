-- Titanor Time — migration: seed worker.read.own permission
--
-- Pure data (DML), no schema change. GET /api/worker/context
-- (04_ADMIN_FIRST_API_CONTRACTS.md §9) requires worker.read.own per
-- 02_ROLE_PERMISSION_MATRIX.md, held by WORKER only (unlike the
-- period.*/assignment.* admin permissions seeded so far, this one is
-- WORKER-scoped, not ADMIN/SUPER_ADMIN).

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.read.own', 'Read own Employee profile — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by WORKER');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'WORKER'
  AND p.code = 'worker.read.own';
