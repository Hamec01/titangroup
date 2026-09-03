-- R15-D7 — SMOKE-C write-smoke cleanup (owner-authorized 2026-09-03).
-- ONE transaction. 4 immutability triggers disabled ONLY inside the tx and re-enabled before COMMIT.
-- Worker #1017 kept as an archived shell (Employee + User + inactive Employment + 2 CLOCK_* audit
-- events) — all his work data removed. AuditEvent trigger NOT touched, no AuditEvent deleted.
-- Any control-count mismatch -> RAISE EXCEPTION -> ROLLBACK (nothing committed).

\set ON_ERROR_STOP on
\timing on

BEGIN;

-- ── anchors (verified id sets) ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE _emp(id uuid) ON COMMIT DROP;
INSERT INTO _emp VALUES
 ('1f843950-7189-4af9-ab05-eaa923401203'),  -- #1011
 ('f1f1fc3d-fc81-44f4-9fb0-186030f36860'),  -- #1012
 ('ad7e633a-ba89-47c9-bc67-c9854e8cc847'),  -- #1013
 ('2c2afd0c-83ae-4a3a-9baf-60e1365d0e71'),  -- #1014
 ('08229202-211e-439b-8aee-2c0292786c5a'),  -- #1015
 ('7bad0695-4523-4f0b-9c81-9e8a90d05baf'),  -- #1016
 ('15f1672a-5bbc-406c-9469-bb2f6afc943d'),  -- #1017  (KEEP Employee/User/Employment)
 ('5862ab55-bd3f-4a6b-8059-1f8a3124edfc');  -- #1018

CREATE TEMP TABLE _site(id uuid) ON COMMIT DROP;
INSERT INTO _site VALUES
 ('8f907d70-6e84-42a4-94f4-8a14a93b6911'),
 ('0e9b83d0-1b58-431d-ad6c-cb2c7e9f41fa'),
 ('c3048e0c-1578-4c8a-ac3e-59be14d69003'),
 ('6a715b5f-b091-4886-b061-28c2f68ef694');

CREATE TEMP TABLE _per(id uuid) ON COMMIT DROP;
INSERT INTO _per VALUES
 ('7c35ac72-d326-4f01-a1cd-c421cbc91827'),  -- 2019-12-30 (smoke-created, 0 real)
 ('e1cd7133-615c-4ee9-b697-3c5eae24dca7'),  -- 2020-01-06 (smoke-created, 0 real)
 ('12ca318d-5907-43c6-a207-740a6bd5c9bf');  -- 2026-09-14 (smoke-created, 0 real)

-- users behind the smoke employees; #1017's user + employee are KEPT
CREATE TEMP TABLE _usr(id uuid) ON COMMIT DROP;
INSERT INTO _usr SELECT id FROM "User" WHERE "employeeId" IN (SELECT id FROM _emp);

\set keep1017 '15f1672a-5bbc-406c-9469-bb2f6afc943d'
\set user1017 '19719ded-97ec-4b15-ba2e-26e0acd496dd'

