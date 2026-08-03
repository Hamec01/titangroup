-- Titanor Time — thirteenth migration: seed worker.update + worker.deactivate permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260801123904_seed_worker_create_permission. PATCH /api/admin/workers/:employeeId
-- and POST /api/admin/workers/:employeeId/deactivate
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §5) require these two
-- permission codes per 02_ROLE_PERMISSION_MATRIX.md §2.2, both held by
-- ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('worker.update', 'Edit a worker''s firstName/lastName/phone — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.2, held by ADMIN and SUPER_ADMIN'),
  ('worker.deactivate', 'Deactivate a worker (Employment.active=false, User.status transition) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.2, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('worker.update', 'worker.deactivate');
