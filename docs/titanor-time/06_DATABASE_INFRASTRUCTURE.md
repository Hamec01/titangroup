# Titanor Time — Database Infrastructure (PostgreSQL 16)

```text
Status: prepared, NOT started
Scope: isolated PostgreSQL 16 for Titanor Time only
Compose project: titanor-time (compose.titanor-time.yaml)
```

This document describes the isolated PostgreSQL 16 configuration for Titanor Time
(`compose.titanor-time.yaml`) and how to operate it once the owner decides to actually start it. As of
this writing the service has **not** been started, no volume or network has been created, and the
existing initial migration has **not** been applied to it. See `IMPLEMENTATION_STATUS.md` for the
proven implementation state.

## 1. Isolation summary

- Separate Compose project (`name: titanor-time`) — distinct from `titanorgroup` (public site,
  `compose.yaml`) and from CollabStudio (its own, unrelated Compose project).
- Separate network (`titanor-time_internal`, `internal: true` — no outbound routing, container-to-
  container only).
- Separate named volume (`titanor-time_db_data`).
- Separate image pull (`postgres:16`, official image) — not the CollabStudio Postgres container.
- No published port — the database is reachable only from other containers attached to the
  `titanor-time_internal` network, under the internal DNS name `db`.
- Secrets (`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`) come only from a local, gitignored
  `.env.titanor-time` file — never from compose.yaml, never committed.

## 2. Create the local, non-public env file

```bash
cp .env.titanor-time.example .env.titanor-time
```

Edit `.env.titanor-time` and set real values for `POSTGRES_DB`, `POSTGRES_USER`,
`POSTGRES_PASSWORD` (a long random password — e.g. `openssl rand -hex 32`). This file is already
covered by the `.env.*` rule in `.gitignore` (with an explicit exception only for the two `.example`
files) — verify with `git check-ignore -v .env.titanor-time` before ever running `git add`.

Never put real values in `.env.titanor-time.example`.

## 3. Start only the Titanor Time database

The public site (`compose.yaml`) and CollabStudio are unaffected — this is a separate Compose project
and a separate command:

```bash
docker compose -f compose.titanor-time.yaml up -d db
```

This creates exactly one container, one network, one volume, all scoped to project `titanor-time`.

## 4. Check health

```bash
docker compose -f compose.titanor-time.yaml ps
docker inspect --format '{{.State.Health.Status}}' titanor-time-db-1
```

Or directly:

```bash
docker compose -f compose.titanor-time.yaml exec db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

## 5. Apply the existing migration

There is exactly one migration:
`prisma/migrations/20260728012114_init_titanor_time_foundation/migration.sql`. Do not create a second
one; do not use `prisma migrate dev`.

The database has no published port, so `prisma migrate deploy` must run from a container attached to
the same internal network — either the future Titanor Time app service (once it exists, simply
`docker compose -f compose.titanor-time.yaml exec app npx prisma migrate deploy`), or, until that
service exists, a throwaway container attached to the same network:

```bash
docker run --rm \
  --network titanor-time_internal \
  -v "$(pwd)":/app -w /app \
  -e DATABASE_URL="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/$POSTGRES_DB?schema=public" \
  node:20 \
  sh -c "npm ci && npx prisma migrate deploy --schema prisma/schema.prisma"
```

`db` above is the internal Compose DNS name (service key), resolvable only on the
`titanor-time_internal` network — not a public host. Never construct this `DATABASE_URL` outside a
container on that network, and never commit it.

## 6. Backup

```bash
mkdir -p backups
docker compose -f compose.titanor-time.yaml exec -T db \
  pg_dump -U "$POSTGRES_USER" -F c -d "$POSTGRES_DB" \
  > "backups/titanor-time-$(date +%Y%m%d-%H%M%S).dump"
```

`-F c` (custom format) is required by `pg_restore` in step 7. Keep backups outside the git repository
(the `backups/` directory should not be committed — add a project-specific ignore rule separately if
this path is adopted).

## 7. Verify restore into a separate test database

Never restore on top of the real `db` service to "test" a backup. Verify against a disposable,
throwaway PostgreSQL 16 container first — the same pattern used for the runtime migration
verification: `--rm`, tmpfs data, random credentials, `127.0.0.1`-only dynamic port, removed
immediately after.

```bash
docker run --detach --rm \
  --name titanor-time-restore-check \
  --restart=no \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
  -e POSTGRES_USER=restorecheck \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  -e POSTGRES_DB=restorecheck \
  -p 127.0.0.1::5432 \
  postgres:16

