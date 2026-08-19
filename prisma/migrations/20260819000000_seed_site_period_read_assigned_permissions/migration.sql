-- Titanor Time — migration: seed site.read.assigned + period.read.assigned permissions
--
-- Pure data (DML), no schema change — same pattern as
-- 20260805140000_seed_foreman_review_permissions. T8.2A (docs/titanor-time/T8_REPORTS_DESIGN.md
-- Addendum "T8.2A") — GET /api/foreman/reports/sites/:siteId requires these two codes together
-- with the already-existing timesheet.read.assigned (seeded 20260805140000), per
-- 02_ROLE_PERMISSION_MATRIX.md §2.4g. Verified by direct SQL against a disposable database before
-- writing this migration: neither code existed (zero Permission rows, zero RolePermission grants).
--
-- Held by FOREMAN only — ADMIN/SUPER_ADMIN already hold the unrestricted site.read.all
-- (20260803125804) and period.read.all (20260804110500); WORKER gets neither.

INSERT INTO "Permission" ("code", "description") VALUES
  ('site.read.assigned', 'Read work sites the FOREMAN currently has a ForemanAssignment on — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by FOREMAN'),
  ('period.read.assigned', 'Read payroll periods in the context of the FOREMAN''s own currently-assigned sites (never company-wide) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by FOREMAN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'FOREMAN'
  AND p.code IN ('site.read.assigned', 'period.read.assigned');
