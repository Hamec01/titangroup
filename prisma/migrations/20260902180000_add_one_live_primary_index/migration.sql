-- R15-D7 Deploy D — "≤1 operationally-live primary assignment per employee" invariant (design §3.6).
--
-- DB backstop behind the lib/assignment-lifecycle-service.ts service, which already demotes the
-- prior live primary in the same transaction (promoteToPrimary; createAssignmentInTx when the new
-- row is primary). This partial UNIQUE index is the last-resort physical guarantee.
--
-- PARTIAL — the predicate is exactly "this row is the primary AND still operationally live":
--   * a DEMOTED assignment (isPrimary = false) is out of the predicate;
--   * a REMOVED / ENDED assignment (clockInDisabledAt IS NOT NULL — set by removeFromSite, by an
--     immediate changeWorkplace, or by the Migration 1 backfill for historically-ended rows) is
--     out of the predicate.
-- So it never blocks a PAST assignment, a FUTURE assignment that isn't primary, or the history —
-- it only forbids a second CONCURRENT primary that is still check-in-able.
--
-- Small table (≈14 rows in production); a plain CREATE INDEX takes a brief lock and completes in
-- microseconds — CONCURRENTLY (which cannot run inside the migration transaction) is unnecessary.
--
-- PRECONDITION: the manual double-primary data fix (Nazar Druz #1002 → keep c6825d98, demote
-- 3d95975f; Mykhailo Sadovnikov #1004 → keep bc174aef, demote cbf688b7 — owner decision
-- 2026-09-02, ops/titanor-time/r15-d7/fix-double-primary.sql) MUST have been applied first, or this
-- index build fails with 23505.

CREATE UNIQUE INDEX "ux_site_assignment_one_live_primary"
  ON "SiteAssignment" ("employeeId")
  WHERE "isPrimary" = true AND "clockInDisabledAt" IS NULL;