# wait for pg_isready, then:
docker exec -i titanor-time-restore-check \
  pg_restore -U restorecheck -d restorecheck --clean --if-exists < backups/<file>.dump

# inspect row counts / schema as needed, then:
docker rm -f titanor-time-restore-check
```

Only after a successful restore-check against a throwaway database should a backup be trusted for a
real recovery.

## 8. Stop the service without deleting data

```bash
docker compose -f compose.titanor-time.yaml stop db
```

This stops the container; the `titanor-time_db_data` volume and `titanor-time_internal` network are
untouched. To also remove the (stopped) container and network while **keeping the volume**:

```bash
docker compose -f compose.titanor-time.yaml down
```

**Never** run `docker compose -f compose.titanor-time.yaml down -v` or `docker volume rm
titanor-time_db_data` unless the owner has explicitly approved permanent data deletion — `-v` destroys
the named volume.

## 9. Rollback a deployment without losing data

Prisma migrations in this project are forward-only (no generated "down" SQL). "Rollback" here means
restoring service state without destroying the persistent volume:

1. Take a fresh backup first (step 6), even if things look broken.
2. `docker compose -f compose.titanor-time.yaml down` (no `-v`) to stop and remove the container/
   network — the volume survives.
3. `docker compose -f compose.titanor-time.yaml up -d db` to recreate the container attached to the
   same existing volume — data from before the incident is intact, since the volume was never removed.
4. Only if the volume's data itself is confirmed corrupted (not just the container), restore from the
   most recent verified backup (steps 6-7) into a **new** volume, verify, then switch over — never
   overwrite the only copy of the volume in place without a verified backup first.

## 10. Explicitly out of scope here

- Starting the service (`docker compose -f compose.titanor-time.yaml up`) — not run in this task.
- Applying the migration — not run in this task.
- The future Titanor Time application service (Next.js scaffold) — separate task.
- Seed data, first `SUPER_ADMIN`, auth, API, UI — see `IMPLEMENTATION_STATUS.md` §9 ("Не начато").
- Any change to `compose.yaml` (public site), CollabStudio, Caddy, DNS, or Zoho.

## 11. Attendance auto-submit scheduler service (T7A.10B, 2026-08-18)

`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` Addendum "T7A.10B" is the authoritative design
text (lifecycle/interval/no-overlap/multi-replica/graceful-shutdown/health semantics) — this section
is only the operational start/stop/diagnostics summary.

**What it is.** A separate Compose service, `scheduler`, added alongside `app`/`db`. It reuses the
exact same built image as `app` (`image: titanor-time-app:latest` — `scheduler` has no `build:` of
its own), just runs a different command
(`npx tsx scripts/attendance-auto-submit-scheduler.ts`) instead of the Next.js server. It calls one
tick immediately on start, then repeats on `ATTENDANCE_SCHEDULER_INTERVAL_SECONDS` (default 60,
valid range 30–3600) — never overlapping ticks, never a distributed lock of its own (T7A.10A's own
DB-level locking/idempotency is the source of truth for correctness under restarts or multiple
replicas).

**Start** (after `db` is already running and migrated, per §3/§5 above):

```bash
docker compose -f compose.titanor-time.yaml build app   # produces the shared image scheduler reuses
docker compose -f compose.titanor-time.yaml up -d scheduler
```

**Stop** (graceful — SIGTERM lets the current tick finish, then the process exits cleanly):

```bash
docker compose -f compose.titanor-time.yaml stop scheduler
```

**Diagnostics:**

```bash
docker compose -f compose.titanor-time.yaml logs -f scheduler   # one safe JSON line per tick — no
                                                                  # employee/timesheet/user UUIDs,
                                                                  # names, GPS, payload, DATABASE_URL,
                                                                  # cookies/tokens, or raw Error text
