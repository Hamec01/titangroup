-- R15-D7 Deploy D — resolve the two double-primary assignments (owner decision 2026-09-02).
--
-- Nazar Druz #1002      (employeeId 1f8b5243-cec5-4c06-8ea3-a5e664865ad8):
--     KEEP primary   c6825d98-f7e2-47ae-bdd3-c721bf3ce242  Meyer Turku Shipyard — Aros Marine
--     DEMOTE         3d95975f-b4c4-491a-8e10-38f3e88edcd8  Meyer Turku Shipyard — (no customer)
-- Mykhailo Sadovnikov #1004 (employeeId 8bb03525-8fe6-4b53-92e7-dc94c38f6a99):
--     KEEP primary   bc174aef-2766-4877-ac43-415ef12433d5  Meyer Turku Shipyard — Aros Marine
--     DEMOTE         cbf688b7-fe67-46b2-aad3-967c37103c07  Meyer Turku Shipyard — (no customer)
--
-- ONLY the isPrimary flag is changed on the two demote-targets. Nothing is deleted, ended,
-- re-pointed, or re-dated. No hours move (cbf688b7 keeps its 10 WorkSegment / 5 ClockShift rows
-- bound to it; 3d95975f has no recorded hours). History is untouched. One atomic transaction:
-- 2 UPDATE + 2 AssignmentTransition + 2 AuditEvent, under the per-employee advisory locks the
-- lifecycle service also takes (§3.13), with a preflight guard that aborts if the live state has
-- drifted since the preflight.
--
-- Run FIRST, then Migration 2 (20260902180000_add_one_live_primary_index).
--
-- REQUIRED: -v actor="'<uuid>'" — the UUID of an ACTIVE SUPER_ADMIN User. There is NO default;
-- the transaction validates the id (ACTIVE + active SUPER_ADMIN UserRole) BEFORE any UPDATE.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v actor="'cba8d0ff-0fd2-45bc-b83c-1d19ceee2bee'" \
--        -f ops/titanor-time/r15-d7/fix-double-primary.sql

\set ON_ERROR_STOP on

\if :{?actor}
\else
  \echo '*** ERROR: -v actor="''<active-SUPER_ADMIN-user-uuid>''" is required. No default actor. ***'
  \quit 1
\endif

BEGIN;

-- 0. actor must be an ACTIVE SUPER_ADMIN — checked before anything is touched.
DO $$
DECLARE ok int;
BEGIN
  SELECT count(*) INTO ok
    FROM "User" u
    JOIN "UserRole" ur ON ur."userId" = u.id
    JOIN "Role" r ON r.id = ur."roleId"
   WHERE u.id = :actor::uuid
     AND u.status = 'ACTIVE'
     AND ur."validTo" IS NULL
     AND r.name = 'SUPER_ADMIN';
  IF ok < 1 THEN
    RAISE EXCEPTION 'actor % is not an ACTIVE SUPER_ADMIN — ABORT', :'actor';
  END IF;
END $$;

-- serialise with any concurrent /change /end /promote on these two workers (same key the
-- service uses: 'titanor_time:assignment_lifecycle:<employeeId>'). Lock order = employeeId asc.
SELECT pg_advisory_xact_lock(hashtext('titanor_time:assignment_lifecycle:1f8b5243-cec5-4c06-8ea3-a5e664865ad8')::bigint);
SELECT pg_advisory_xact_lock(hashtext('titanor_time:assignment_lifecycle:8bb03525-8fe6-4b53-92e7-dc94c38f6a99')::bigint);

-- 1. preflight guard — abort unless the four rows are exactly as verified.
DO $$
DECLARE
  demote_primary int;
  keep_primary   int;
BEGIN
  SELECT count(*) INTO demote_primary FROM "SiteAssignment"
   WHERE id IN ('3d95975f-b4c4-491a-8e10-38f3e88edcd8','cbf688b7-fe67-46b2-aad3-967c37103c07')
     AND "isPrimary" = true;
  SELECT count(*) INTO keep_primary FROM "SiteAssignment"
   WHERE id IN ('c6825d98-f7e2-47ae-bdd3-c721bf3ce242','bc174aef-2766-4877-ac43-415ef12433d5')
     AND "isPrimary" = true AND "clockInDisabledAt" IS NULL;
  IF demote_primary <> 2 THEN
    RAISE EXCEPTION 'preflight: expected 2 primary demote-targets, found % — ABORT', demote_primary;
  END IF;
  IF keep_primary <> 2 THEN
    RAISE EXCEPTION 'preflight: expected 2 live primary keep-targets, found % — ABORT', keep_primary;
  END IF;
END $$;

