# Titanor Time — T9.5 Restart Persistence Test Plan (2026-08-20)

Written before the verifier and before any disposable service is started. Base commit:
`49367d9 fix(time): complete admin-led attendance flow`.

## 1. Story and boundary

The current production-like application must preserve the complete T9.4 business state across
independent restarts of the application, scheduler and PostgreSQL process:

```text
ADMIN/WORKER data created through the real application
→ durable PostgreSQL rows and sessions
→ restart app
→ restart scheduler
→ restart db without deleting its volume
→ the same users, objects, hours, immutable timesheet versions and reports remain usable
```

This is a verification slice. It does not deploy to preview/production and does not add a new
product feature. T9.6 backup/restore and T9.7 physical-device acceptance remain separate.

## 2. Isolation and stop gates

- Use a uniquely named Docker image, network, volume and three containers; never use
  `titanor-time-app:latest` as a build target.
- Publish only disposable loopback ports.
- Preview and production are read-only (`health`/`ready`/`docker inspect`) before and after.
- Restart only containers whose exact names start with the T9.5 disposable prefix.
- PostgreSQL restart must preserve the named volume. `down -v`/volume removal is allowed only
  during final cleanup, after evidence is captured.
- No credential, cookie, session token, GPS coordinate or DB password is printed. The temporary
  verifier manifest is mode `0600`, outside git, and removed during cleanup.

## 3. Fixture

Run the permanent T9.4 full-flow test against the disposable production image and clean current
schema (62 migrations). It creates and exercises:

- SUPER_ADMIN, ADMIN, WORKER and optional unassigned FOREMAN;
- site, work area, geofence version, work template, site assignment and payroll period;
- real worker Check In/Out, `ClockEvent`, `ClockShift`, materialization and reason-backed
  `ClockShiftAdjustment`;
- immutable V1/V2 timesheet versions, ADMIN return, ADMIN scope approval and final approval;
- reports and sanitized audit events.

After T9.4 is green, the T9.5 verifier discovers that run by its unique `t94-*` fixture names,
creates fresh expiring ADMIN and WORKER sessions only for post-restart probing, and stores a
minimal manifest containing ids and raw session tokens. The tokens never enter committed output.

## 4. Durable snapshot

Immediately before the first restart capture:

1. a custom-format `pg_dump` validity artifact for structural sanity;
2. a deterministic data-only logical dump hash of the disposable database excluding only the two
   liveness records `UserSession` and `WorkerDeviceInstallation` (`resolveAuthenticatedSession`
   intentionally refreshes session `lastSeenAt`; opening the real `/worker` clock creates/refreshes
   the browser installation context, so byte equality of either liveness record would be a false
   persistence contract); before hashing, remove only PostgreSQL 16.14's randomized
   `\\restrict <nonce>`/`\\unrestrict <nonce>` wrapper lines — two consecutive byte-identical dumps
   otherwise produce different hashes even with zero database writes;
3. exact counts and identity fields for fixture users, employees, sites, assignments, periods,
   clock rows, timesheets, versions, review scopes, adjustments and audit events;
4. immutable hashes of every `TimesheetVersion` subtree belonging to the fixture timesheet.

The same business-data logical dump hash must match after app restart and scheduler restart. A
database restart must also preserve it exactly. Health/readiness probes are HTTP reads and do not
touch authenticated session liveness.

## 5. Restart sequence

### A. Application

1. Record app container id/PID/StartedAt.
2. `docker restart` only the disposable app.
3. Prove container id unchanged but PID/StartedAt changed; wait for `ready=200`.
4. Compare the complete data hash and verifier snapshot.
5. Use the saved sessions through real Chromium to render ADMIN and WORKER pages.

### B. Scheduler

1. Record scheduler PID/StartedAt and counts of `AutoSubmissionAttempt`, `TimesheetVersion` and
   `AuditEvent`.
2. Restart only the disposable scheduler; wait for a new safe `attendance_scheduler_started` log
   and a completed tick/heartbeat.
3. Prove PID/StartedAt changed, no duplicate attempt/version/audit row appeared, and the complete
   DB hash is unchanged.

### C. PostgreSQL

1. Record DB container id/PID/StartedAt and volume name.
2. Restart only the disposable DB (never remove/recreate its volume).
3. Do not restart app or scheduler. Wait for PostgreSQL healthy and then for the existing app to
   return `ready=200`, proving Prisma reconnects.
4. Prove container id and volume unchanged, PID/StartedAt changed, full DB hash identical.
5. Repeat real browser/API verification.

## 6. Post-restart verifier

The permanent script has `prepare` and `verify` modes.

- `prepare`: resolves exactly one latest T9.4 fixture, creates temporary sessions, captures the
  allowlisted DB snapshot and writes the `0600` manifest.
- `verify`: reads that manifest, proves every durable row/count/hash is unchanged, verifies session
  continuity, then launches real Chromium. ADMIN must see the fixture site, worker, final-approved
  timesheet and 420-minute reports; WORKER must see the same period/history and a clocked-out state.
- Browser console errors and failed same-origin responses are failures.
- GET probes must add zero `AuditEvent` rows.
- The optional unassigned FOREMAN remains outside the fixture site's review scope.

The final post-DB-restart pass additionally performs one harmless, idempotent ADMIN mutation
(create a new work area on the fixture site), verifies it in the DB and after an app restart, proving
the recovered stack is read-write rather than merely serving stale reads.

## 7. PASS criteria

- T9.4 seed is 84/84 on the disposable environment.
- App, scheduler and DB each have independently proven new process identity after restart.
- Full business-data logical hash (all table data except `UserSession` and
  `WorkerDeviceInstallation` liveness rows) is identical across all three restart boundaries before
  the final explicit
  mutation.
- All fixture identities/counts and immutable version hashes match.
- Browser/API verification succeeds after app restart and again after DB restart.
- Scheduler resumes without duplicate attempts/versions/audit rows.
- The final mutation is durable through one additional app restart.
- Preview/production identity and health are unchanged; disposable resources are removed.

## 8. Executed result

The current production image and all 62 migrations were exercised on a disposable PostgreSQL 16
volume. T9.4 seed: **84/84**; T9.5 verifier: prepare **5/5**, after app restart **18/18**, after
scheduler restart **18/18**, after DB restart plus recovered-stack write **19/19**, after the final
app restart **19/19** — **79/79 T9.5 assertions** in total.

- App: same container id, new PID/StartedAt, `ready=200`, business hash identical.
- Scheduler: same container id, new PID/StartedAt, immediate successful tick, counts remained
  `AutoSubmissionAttempt=0`, `TimesheetVersion=2`, `AuditEvent=30`, business hash identical.
- DB: same container id and `t95-codex-db-data` volume, new PID/StartedAt; app and scheduler process
  identities stayed unchanged and both reconnected; business hash identical.
- Recovered stack accepted a real idempotent ADMIN `POST` creating a work area. Its updated snapshot
  hash stayed identical through one more app restart, and Chromium/API verification remained 19/19.
- Custom-format archive was structurally readable (**597 TOC entries**); full restore belongs to
  T9.6 and was not claimed here.

One harness issue was found, not a product defect: PostgreSQL 16.14 generates a new random
`\\restrict`/`\\unrestrict` nonce for every textual dump. Raw dump SHA-256 therefore changed even
between two consecutive zero-write dumps. Removing exactly those wrapper lines made the business
hash deterministic; the reason and normalization are now part of §4. No product defect was found.
