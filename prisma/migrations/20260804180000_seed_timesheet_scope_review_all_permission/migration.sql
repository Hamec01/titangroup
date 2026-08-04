-- Titanor Time — migration: seed timesheet.scope_review.all permission
--
-- Pure data (DML), no schema change. GET /api/admin/review-scopes[/:reviewScopeId],
-- POST .../approve and POST .../return (04_ADMIN_FIRST_API_CONTRACTS.md §8) require
-- timesheet.scope_review.all per 02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.scope_review.all', 'Admin fallback review (list/approve/return) of any TimesheetReviewScope — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code = 'timesheet.scope_review.all';
