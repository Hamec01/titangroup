# Titanor Time — T9.6 Verified Backup and Restore Plan (2026-08-20)

Written before the first retained backup artifact and before the restore target exists. Source is
the completed T9.5 disposable environment on current commit/schema (62 migrations), after all app,
scheduler and DB restart checks and the durable post-recovery ADMIN write.

## 1. Story

```text
filled current database
→ pg_dump custom-format archive
→ validate archive before restore
→ restore into a different PostgreSQL 16 container and volume
→ launch fresh app + scheduler against restored DB
→ existing ADMIN/WORKER sessions, objects, hours, immutable versions and reports work
→ restored DB accepts and persists a new write
```

This task never reads, dumps or restores preview/production data. It uses only containers, networks,
volumes, ports and files with the disposable T9.5/T9.6 prefixes.

## 2. Backup contract

1. Create `pg_dump -F c` from `t95-codex-db` into a unique `/tmp` file with mode `0600`.
2. Record only archive SHA-256, byte size and TOC item count; never print row content or secrets.
3. `pg_restore --list` must parse the archive successfully before a restore target is created.
4. Capture source structural counts: completed migrations, public tables, functions, non-internal
   triggers and foreign keys.
5. Capture a deterministic, order-independent hash of **all** table data, including sessions and
   device installations: `pg_dump --data-only --inserts`, remove PostgreSQL's randomized
   `\\restrict` wrappers, sort complete SQL lines under `LC_ALL=C`, then SHA-256.

## 3. Restore isolation

- New network `t96-codex-net`, volume `t96-codex-db-data`, PostgreSQL container
  `t96-codex-db`, app `t96-codex-app`, scheduler `t96-codex-scheduler`.
- No shared DB network or volume with T9.5, preview or production.
- Restore into an empty PostgreSQL 16 database with `--no-owner --no-privileges`.
- Do not run migrations over the restored database before comparison; restored migration history
  and schema must be sufficient as-is.

## 4. Pre-runtime parity

Before starting restored app/scheduler, source and target must match exactly for:

- 62 completed `_prisma_migrations` rows and migration names/checksums;
- public table/function/trigger/FK counts;
- row count for every public table;
- the deterministic all-data hash;
- T9.5 manifest fixture snapshot and immutable V1/V2 subtree hashes.

Any mismatch stops the flow before application runtime.

## 5. Restored runtime verification

1. Start fresh app and scheduler from the exact same `titanor-time-app:t95-restart-test` image,
   but with `DATABASE_URL` pointing only to `t96-codex-db`.
2. Wait for DB healthy, app `health/ready=200/200`, and a successful scheduler tick.
3. Run the permanent T9 restart verifier against the restored app using the session tokens restored
   from the archive: ADMIN site/timesheet/report, WORKER period/clock, 420 minutes, zero GET audit
   writes, zero console errors.
4. Create a second idempotent ADMIN work-area mutation named `Restore proof <run>` in the restored
   database only; update the temporary manifest snapshot.
5. Restart the restored app and rerun the verifier. The new row and all pre-backup data must remain
   present; immutable V1/V2 remains unchanged.

## 6. PASS and cleanup

- Archive validates and source/target structural + all-row parity is exact.
- Restored app/scheduler start without migration or compatibility errors.
- Browser/API verifier is fully green before and after the restored write/app restart.
- No duplicate `TimesheetVersion`, `AutoSubmissionAttempt` or audit row is introduced by startup.
- Backup file, temporary manifest, both T9.5/T9.6 stacks, networks, volumes and test image are
  removed only after evidence is complete.
- `titanor-time-app:latest`, preview and production identities/health remain unchanged.

## 7. Executed result

Archive evidence: SHA-256 `e78f34ad905eafe3e33a26d0464bbb2bae634a072c8c9290ccc9b3c8af1ae3aa`,
321,618 bytes, mode `0600`, **597 TOC entries** parsed before restore.

Pre-runtime source/target parity was exact:

| Evidence | Source | Restored target |
|---|---:|---:|
| completed migrations | 62 | 62 |
| public tables | 56 | 56 |
| public functions | 219 | 219 |
| non-internal triggers | 37 | 37 |
| foreign keys | 150 | 150 |
| migration-history hash | `579b66e…7362c4` | identical |
| per-table row-count hash | `0a712763…c1562` | identical |
| sorted all-data hash | `766eabca…d6bf42` | identical |

Fresh restored app and scheduler started without running migrations over the restored schema;
scheduler completed an immediate successful tick. The permanent browser/API/data verifier passed
**20/20**, including a real idempotent ADMIN write to the restored DB. After restarting only the
restored app (same container id, new PID/StartedAt), verifier passed **20/20** again and the new row
remained durable. Final key counts: two immutable `TimesheetVersion`, zero
`AutoSubmissionAttempt`, and no startup duplicates. No product defect was found.

After the final evidence capture, both disposable stacks, their named volumes/networks, both
uniquely tagged test images, the backup archive, temporary manifest and dump/log files were removed
by exact name. Preview and production remained `health=200`/`ready=200`; production container ids,
images, `StartedAt` and `RestartCount=0` were unchanged, and the shared
`titanor-time-app:latest` tag still pointed to revision `c63059588b65b728966f9658ef453b97d887f32d`.