-- ── PRECHECK ─────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "Employee" WHERE id IN (SELECT id FROM _emp);
  IF n <> 8 THEN RAISE EXCEPTION 'PRECHECK: expected 8 smoke employees, found %', n; END IF;
  SELECT count(*) INTO n FROM "Employee" WHERE id IN (SELECT id FROM _emp) AND "firstName" <> 'SMOKEC';
  IF n <> 0 THEN RAISE EXCEPTION 'PRECHECK: % anchor employee id(s) are NOT firstName=SMOKEC', n; END IF;
  SELECT count(*) INTO n FROM "WorkSite" WHERE id IN (SELECT id FROM _site);
  IF n <> 4 THEN RAISE EXCEPTION 'PRECHECK: expected 4 smoke sites, found %', n; END IF;
  SELECT count(*) INTO n FROM "WorkSite" WHERE id IN (SELECT id FROM _site) AND name NOT LIKE 'SMOKE-C%';
  IF n <> 0 THEN RAISE EXCEPTION 'PRECHECK: % anchor site id(s) not SMOKE-C name', n; END IF;
  SELECT count(*) INTO n FROM "PayrollPeriod" WHERE id IN (SELECT id FROM _per);
  IF n <> 3 THEN RAISE EXCEPTION 'PRECHECK: expected 3 smoke periods, found %', n; END IF;
  SELECT count(*) INTO n FROM "PayrollPeriodParticipant" pp JOIN "Employee" e ON e.id = pp."employeeId"
    WHERE pp."periodId" IN (SELECT id FROM _per) AND e."firstName" <> 'SMOKEC';
  IF n <> 0 THEN RAISE EXCEPTION 'PRECHECK: % NON-smoke participants in the 3 smoke periods', n; END IF;
  SELECT count(*) INTO n FROM "SiteAssignment" sa JOIN "WorkSite" ws ON ws.id = sa."siteId"
    WHERE sa."employeeId" IN (SELECT id FROM _emp) AND ws.name NOT LIKE 'SMOKE-C%';
  IF n <> 0 THEN RAISE EXCEPTION 'PRECHECK: smoke worker assigned to a REAL site (%)', n; END IF;
  SELECT count(*) INTO n FROM "SiteAssignment" sa JOIN "Employee" e ON e.id = sa."employeeId"
    WHERE sa."siteId" IN (SELECT id FROM _site) AND e."firstName" <> 'SMOKEC';
  IF n <> 0 THEN RAISE EXCEPTION 'PRECHECK: REAL worker assigned to a smoke site (%)', n; END IF;
  SELECT count(*) INTO n FROM "AuditEvent" WHERE "actorUserId" IN (SELECT id FROM _usr);
  IF n <> 2 THEN RAISE EXCEPTION 'PRECHECK: expected 2 AuditEvents by a smoke user (the #1017 CLOCK_*), found %', n; END IF;
  RAISE NOTICE 'PRECHECK OK';
END $$;

-- ── real-data baseline (must be byte-identical after cleanup) ─────────────────────────────────
CREATE TEMP TABLE _baseline(k text PRIMARY KEY, n bigint) ON COMMIT DROP;
INSERT INTO _baseline
 SELECT 'real_employees',            count(*) FROM "Employee"  WHERE "firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_users',      count(*) FROM "User" u WHERE NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e.id = u."employeeId" AND e."firstName" = 'SMOKEC')
 UNION ALL SELECT 'real_worksites',  count(*) FROM "WorkSite" WHERE name NOT LIKE 'SMOKE-C%'
 UNION ALL SELECT 'real_workareas',  count(*) FROM "WorkArea" WHERE "siteId" NOT IN (SELECT id FROM _site)
 UNION ALL SELECT 'real_payrollperiods', count(*) FROM "PayrollPeriod" WHERE id NOT IN (SELECT id FROM _per)
 UNION ALL SELECT 'real_siteassignments', count(*) FROM "SiteAssignment" sa JOIN "Employee" e ON e.id = sa."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_assignmenttransitions', count(*) FROM "AssignmentTransition" x JOIN "Employee" e ON e.id = x."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_timesheets',  count(*) FROM "Timesheet" t JOIN "Employee" e ON e.id = t."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_timesheetversions', count(*) FROM "TimesheetVersion" tv JOIN "Employee" e ON e.id = tv."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_ppparticipants', count(*) FROM "PayrollPeriodParticipant" pp JOIN "Employee" e ON e.id = pp."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_attendanceexc', count(*) FROM "AttendanceException" ae JOIN "Employee" e ON e.id = ae."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_adminnotif',   count(*) FROM "AdminNotification" an WHERE an."employeeId" IS NULL OR NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e.id = an."employeeId" AND e."firstName" = 'SMOKEC')
 UNION ALL SELECT 'real_clockevents',  count(*) FROM "ClockEvent" ce JOIN "Employee" e ON e.id = ce."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_clockshifts',  count(*) FROM "ClockShift" cs JOIN "Employee" e ON e.id = cs."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_autosubmit',   count(*) FROM "AutoSubmissionAttempt" a JOIN "Timesheet" t ON t.id = a."timesheetId" JOIN "Employee" e ON e.id = t."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'real_worksegments', count(*) FROM "WorkSegment" w JOIN "Employee" e ON e.id = w."employeeId" WHERE e."firstName" <> 'SMOKEC'
 UNION ALL SELECT 'total_auditevents', count(*) FROM "AuditEvent"
 UNION ALL SELECT 'migrations_applied', count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;

