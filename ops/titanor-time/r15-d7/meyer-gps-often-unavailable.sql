-- R15 / fixroad F03 — set WorkSite.gpsOftenUnavailable = true for MEYER TURKU SHIPYARD ONLY.
--
-- PREPARED, NOT RUN. Requires explicit owner confirmation before execution (owner, 2026-09-04:
-- "готовь настройку ... но не применяй без отдельного подтверждения").
--
-- Effect (R15 fixroad F03, owner 2026-09-04): the flag is INFORMATIONAL ONLY. When set, the admin
-- panel (on a GPS_NOT_VERIFIED exception) and the worker clock screen show a note "GPS is often
-- unavailable at this site". It does NOT auto-resolve exceptions, does NOT change any records, does
-- NOT touch LOW_ACCURACY / OUTSIDE_GEOFENCE_* / existing open exceptions / hours / geofences.
-- No-coordinate check-ins still join /admin/review. Automatic acceptance is a separate, separately-
-- approved step — docs/titanor-time/R15_MEYER_GPS_AUTOACCEPT_PLAN_RU.md.
--
-- Equivalent first-class path (preferred if a browser admin session is available): an ADMIN ticks
-- the "На объекте часто нет GPS-сигнала" checkbox on /admin/sites/<id> (SiteEditForm) -> PATCH
-- /api/admin/sites/:id {version, gpsOftenUnavailable:true} -> same field write + version+1 +
-- SITE_UPDATED audit. This script is the psql-only equivalent of that one toggle.
--
-- Target row (verified read-only on prod 2026-09-04):
--   id = b38b9b64-cddc-472c-a617-9e89c2742e1e, name 'Meyer Turku Shipyard', active, finishedAt NULL,
--   gpsOftenUnavailable = false (pre), version = 3 (pre) -> 4 (post).
-- The other two prod sites (Pipe and Co, UKI) are NOT touched; the post-guard aborts if more than
-- one site ends up with the flag.
--
-- ONE transaction. Any precondition mismatch -> RAISE EXCEPTION -> ROLLBACK (nothing written).
--
-- REQUIRED: -v actor=<uuid> — an ACTIVE User with an active SUPER_ADMIN or ADMIN role (holds
-- site.update), WITHOUT SQL quotes. No default; validated BEFORE any write.
--   Suggested: oleksandr  ab393eb7-1db2-44fd-98b4-cde3593370f1  (ACTIVE SUPER_ADMIN)
--          or  yurii      77b75c72-4676-4f4e-bd38-4faeb3b413d2  (ACTIVE ADMIN)
--
-- Run (ONLY after owner confirmation):
--   docker exec -i titanor-time-prod-db psql -U titanor_time_prod -d titanor_time \
--     -v ON_ERROR_STOP=1 -v actor=ab393eb7-1db2-44fd-98b4-cde3593370f1 \
--     < ops/titanor-time/r15-d7/meyer-gps-often-unavailable.sql

\set ON_ERROR_STOP on

\if :{?actor}
\else
  \set actor MISSING
\endif

BEGIN;

-- 0a. actor must be a syntactically valid UUID (also catches the omitted-variable case = 'MISSING').
--     psql interpolates :'actor' only in top-level SQL, never inside DO $$ — so the site id below
--     is written as a literal, and :'actor' is used only at top level.
SELECT :'actor'::uuid AS _actor_must_be_a_uuid;

-- 0b. actor must be ACTIVE with an active SUPER_ADMIN or ADMIN role (site.update).
SELECT EXISTS (
  SELECT 1 FROM "User" u
    JOIN "UserRole" ur ON ur."userId" = u.id
    JOIN "Role" r ON r.id = ur."roleId"
   WHERE u.id = :'actor'::uuid
     AND u.status = 'ACTIVE'
     AND ur."validTo" IS NULL
     AND r.name IN ('SUPER_ADMIN','ADMIN')
) AS actor_can_update_site
\gset
\if :actor_can_update_site
\else
  DO $$ BEGIN RAISE EXCEPTION 'R15 F03: -v actor is not an ACTIVE SUPER_ADMIN/ADMIN — ABORT'; END $$;
\endif

