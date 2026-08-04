-- Titanor Time — migration: seed assignment.end permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804054937_seed_assignment_split_permission. POST
-- /api/admin/assignments/:assignmentId/end
-- (docs/titanor-time/04_ADMIN_FIRST_API_CONTRACTS.md §6) requires
-- assignment.end per 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and
-- SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('assignment.end', 'End an assignment early by shrinking its validTo — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'assignment.end';