-- ── DISABLE the 4 immutability / no-delete triggers ─────────────────────────────────────────
ALTER TABLE "AssignmentTransition"  DISABLE TRIGGER "trg_assignment_transition_immutable";
ALTER TABLE "AutoSubmissionAttempt" DISABLE TRIGGER "trg_auto_submission_attempt_immutable";
ALTER TABLE "ClockEvent"            DISABLE TRIGGER "trg_clock_event_immutable";
ALTER TABLE "ClockShift"            DISABLE TRIGGER "trg_clock_shift_no_delete";

-- ── DELETE (children -> parents) ───────────────────────────────────────────────────────────
DELETE FROM "AttendanceException"        WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "AdminNotification"          WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "AutoSubmissionAttempt"      WHERE "timesheetId" IN (SELECT id FROM "Timesheet" WHERE "employeeId" IN (SELECT id FROM _emp));
DELETE FROM "TimesheetReviewScope"       WHERE "timesheetVersionId" IN (SELECT id FROM "TimesheetVersion" WHERE "employeeId" IN (SELECT id FROM _emp));
DELETE FROM "TimesheetPlannedShift"      WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "TimesheetDay"               WHERE "timesheetVersionId" IN (SELECT id FROM "TimesheetVersion" WHERE "employeeId" IN (SELECT id FROM _emp));
UPDATE "Timesheet" SET "currentVersionId" = NULL WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "TimesheetVersion"           WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "TimesheetDraftPlannedShift" WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "TimesheetDraftSegment"      WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "TimesheetDraftDay"          WHERE "draftId" IN (SELECT id FROM "TimesheetDraft" WHERE "employeeId" IN (SELECT id FROM _emp));
DELETE FROM "TimesheetDraft"             WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "Timesheet"                  WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "PayrollPeriodParticipant"   WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "EmployeeOpenShift"          WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "ClockShiftFragment"         WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "ClockShift"                 WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "ClockEventIdConflict"       WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "ClockEvent"                 WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "AssignmentTransition"       WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "SiteAssignment"             WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "EmployeeTimesheetSchedule"  WHERE "employeeId" IN (SELECT id FROM _emp);
DELETE FROM "UserSession"                WHERE "userId" IN (SELECT id FROM _usr);
DELETE FROM "UserRole"                   WHERE "userId" IN (SELECT id FROM _usr);
DELETE FROM "Employment"                 WHERE "employeeId" IN (SELECT id FROM _emp) AND "employeeId" <> :'keep1017';
DELETE FROM "User"                       WHERE "employeeId" IN (SELECT id FROM _emp) AND "employeeId" <> :'keep1017';
DELETE FROM "WorkSiteGeofenceVersion"    WHERE "siteId" IN (SELECT id FROM _site);
DELETE FROM "ForemanAssignment"          WHERE "siteId" IN (SELECT id FROM _site);
DELETE FROM "WorkArea"                   WHERE "siteId" IN (SELECT id FROM _site);
DELETE FROM "Employee"                   WHERE id IN (SELECT id FROM _emp) AND id <> :'keep1017';
DELETE FROM "WorkSite"                   WHERE id IN (SELECT id FROM _site);
DELETE FROM "PayrollPeriod"              WHERE id IN (SELECT id FROM _per);