-- 1. preflight — abort unless the Meyer row is exactly as verified on 2026-09-04.
DO $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM "WorkSite" WHERE id = 'b38b9b64-cddc-472c-a617-9e89c2742e1e';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'preflight: site b38b9b64-… not found — ABORT';
  END IF;
  IF s.name <> 'Meyer Turku Shipyard' THEN
    RAISE EXCEPTION 'preflight: site is named %, expected "Meyer Turku Shipyard" — ABORT', s.name;
  END IF;
  IF s."gpsOftenUnavailable" IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'preflight: gpsOftenUnavailable is already % — nothing to do / re-check — ABORT', s."gpsOftenUnavailable";
  END IF;
  IF s.version <> 3 THEN
    RAISE EXCEPTION 'preflight: version is %, expected 3 (row changed since 2026-09-04 — re-verify) — ABORT', s.version;
  END IF;
  IF s."finishedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'preflight: site is finished (finishedAt=%) — ABORT', s."finishedAt";
  END IF;
  RAISE NOTICE 'preflight ok — Meyer Turku Shipyard version 3, gpsOftenUnavailable false -> true';
END $$;

-- 2. the change (mirrors PATCH /api/admin/sites/:id: optimistic-version WHERE + version+1).
UPDATE "WorkSite"
   SET "gpsOftenUnavailable" = true,
       version = version + 1
 WHERE id = 'b38b9b64-cddc-472c-a617-9e89c2742e1e'
   AND version = 3
   AND "gpsOftenUnavailable" = false;

-- 3. audit — same eventType / entityType / afterValue shape the route writes (post-update state).
INSERT INTO "AuditEvent"
  ("actorUserId","eventType","entityType","entityId","requestId","beforeValue","afterValue","reason")
SELECT :'actor'::uuid, 'SITE_UPDATED', 'WORK_SITE', s.id, gen_random_uuid(), NULL,
       jsonb_build_object(
         'id', s.id, 'name', s.name, 'cityId', s."cityId", 'address', s.address,
         'description', s.description, 'active', s.active,
         'gpsOftenUnavailable', s."gpsOftenUnavailable", 'version', s.version
       ),
       'R15 fixroad F03 — ship-hull site, GPS routinely unavailable; owner-authorized manual set (psql equivalent of the SiteEditForm toggle)'
FROM "WorkSite" s
WHERE s.id = 'b38b9b64-cddc-472c-a617-9e89c2742e1e';

-- 4. post-guard — abort (ROLLBACK) on any drift.
DO $$
DECLARE s record; n int;
BEGIN
  SELECT * INTO s FROM "WorkSite" WHERE id = 'b38b9b64-cddc-472c-a617-9e89c2742e1e';
  IF s."gpsOftenUnavailable" IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'post-guard: flag not set (got %) — ABORT', s."gpsOftenUnavailable";
  END IF;
  IF s.version <> 4 THEN
    RAISE EXCEPTION 'post-guard: version is %, expected 4 — ABORT', s.version;
  END IF;
  SELECT count(*) INTO n FROM "AuditEvent"
   WHERE "entityType" = 'WORK_SITE' AND "entityId" = 'b38b9b64-cddc-472c-a617-9e89c2742e1e'
     AND "eventType" = 'SITE_UPDATED' AND "createdAt" > now() - interval '1 minute';
  IF n <> 1 THEN
    RAISE EXCEPTION 'post-guard: expected exactly 1 fresh SITE_UPDATED audit row, found % — ABORT', n;
  END IF;
  SELECT count(*) INTO n FROM "WorkSite" WHERE "gpsOftenUnavailable" = true;
  IF n <> 1 THEN
    RAISE EXCEPTION 'post-guard: expected exactly 1 site with gpsOftenUnavailable=true, found % — ABORT', n;
  END IF;
  RAISE NOTICE 'post-guard ok — Meyer gpsOftenUnavailable=true version=4, 1 SITE_UPDATED audit, 0 other sites changed';
END $$;

-- 5. show the result before committing.
SELECT name, "gpsOftenUnavailable", version
FROM "WorkSite" ORDER BY name;

COMMIT;

-- Post-run manual check (read-only): expect
--   Meyer Turku Shipyard | t | 4  ;  Pipe and Co | f | 2  ;  UKI | f | 2
