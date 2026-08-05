-- Titanor Time — migration: seed FOREMAN review-queue permissions
--
-- Pure data (DML), no schema change. PROJECT_ROADMAP.md T7.6-T7.8 (/api/foreman/*), reusing the
-- existing TimesheetReviewScope table and lib/review-scopes.ts's approve/return core logic
-- (already built for the ADMIN fallback path) with a per-request ForemanAssignment ownership
-- check layered on top.
--
-- 02_ROLE_PERMISSION_MATRIX.md §2.8 rows 145/150/152/154 read as follows, applied here:
--   - timesheet.read.assigned (row 145): read-only, own-site timesheets/scopes — gates
--     GET /api/foreman/overview, .../review-scopes, .../timesheets/:id, .../workers.
--   - timesheet.foreman_review (row 150): gates the approve action specifically. Row 150's
--     "Ограничения" column documents both approve *and* return precondition shapes for
--     cross-reference (mirroring how timesheet.scope_review.all's row does the same for the
--     admin path), but row 152 (timesheet.return) separately and explicitly lists FOREMAN as a
--     holder of that code — read literally per this matrix's own "Держатели" column convention,
--     applied consistently everywhere else in this document. So here approve and return are
--     split into two distinct grants for FOREMAN (finer-grained than ADMIN's combined
--     timesheet.scope_review.all), not one dual-purpose permission.
--   - timesheet.return already exists (seeded 20260805091000, ADMIN/SUPER_ADMIN only, for the
--     admin whole-timesheet override path) — only the RolePermission row for FOREMAN is new here,
--     re-used as-is for the foreman scope-level return action.
--   - timesheet.bulk_approve (row 154): new, gates POST /api/foreman/review-scopes/bulk-approve.

INSERT INTO "Permission" ("code", "description") VALUES
  ('timesheet.read.assigned', 'Read timesheets/review scopes on the FOREMAN''s own currently-assigned sites (SITE-scope only, never NON_SITE) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by FOREMAN'),
  ('timesheet.foreman_review', 'Approve a TimesheetReviewScope(scopeType=SITE) on the FOREMAN''s own site — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by FOREMAN'),
  ('timesheet.bulk_approve', 'Approve a selected batch of standard (no exception) TimesheetReviewScope rows on the FOREMAN''s own sites atomically — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by FOREMAN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'FOREMAN'
  AND p.code IN ('timesheet.read.assigned', 'timesheet.foreman_review', 'timesheet.bulk_approve', 'timesheet.return');