-- ── RE-ENABLE the 4 triggers (before any postcheck / COMMIT) ────────────────────────────────
ALTER TABLE "AssignmentTransition"  ENABLE TRIGGER "trg_assignment_transition_immutable";
ALTER TABLE "AutoSubmissionAttempt" ENABLE TRIGGER "trg_auto_submission_attempt_immutable";
ALTER TABLE "ClockEvent"            ENABLE TRIGGER "trg_clock_event_immutable";
ALTER TABLE "ClockShift"            ENABLE TRIGGER "trg_clock_shift_no_delete";

-- ── POSTCHECK ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n int; bad text;
BEGIN
  -- 1. all 4 triggers are back ENABLED (tgenabled: 'O'=enabled(origin), 'D'=disabled)
  SELECT count(*) INTO n FROM pg_trigger
    WHERE tgname IN ('trg_assignment_transition_immutable','trg_auto_submission_attempt_immutable','trg_clock_event_immutable','trg_clock_shift_no_delete');
  IF n <> 4 THEN RAISE EXCEPTION 'POSTCHECK: expected the 4 named triggers to exist, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_trigger
    WHERE tgname IN ('trg_assignment_transition_immutable','trg_auto_submission_attempt_immutable','trg_clock_event_immutable','trg_clock_shift_no_delete')
      AND tgenabled = 'D';
  IF n <> 0 THEN RAISE EXCEPTION 'POSTCHECK: % of the 4 triggers is STILL DISABLED — aborting', n; END IF;

  -- 2. real data untouched
  SELECT string_agg(k || ' (' || b.n || ' -> ' || cur || ')', ', ') INTO bad FROM (
    SELECT b.k, b.n, x.cur FROM _baseline b JOIN (
      SELECT 'real_employees' k, count(*) cur FROM "Employee" WHERE "firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_users', count(*) FROM "User" u WHERE NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e.id = u."employeeId" AND e."firstName" = 'SMOKEC')
      UNION ALL SELECT 'real_worksites', count(*) FROM "WorkSite" WHERE name NOT LIKE 'SMOKE-C%'
      UNION ALL SELECT 'real_workareas', count(*) FROM "WorkArea" WHERE "siteId" NOT IN (SELECT id FROM _site)
      UNION ALL SELECT 'real_payrollperiods', count(*) FROM "PayrollPeriod" WHERE id NOT IN (SELECT id FROM _per)
      UNION ALL SELECT 'real_siteassignments', count(*) FROM "SiteAssignment" sa JOIN "Employee" e ON e.id = sa."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_assignmenttransitions', count(*) FROM "AssignmentTransition" x JOIN "Employee" e ON e.id = x."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_timesheets', count(*) FROM "Timesheet" t JOIN "Employee" e ON e.id = t."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_timesheetversions', count(*) FROM "TimesheetVersion" tv JOIN "Employee" e ON e.id = tv."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_ppparticipants', count(*) FROM "PayrollPeriodParticipant" pp JOIN "Employee" e ON e.id = pp."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_attendanceexc', count(*) FROM "AttendanceException" ae JOIN "Employee" e ON e.id = ae."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_adminnotif', count(*) FROM "AdminNotification" an WHERE an."employeeId" IS NULL OR NOT EXISTS (SELECT 1 FROM "Employee" e WHERE e.id = an."employeeId" AND e."firstName" = 'SMOKEC')
      UNION ALL SELECT 'real_clockevents', count(*) FROM "ClockEvent" ce JOIN "Employee" e ON e.id = ce."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_clockshifts', count(*) FROM "ClockShift" cs JOIN "Employee" e ON e.id = cs."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_autosubmit', count(*) FROM "AutoSubmissionAttempt" a JOIN "Timesheet" t ON t.id = a."timesheetId" JOIN "Employee" e ON e.id = t."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'real_worksegments', count(*) FROM "WorkSegment" w JOIN "Employee" e ON e.id = w."employeeId" WHERE e."firstName" <> 'SMOKEC'
      UNION ALL SELECT 'total_auditevents', count(*) FROM "AuditEvent"
      UNION ALL SELECT 'migrations_applied', count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    ) x ON x.k = b.k
    WHERE x.cur <> b.n
  ) b;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCHECK: REAL DATA CHANGED -> %', bad; END IF;

  -- 3. #1017 residue is EXACTLY Employee=1, User=1, Employment=1(inactive), AuditEvent=2
  SELECT count(*) INTO n FROM "Employee" WHERE id = '15f1672a-5bbc-406c-9469-bb2f6afc943d';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCHECK: #1017 Employee count = % (want 1)', n; END IF;
  SELECT count(*) INTO n FROM "User" WHERE "employeeId" = '15f1672a-5bbc-406c-9469-bb2f6afc943d';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCHECK: #1017 User count = % (want 1)', n; END IF;
  SELECT count(*) INTO n FROM "Employment" WHERE "employeeId" = '15f1672a-5bbc-406c-9469-bb2f6afc943d' AND active = false;
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCHECK: #1017 inactive Employment count = % (want 1)', n; END IF;
  SELECT count(*) INTO n FROM "Employment" WHERE "employeeId" = '15f1672a-5bbc-406c-9469-bb2f6afc943d';
  IF n <> 1 THEN RAISE EXCEPTION 'POSTCHECK: #1017 total Employment count = % (want 1)', n; END IF;
  SELECT count(*) INTO n FROM "AuditEvent" WHERE "actorUserId" = '19719ded-97ec-4b15-ba2e-26e0acd496dd';
  IF n <> 2 THEN RAISE EXCEPTION 'POSTCHECK: #1017 CLOCK_* AuditEvent count = % (want 2)', n; END IF;

  -- 4. every other SMOKE-scoped row is gone (all 8 emp / 4 site / 3 wa / 3 per)
  SELECT string_agg(t, ', ') INTO bad FROM (
    SELECT 'Employee(other)' t WHERE (SELECT count(*) FROM "Employee" WHERE id IN (SELECT id FROM _emp) AND id <> '15f1672a-5bbc-406c-9469-bb2f6afc943d') <> 0
    UNION ALL SELECT 'User(other)' WHERE (SELECT count(*) FROM "User" WHERE "employeeId" IN (SELECT id FROM _emp) AND "employeeId" <> '15f1672a-5bbc-406c-9469-bb2f6afc943d') <> 0
    UNION ALL SELECT 'Employment(other)' WHERE (SELECT count(*) FROM "Employment" WHERE "employeeId" IN (SELECT id FROM _emp) AND "employeeId" <> '15f1672a-5bbc-406c-9469-bb2f6afc943d') <> 0
    UNION ALL SELECT 'Employee(byname other)' WHERE (SELECT count(*) FROM "Employee" WHERE "firstName" = 'SMOKEC' AND id <> '15f1672a-5bbc-406c-9469-bb2f6afc943d') <> 0
    UNION ALL SELECT 'SiteAssignment' WHERE (SELECT count(*) FROM "SiteAssignment" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'AssignmentTransition' WHERE (SELECT count(*) FROM "AssignmentTransition" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'Timesheet' WHERE (SELECT count(*) FROM "Timesheet" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'TimesheetVersion' WHERE (SELECT count(*) FROM "TimesheetVersion" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'TimesheetDraft' WHERE (SELECT count(*) FROM "TimesheetDraft" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'TimesheetPlannedShift' WHERE (SELECT count(*) FROM "TimesheetPlannedShift" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'TimesheetDraftPlannedShift' WHERE (SELECT count(*) FROM "TimesheetDraftPlannedShift" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'PayrollPeriodParticipant' WHERE (SELECT count(*) FROM "PayrollPeriodParticipant" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'AttendanceException' WHERE (SELECT count(*) FROM "AttendanceException" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'AdminNotification' WHERE (SELECT count(*) FROM "AdminNotification" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'ClockEvent' WHERE (SELECT count(*) FROM "ClockEvent" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'ClockShift' WHERE (SELECT count(*) FROM "ClockShift" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'ClockShiftFragment' WHERE (SELECT count(*) FROM "ClockShiftFragment" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'EmployeeTimesheetSchedule' WHERE (SELECT count(*) FROM "EmployeeTimesheetSchedule" WHERE "employeeId" IN (SELECT id FROM _emp)) <> 0
    UNION ALL SELECT 'UserRole' WHERE (SELECT count(*) FROM "UserRole" WHERE "userId" IN (SELECT id FROM _usr)) <> 0
    UNION ALL SELECT 'WorkArea' WHERE (SELECT count(*) FROM "WorkArea" WHERE "siteId" IN (SELECT id FROM _site)) <> 0
    UNION ALL SELECT 'WorkSite' WHERE (SELECT count(*) FROM "WorkSite" WHERE id IN (SELECT id FROM _site)) <> 0
    UNION ALL SELECT 'WorkSite(byname)' WHERE (SELECT count(*) FROM "WorkSite" WHERE name LIKE 'SMOKE-C%') <> 0
    UNION ALL SELECT 'PayrollPeriod(smoke)' WHERE (SELECT count(*) FROM "PayrollPeriod" WHERE id IN (SELECT id FROM _per)) <> 0
    -- orphan checks for the child tables that have no employeeId column
    UNION ALL SELECT 'TimesheetDay(orphan)' WHERE (SELECT count(*) FROM "TimesheetDay" td LEFT JOIN "TimesheetVersion" tv ON tv.id = td."timesheetVersionId" WHERE tv.id IS NULL) <> 0
    UNION ALL SELECT 'TimesheetReviewScope(orphan)' WHERE (SELECT count(*) FROM "TimesheetReviewScope" s LEFT JOIN "TimesheetVersion" tv ON tv.id = s."timesheetVersionId" WHERE tv.id IS NULL) <> 0
    UNION ALL SELECT 'AutoSubmissionAttempt(orphan-ts)' WHERE (SELECT count(*) FROM "AutoSubmissionAttempt" a LEFT JOIN "Timesheet" t ON t.id = a."timesheetId" WHERE t.id IS NULL) <> 0
    UNION ALL SELECT 'AutoSubmissionAttempt(orphan-ver)' WHERE (SELECT count(*) FROM "AutoSubmissionAttempt" a LEFT JOIN "TimesheetVersion" tv ON tv.id = a."resultingVersionId" WHERE a."resultingVersionId" IS NOT NULL AND tv.id IS NULL) <> 0
    UNION ALL SELECT 'TimesheetDraftDay(orphan)' WHERE (SELECT count(*) FROM "TimesheetDraftDay" d LEFT JOIN "TimesheetDraft" td ON td.id = d."draftId" WHERE td.id IS NULL) <> 0
  ) z;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCHECK: SMOKE rows still present in -> %', bad; END IF;

  RAISE NOTICE 'POSTCHECK OK — triggers re-enabled, real data unchanged, only #1017 shell remains';
END $$;

-- show the final trigger state explicitly in the output
SELECT tgname, CASE tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'D' THEN 'DISABLED' ELSE tgenabled::text END AS state
FROM pg_trigger
WHERE tgname IN ('trg_assignment_transition_immutable','trg_auto_submission_attempt_immutable','trg_clock_event_immutable','trg_clock_shift_no_delete','trg_audit_event_immutable')
ORDER BY tgname;

COMMIT;