docker inspect --format '{{.State.Health.Status}}' titanor-time-scheduler-1
```

Health is a file-based heartbeat (`scripts/attendance-scheduler-healthcheck.ts`, no HTTP server, no
published port) updated only after a tick genuinely completes — a hung loop or a database that stays
unreachable longer than `max(intervalSeconds×3, 120)` seconds makes the container unhealthy; a single
tick's own per-candidate `failed` count does not (that is an expected, retryable degradation, not a
runner failure).

**Restart safety.** Restarting (or crash-recovering) the `scheduler` container never creates a
duplicate `TimesheetVersion`/`AutoSubmissionAttempt` — the immediate first tick on the new process
just re-scans the same due candidates, and T7A.10A's own idempotency (`UNIQUE(timesheetId,
systemReopenGeneration)`, `ON CONFLICT DO NOTHING`) makes an already-processed candidate a clean
no-op. The same holds for running two replicas of this service simultaneously
(`docker compose -f compose.titanor-time.yaml up -d --scale scheduler=2`, if ever needed) — verified
directly (T7A.10B test suite, item 13) with two real separate scheduler processes against the same
disposable database, resulting in exactly one version/attempt for the shared due candidate.

**Environment.** Only `ATTENDANCE_SCHEDULER_INTERVAL_SECONDS` is scheduler-specific (optional, not a
secret — see `.env.titanor-time.example`); everything else (`DATABASE_URL`, etc.) comes from the same
`env_file: .env.titanor-time` as `app`/`db`. An invalid value (non-integer, or outside 30–3600) makes
the process exit non-zero immediately, before any database access — Compose's `restart: unless-stopped`
will keep restarting it into the same immediate failure until the env var is corrected, which is the
intended fail-fast behavior, not a bug to work around.

## 12. Raw GPS retention (`ClockEventLocation`, T7A.10C.1, 2026-08-18)

`docs/titanor-time/T7A_1_ATTENDANCE_CLOCK_DESIGN.md` Addendum "T7A.10C.1" §A/§B is the authoritative
design text; this section is only the operational summary.

**What exists in the schema (unchanged since `20260812000000_add_attendance_clock_schema_foundation`,
this slice added no migration).** A guard trigger,
`fn_clock_event_location_retention_delete_guard`/`trg_...`, has always blocked any `DELETE` of a
`ClockEventLocation` row younger than 90 days (`OLD."createdAt" >= now() - interval '90 days'` →
`RAISE EXCEPTION`), and a separate trigger unconditionally blocks all `UPDATE`s on that table. Neither
changed. What was missing until this slice was anything that actually issued the delete for rows past
that boundary — the trigger only ever *permitted* it.

**What runs now.** The scheduler process (§11 above — same Compose service, same image, same
`while(!shuttingDown)` loop) runs one extra step per loop iteration, immediately after the auto-submit
tick: `runAttendanceLocationRetention()` (`lib/attendance-location-retention.ts`). First pass runs on
scheduler startup; after a successful pass, the next one waits at least 24h; after a failure, the very
next loop iteration retries (no 24h wait). Result carries `deletedCount` / `presenceDeletedCount` only
— no `clockEventId`/employee/device UUIDs, no coordinates, ever, in the scheduler's structured log
line (`retentionRan`/`retentionOutcome`/`retentionDeleted` — safe fields only; a top-level failure
logs a stable `errorCode`, never the raw `Error`).

**R08 (2026-08-30) — the delete is now archive-gated.** `runAttendanceLocationRetention` no longer
issues a blanket `DELETE … WHERE createdAt < now() - interval '90 days'`. It deletes a
`ClockEventLocation` / `ShiftPresenceSample` row only when BOTH the 90-day boundary has passed AND
that row's UTC reading-day (`ClockEvent.effectiveAt` / `ShiftPresenceSample.capturedAt`) is fully
covered by a `VERIFIED` `GpsArchiveDay` — every revision for the day VERIFIED and no raw row for the
day inserted past the latest archive watermark. A day whose archive is only `WRITTEN`, `FAILED`,
missing, or has a pending amendment keeps its raw GPS. If `GPS_ARCHIVE_ENCRYPTION_KEY` is absent or
malformed the pass deletes **nothing** and returns `gateSkippedReason: 'skipped_no_archive_key'`
(archiving is impossible, so no coordinate may be discarded). The daily archive itself is written
off-box by `ops/titanor-time/gps-archive-titanor-time.sh` (systemd `titanor-time-gps-archive@`), not
by the scheduler. See `docs/titanor-time/R08_GPS_ARCHIVE_REPORT_RU.md`. The `ShiftPresenceSample`
delete still applies the same 90-day floor even though only `ClockEventLocation` has the DB trigger.

**No new public API, no manual-run endpoint, no admin button** — by design (this is a maintenance
job, not a user-facing feature; see design doc addendum §B).

**Multi-replica safety.** The `DELETE ... WHERE createdAt < ...` is a plain set-based statement with
no row-level lock contention of its own kind (unlike auto-submit's `FOR UPDATE` candidate locking) —
two scheduler replicas running this concurrently simply partition the same eligible row set at the
Postgres MVCC level; verified directly with two real concurrent calls against the same disposable
database (zero errors, summed deleted counts equal the eligible set).

**Diagnostics** — same `docker compose -f compose.titanor-time.yaml logs -f scheduler` as §11; look
for `"event":"attendance_location_retention"` lines. No separate health signal — retention shares the
scheduler container's existing heartbeat/health semantics from §11 unchanged.

**Privacy note.** This is an internal company application. Whether 90 days is the *correct*
retention window for raw GPS coordinates is a decision for the Titanor business owner / responsible
person, not something this slice determines or changes — there is no external "legal sign-off"
blocker. R08 adds the long-term encrypted archive: the operational DB holds precise coordinates for
90 days, but the AES-256-GCM archive on the off-box store is kept **indefinitely** by owner
decision, so the effective retention of precise coordinates is indefinite and must be stated in the
worker notice and the personal-data-processing policy, **which the responsible Titanor person must
approve** (TZ §9.5 — an open action, tracked in `R08_GPS_ARCHIVE_REPORT_RU.md` §6).

**Full pilot E2E, including this section's own backup/restore procedure (§6-7), is now done** — see
T7A.10C.2 below; production `titanor-time-app-1`/`titanor-time-db-1` still has no `scheduler`
sibling deployed (deploying it is out of this section's/this task's scope, read-only production
rule).

## 13. Backup/restore procedure — live-verified (T7A.10C.2, 2026-08-19)

The §6-7 procedure above was actually exercised end-to-end against a populated disposable pilot
database, not just described. Summary (full narrative in the design doc addendum
"T7A.10C.2" §I and the final commit's report):

1. `pg_dump -F c` against the disposable `titanor-time-t7a10c2` pilot DB (populated with an open
   shift, a SUBMITTED timesheet with a real `TimesheetVersion`, exceptions, and audit events) — 558
   TOC entries. File written outside git, `chmod 600`, never logged/printed with credentials.
2. `pg_restore --list` against the file confirmed structure before attempting a real restore.
3. Restored into a **completely separate** disposable PostgreSQL 16 (own Docker network, no shared
   volume/network/secret with the source or with `titanor-time-t7a10c2`) via plain `pg_restore`
   (`--no-owner`, matching role) — zero errors/warnings.
4. Verified post-restore: 54 tables, 215 functions, 51 triggers, 142 FK constraints, 109
   `RolePermission` rows, and exact row-count parity on `User`/`ClockEvent`/`TimesheetVersion`/
   `EmployeeOpenShift`/`AuditEvent` against the pre-backup source counts.
5. Started a fresh `app` + `scheduler` (same image, same tag, no rebuild) pointed at the restored
   database via `DATABASE_URL` — health check OK, scheduler tick ran cleanly against the restored
   data (`scanned` matched the restored DRAFT timesheet).
6. Completed the previously-open shift with a real `POST /api/worker/attendance/check-out` against
   the restored app — materialized a genuine new `ClockShift`, while the pre-existing SUBMITTED
   `TimesheetVersion` row remained byte-identical (immutable history survives a full
   backup→restore→resume cycle), and no duplicate `ClockEvent` rows were created.
7. Both disposable environments and the backup file itself were deleted after verification —
   nothing from this procedure persists outside this document and the design-doc addendum.

This confirms the §6-7 procedure as written is correct and sufficient for a real pilot-readiness
restore drill, not merely a documented intention.
