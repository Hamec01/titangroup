-- Titanor Time — seventh migration: seed worker.read.all permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260730221710_seed_city_read_all_permission. GET /api/admin/setup-status
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §10, the /admin/setup
-- checklist's data source, docs/titanor-time/01_SCREEN_MAP.md) requires
-- exactly one permission code — worker.read.all — per
-- 02_ROLE_PERMISSION_MATRIX.md §2.2, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.read.all', 'Read all workers — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.2, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'worker.read.all';
