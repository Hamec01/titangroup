-- Titanor Time — migration: seed assignment.update permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804045346_seed_assignment_read_all_permission. PATCH
-- /api/admin/assignments/:assignmentId and POST
-- /api/admin/assignments/:assignmentId/promote
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6) both require
-- assignment.update per 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and
-- SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('assignment.update', 'Edit an assignment''s isPrimary/endedReason, or promote it to primary — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'assignment.update';
