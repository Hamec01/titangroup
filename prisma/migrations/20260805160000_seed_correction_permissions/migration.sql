-- Titanor Time — migration: seed correction.* permissions (ADMIN-only first slice)
--
-- Pure data (DML), no schema change. docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md §2.9 lists
-- correction.request as held by WORKER (own)/FOREMAN (own sites)/ADMIN/SUPER_ADMIN (all), but the
-- owner confirmed the first UI slice is ADMIN-only (request+draft.edit+approve all in one place) —
-- WORKER/FOREMAN request forms are a separate, later step, same "seeded only for the role with a
-- real endpoint today" precedent already used for timesheet.return (20260805091000).
-- correction.draft.edit and correction.approve are ADMIN/SUPER_ADMIN-only per the matrix itself,
-- no scope-cut needed for those two.

INSERT INTO "Permission" ("code", "description") VALUES
  ('correction.request', 'Open a CorrectionRequest(PENDING) against a FINAL_APPROVED timesheet — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md; seeded for ADMIN/SUPER_ADMIN only in this first slice (WORKER own / FOREMAN own-sites forms deferred)'),
  ('correction.draft.edit', 'Open/edit a CorrectionDraft (basedOnVersionId fixed at open, same day-state rules as the regular worker draft) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN'),
  ('correction.approve', 'Decide a SUBMITTED CorrectionRequest (approve — freezes TimesheetVersion(source=CORRECTION) — or reject); four-eyes (decidedByUserId != CorrectionDraft.openedByUserId) unless approvalOverride=true (SUPER_ADMIN only, with overrideReason) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md, held by ADMIN and SUPER_ADMIN');

INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name IN ('ADMIN', 'SUPER_ADMIN')
  AND p.code IN ('correction.request', 'correction.draft.edit', 'correction.approve');