-- 2. Nazar Druz — demote 3d95975f
UPDATE "SiteAssignment"
   SET "isPrimary" = false, "version" = "version" + 1, "updatedAt" = now()
 WHERE id = '3d95975f-b4c4-491a-8e10-38f3e88edcd8'
   AND "employeeId" = '1f8b5243-cec5-4c06-8ea3-a5e664865ad8'
   AND "isPrimary" = true;

-- 3. Mykhailo Sadovnikov — demote cbf688b7
UPDATE "SiteAssignment"
   SET "isPrimary" = false, "version" = "version" + 1, "updatedAt" = now()
 WHERE id = 'cbf688b7-fe67-46b2-aad3-967c37103c07'
   AND "employeeId" = '8bb03525-8fe6-4b53-92e7-dc94c38f6a99'
   AND "isPrimary" = true;

-- 4. post-guard — the index predicate must now be ≤1 per employee for the whole table.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT "employeeId" FROM "SiteAssignment"
     WHERE "isPrimary" = true AND "clockInDisabledAt" IS NULL
     GROUP BY "employeeId" HAVING count(*) > 1
  ) x;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'post-guard: % employee(s) still have >1 live primary — ABORT', bad;
  END IF;
END $$;

-- 5. structured history (append-only; the immutability trigger permits INSERT).
INSERT INTO "AssignmentTransition"
  ("employeeId","kind","fromAssignmentId","toAssignmentId","actedAt","effectiveFrom",
   "openShiftHandling","actorUserId","reasonCode","reasonText")
VALUES
  ('1f8b5243-cec5-4c06-8ea3-a5e664865ad8','CHANGE',
   '3d95975f-b4c4-491a-8e10-38f3e88edcd8','c6825d98-f7e2-47ae-bdd3-c721bf3ce242',
   now(), (now() AT TIME ZONE 'Europe/Helsinki')::date, 'NONE', :actor::uuid, 'OTHER',
   'R15-D7 Deploy D — resolve double primary (owner decision 2026-09-02): keep c6825d98 (Meyer — Aros Marine), demote 3d95975f'),
  ('8bb03525-8fe6-4b53-92e7-dc94c38f6a99','CHANGE',
   'cbf688b7-fe67-46b2-aad3-967c37103c07','bc174aef-2766-4877-ac43-415ef12433d5',
   now(), (now() AT TIME ZONE 'Europe/Helsinki')::date, 'NONE', :actor::uuid, 'OTHER',
   'R15-D7 Deploy D — resolve double primary (owner decision 2026-09-02): keep bc174aef (Meyer — Aros Marine), demote cbf688b7');

-- 6. audit (createAuditEvent equivalent — ASSIGNMENT_PROMOTED, one row per kept primary).
INSERT INTO "AuditEvent"
  ("actorUserId","eventType","entityType","entityId","requestId","beforeValue","afterValue","reason")
VALUES
  (:actor::uuid,'ASSIGNMENT_PROMOTED','SITE_ASSIGNMENT','c6825d98-f7e2-47ae-bdd3-c721bf3ce242',
   gen_random_uuid(), NULL,
   '{"assignmentId":"c6825d98-f7e2-47ae-bdd3-c721bf3ce242","employeeId":"1f8b5243-cec5-4c06-8ea3-a5e664865ad8","demotedAssignmentIds":["3d95975f-b4c4-491a-8e10-38f3e88edcd8"],"context":"R15-D7 Deploy D manual double-primary fix"}'::jsonb,
   'owner decision 2026-09-02'),
  (:actor::uuid,'ASSIGNMENT_PROMOTED','SITE_ASSIGNMENT','bc174aef-2766-4877-ac43-415ef12433d5',
   gen_random_uuid(), NULL,
   '{"assignmentId":"bc174aef-2766-4877-ac43-415ef12433d5","employeeId":"8bb03525-8fe6-4b53-92e7-dc94c38f6a99","demotedAssignmentIds":["cbf688b7-fe67-46b2-aad3-967c37103c07"],"context":"R15-D7 Deploy D manual double-primary fix"}'::jsonb,
   'owner decision 2026-09-02');

-- 7. show the result before committing.
SELECT e."employeeNumber" AS num, e."firstName"||' '||e."lastName" AS worker,
       sa.id, COALESCE(wa.name,'(no customer)') AS customer,
       sa."isPrimary", sa."validFrom", sa."validTo", sa."clockInDisabledAt", sa.version
FROM "SiteAssignment" sa
JOIN "Employee" e ON e.id = sa."employeeId"
LEFT JOIN "WorkArea" wa ON wa.id = sa."workAreaId"
WHERE sa.id IN ('c6825d98-f7e2-47ae-bdd3-c721bf3ce242','3d95975f-b4c4-491a-8e10-38f3e88edcd8',
                'bc174aef-2766-4877-ac43-415ef12433d5','cbf688b7-fe67-46b2-aad3-967c37103c07')
ORDER BY worker, sa."isPrimary" DESC;

COMMIT;
