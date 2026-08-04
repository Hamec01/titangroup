-- Titanor Time — migration: seed foreman_assignment.end permission
--
-- Pure data (DML), no schema change — same pattern as
-- 20260804092124_seed_foreman_assignment_read_all_permission. POST
-- /api/admin/foreman-assignments/:foremanAssignmentId/end (contract
-- designed by this task, confirmed by the owner) requires
-- foreman_assignment.end per 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN
-- and SUPER_ADMIN. This is the last permission code for
-- PROJECT_ROADMAP.md STAGE 6 (T6.9, and STAGE 6 as a whole).

INSERT INTO "Permission" ("code", "description") VALUES
  ('foreman_assignment.end', 'End a foreman assignment by setting its validTo — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'foreman_assignment.end';
