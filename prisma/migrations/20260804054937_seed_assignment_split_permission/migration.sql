-- Titanor Time — migration: seed assignment.split permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804053740_seed_assignment_update_permission. POST
-- /api/admin/assignments/:assignmentId/split
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6) requires
-- assignment.split per 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and
-- SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('assignment.split', 'Atomically close an assignment and create its replacement at a given effective date — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'assignment.split';
