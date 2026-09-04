-- R15 fixroad F03 — DISMISS Andrei #1000's 3 OUTSIDE_GEOFENCE exceptions, reason "Тест"
-- (owner-authorized 2026-09-04): "Закрыть ровно 3 проверенных исключения Andrei #1000 как
-- «Отклонено», причина «Тест». Перед записью повторно сверить ID, после — показать, что остальные
-- исключения не изменились."
--
-- These are the owner's own test check-ins from home, ~10 km from Pipe and Co, 2026-08-29
-- (R15_ATTENDANCE_EXCEPTIONS_REVIEW_RU.md §2 / R15_MEYER_GPS_FLAG_RU.md §5).
--
-- Mirrors resolveAttendanceException(id, 'DISMISS', 'Тест', actor, null, requestId) EXACTLY (same
-- mutation shape, same audit event) — lib/attendance-exception-resolution.ts lines ~472-491. Only
-- status/resolvedByUserId/resolvedAt/resolutionNote change; one ATTENDANCE_EXCEPTION_DISMISSED
-- AuditEvent per row. ONE transaction; precheck the 3 ids, postcheck that ONLY those 3 changed
-- anywhere in AttendanceException — any drift -> RAISE EXCEPTION -> ROLLBACK, nothing written.
--
-- REQUIRED: -v actor=<uuid> — an ACTIVE User with an active SUPER_ADMIN or ADMIN role, WITHOUT SQL
-- quotes. No default; validated BEFORE any write.
--   Suggested: pilot-owner  cba8d0ff-0fd2-45bc-b83c-1d19ceee2bee  (ACTIVE SUPER_ADMIN)
--
-- Run:
--   docker exec -i titanor-time-prod-db psql -U titanor_time_prod -d titanor_time \
--     -v ON_ERROR_STOP=1 -v actor=cba8d0ff-0fd2-45bc-b83c-1d19ceee2bee \
--     < ops/titanor-time/r15-d7/dismiss-andrei-1000-exceptions.sql

\set ON_ERROR_STOP on

\if :{?actor}
\else
  \set actor MISSING
\endif

BEGIN;

-- 0a. actor must be a syntactically valid UUID (also catches the omitted-variable case).
SELECT :'actor'::uuid AS _actor_must_be_a_uuid;

-- 0b. actor must be ACTIVE with an active SUPER_ADMIN or ADMIN role.
SELECT EXISTS (
  SELECT 1 FROM "User" u
    JOIN "UserRole" ur ON ur."userId" = u.id
    JOIN "Role" r ON r.id = ur."roleId"
   WHERE u.id = :'actor'::uuid
     AND u.status = 'ACTIVE'
     AND ur."validTo" IS NULL
     AND r.name IN ('SUPER_ADMIN','ADMIN')
) AS actor_can_resolve
\gset
\if :actor_can_resolve
\else
  DO $$ BEGIN RAISE EXCEPTION 'dismiss-andrei-1000: -v actor is not an ACTIVE SUPER_ADMIN/ADMIN — ABORT'; END $$;
\endif

-- 1. preflight — re-verify (again, inside the tx) that exactly these 3 ids are OPEN, belong to
--    #1000, and are the two expected OUTSIDE_GEOFENCE types.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM "AttendanceException" ae
  JOIN "Employee" e ON e.id = ae."employeeId"
  WHERE ae.id IN ('00144974-2659-4f1f-b733-c2fe83dfb2a0','ab191746-fbf1-42fa-afc2-10763f41576b','f37e5094-1518-4aaf-8d17-ac0fbbac3226')
    AND ae.status = 'OPEN'
    AND e."employeeNumber" = '1000'
    AND ae.type IN ('OUTSIDE_GEOFENCE_CHECKIN','OUTSIDE_GEOFENCE_CHECKOUT');
  IF n <> 3 THEN
    RAISE EXCEPTION 'preflight: expected 3 matching OPEN #1000 OUTSIDE_GEOFENCE exceptions, found % — ABORT', n;
  END IF;
  RAISE NOTICE 'preflight ok — 3 exceptions re-verified: OPEN, #1000, Pipe and Co, 2026-08-29';
END $$;

