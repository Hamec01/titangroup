-- R15-D7 Deploy D2 — "≤1 PRIMARY assignment per OVERLAPPING PERIOD" per employee (design §3.6,
-- owner correction 2026-09-02).
--
-- NOT "≤1 primary among all current+future rows". A CURRENT primary A covering
-- [.., transferDate-1] and a SCHEDULED primary B covering [transferDate, ..] MUST coexist —
-- their periods do not overlap. On transferDate B automatically becomes "the primary now"
-- (its date range covers today), with no cron and no manual step; A's range no longer covers
-- today so it stops being the primary. `resolvePrimarySiteId` / the worker app resolve "the
-- primary now" by date range, not by a global flag.
--
-- Mirrors EX-02 (ex_site_assignment_scope_date_overlap): a GiST EXCLUDE over
-- (employeeId =, daterange(validFrom, validTo+1 exclusive) &&), but scoped to rows that are a
-- NON-removed primary — a removed primary (clockInDisabledAt set by removeFromSite / an immediate
-- changeWorkplace / the Migration-1 backfill) is out of the predicate and never blocks a new one.
-- btree_gist is already installed (migration 20260728012114, for EX-01..EX-06).
--
-- PRECONDITION: the manual double-primary fix (Nazar Druz #1002 keep c6825d98 demote 3d95975f;
-- Mykhailo Sadovnikov #1004 keep bc174aef demote cbf688b7 — their primary periods currently
-- OVERLAP) MUST be applied first (ops/titanor-time/r15-d7/fix-double-primary.sql), or this
-- constraint fails to validate with 23P01. On a disposable clone with no overlapping primary
-- pairs it is added straight away.

ALTER TABLE "SiteAssignment"
  ADD CONSTRAINT "ex_site_assignment_one_primary_per_period"
  EXCLUDE USING gist (
    "employeeId" WITH =,
    daterange("validFrom", COALESCE("validTo" + 1, 'infinity'::date), '[)') WITH &&
  )
  WHERE ("isPrimary" = true AND "clockInDisabledAt" IS NULL);