-- 2. snapshot every OTHER exception row (any status) so the post-guard can prove nothing else moved.
CREATE TEMP TABLE _other_before ON COMMIT DROP AS
SELECT id, status, "resolvedByUserId", "resolvedAt", "resolutionNote"
FROM "AttendanceException"
WHERE id NOT IN ('00144974-2659-4f1f-b733-c2fe83dfb2a0','ab191746-fbf1-42fa-afc2-10763f41576b','f37e5094-1518-4aaf-8d17-ac0fbbac3226');

-- 3. the change (mirrors resolveAttendanceException's DISMISS mutation exactly).
UPDATE "AttendanceException"
   SET status = 'DISMISSED', "resolvedByUserId" = :'actor'::uuid, "resolvedAt" = now(), "resolutionNote" = 'Тест'
 WHERE id IN ('00144974-2659-4f1f-b733-c2fe83dfb2a0','ab191746-fbf1-42fa-afc2-10763f41576b','f37e5094-1518-4aaf-8d17-ac0fbbac3226')
   AND status = 'OPEN';

-- 4. audit — one ATTENDANCE_EXCEPTION_DISMISSED per row, same shape the route/resolution fn writes.
INSERT INTO "AuditEvent" ("actorUserId","eventType","entityType","entityId","requestId","beforeValue","afterValue",reason)
SELECT :'actor'::uuid, 'ATTENDANCE_EXCEPTION_DISMISSED', 'ATTENDANCE_EXCEPTION', id, gen_random_uuid(),
       jsonb_build_object('status','OPEN','type',type),
       jsonb_build_object('status','DISMISSED','resolutionAction','DISMISS'),
       'Тест'
FROM "AttendanceException"
WHERE id IN ('00144974-2659-4f1f-b733-c2fe83dfb2a0','ab191746-fbf1-42fa-afc2-10763f41576b','f37e5094-1518-4aaf-8d17-ac0fbbac3226');

-- 5. post-guard — exactly 3 DISMISSED with note "Тест"; NO other AttendanceException row changed
--    (status / resolvedByUserId / resolvedAt / resolutionNote all compared) -> ROLLBACK on any drift.
DO $$
DECLARE n int; changed int;
BEGIN
  SELECT count(*) INTO n FROM "AttendanceException"
   WHERE id IN ('00144974-2659-4f1f-b733-c2fe83dfb2a0','ab191746-fbf1-42fa-afc2-10763f41576b','f37e5094-1518-4aaf-8d17-ac0fbbac3226')
     AND status = 'DISMISSED' AND "resolutionNote" = 'Тест' AND "resolvedByUserId" IS NOT NULL;
  IF n <> 3 THEN
    RAISE EXCEPTION 'post-guard: expected 3 DISMISSED with note Тест, found % — ABORT', n;
  END IF;

  SELECT count(*) INTO changed
  FROM "AttendanceException" ae
  JOIN _other_before b ON b.id = ae.id
  WHERE ae.status IS DISTINCT FROM b.status
     OR ae."resolvedByUserId" IS DISTINCT FROM b."resolvedByUserId"
     OR ae."resolvedAt" IS DISTINCT FROM b."resolvedAt"
     OR ae."resolutionNote" IS DISTINCT FROM b."resolutionNote";
  IF changed <> 0 THEN
    RAISE EXCEPTION 'post-guard: % other AttendanceException row(s) changed — ABORT', changed;
  END IF;
  RAISE NOTICE 'post-guard ok — exactly 3 dismissed, 0 other exception rows touched';
END $$;

-- 6. show the result before committing.
SELECT ae.id, ae.type, ae.status, ae."resolvedByUserId", ae."resolutionNote", e."employeeNumber"
FROM "AttendanceException" ae JOIN "Employee" e ON e.id = ae."employeeId"
WHERE ae.id IN ('00144974-2659-4f1f-b733-c2fe83dfb2a0','ab191746-fbf1-42fa-afc2-10763f41576b','f37e5094-1518-4aaf-8d17-ac0fbbac3226')
ORDER BY ae.id;

COMMIT;

-- Post-run manual read-only check:
--   SELECT status, count(*) FROM "AttendanceException" GROUP BY status ORDER BY status;
--   -- expect: OPEN 20, RESOLVED 21, DISMISSED 7 (was OPEN 23 / RESOLVED 21 / DISMISSED 4)
