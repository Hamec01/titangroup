#!/usr/bin/env bash
# Titanor Time — restore verification of a backup produced by backup-titanor-time.sh.
# Roadmap R01 / R12 (docs/titanor-time/PRODUCTION_RELEASE_ROADMAP_RU.md).
#
#   ops/titanor-time/restore-test-titanor-time.sh <backup-directory>
#
# What it does (nothing touches pilot or production):
#   1. Verifies the backup directory's own SHA256SUMS.
#   2. Spins up a DISPOSABLE postgres:16 container + fresh volume, on its own network.
#   3. Restores db.dump with `pg_restore --no-owner --no-acl` into a fresh database owned by a
#      throwaway role whose name differs from the source role (proves owner-independence).
#   4. Extracts uploads.tar.gz into a disposable dir and checks the file count.
#   5. Compares the RESTORED database to the values RECORDED IN THE BACKUP:
#        - _prisma_migrations: applied count, 0 unfinished/rolled-back, migration-history hash
#        - structure.txt: tables / routines / triggers / FKs
#        - row-counts.txt: exact count(*) for every public table
#        - data.sha256: deterministic all-data fingerprint (when present)
#   6. Prints PASS / FAIL and removes every disposable resource it created (by exact name).
#
# NEVER prints row content, secrets, DATABASE_URL, tokens or GPS coordinates.

set -euo pipefail

BACKUP_DIR="${1:?usage: restore-test-titanor-time.sh <backup-directory>}"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
PG_IMAGE="${TT_PG_IMAGE:-postgres:16}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX="restore-test-${TS}-$$"
NET="tt-${SUFFIX}-net"
VOL="tt-${SUFFIX}-db"
DBC="tt-${SUFFIX}-db"
WORKDIR="$(mktemp -d "/tmp/tt-${SUFFIX}.XXXXXX")"
TARGET_DB="tt_restore"
TARGET_ROLE="tt_restore_owner"          # deliberately NOT the source role
TARGET_PW="$(head -c18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

pass=0 fail=0
ok()   { pass=$((pass+1)); echo "PASS: $*"; }
bad()  { fail=$((fail+1)); echo "FAIL: $*"; }
info() { echo "---- $*"; }

cleanup() {
  docker rm -f "$DBC" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# ----------------------------------------------------------------------------- 0. backup integrity
info "backup: $BACKUP_DIR"
for f in db.dump db.toc.txt manifest.txt row-counts.txt structure.txt SHA256SUMS migration-history.sha256; do
  [ -f "$BACKUP_DIR/$f" ] || { bad "backup is missing $f"; }
done
# Stage to a LOCAL dir. Docker cannot bind-mount a path on a FUSE mount (the s3fs off-box copy),
# and staging also proves an off-box copy transferred intact when the checksum re-verify below runs
# on the local staged copy rather than the original.
STAGED="$WORKDIR/backup"
mkdir -p "$STAGED"
cp -a "$BACKUP_DIR"/. "$STAGED"/
if ( cd "$STAGED" && sha256sum --quiet -c SHA256SUMS ); then
  ok "backup SHA256SUMS verify (staged from ${BACKUP_DIR})"
else
  bad "backup SHA256SUMS verify"
fi
BACKUP_DIR="$STAGED"
[ "$fail" -eq 0 ] || { echo; echo "RESTORE TEST FAIL ($fail) — backup is not intact"; exit 1; }

MANI_MIGR="$(awk -F= '/^migrations_applied=/{print $2}' "$BACKUP_DIR/structure.txt")"
MANI_TABLES="$(awk -F= '/^public_tables=/{print $2}' "$BACKUP_DIR/structure.txt")"
MANI_ROUTINES="$(awk -F= '/^public_routines=/{print $2}' "$BACKUP_DIR/structure.txt")"
MANI_TRIGGERS="$(awk -F= '/^triggers=/{print $2}' "$BACKUP_DIR/structure.txt")"
MANI_FKS="$(awk -F= '/^foreign_keys=/{print $2}' "$BACKUP_DIR/structure.txt")"
MANI_MIGR_HASH="$(cat "$BACKUP_DIR/migration-history.sha256")"
MANI_DATA_HASH=""; [ -f "$BACKUP_DIR/data.sha256" ] && MANI_DATA_HASH="$(cat "$BACKUP_DIR/data.sha256")"

# ----------------------------------------------------------------------------- 1. disposable postgres
info "start disposable ${PG_IMAGE} ($DBC)"
docker network create "$NET" >/dev/null
docker run -d --name "$DBC" --network "$NET" \
  -e POSTGRES_DB="$TARGET_DB" -e POSTGRES_USER="$TARGET_ROLE" -e POSTGRES_PASSWORD="$TARGET_PW" \
  -v "$VOL:/var/lib/postgresql/data" \
  "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$DBC" pg_isready -U "$TARGET_ROLE" -d "$TARGET_DB" -q 2>/dev/null && break; sleep 1; done
docker exec "$DBC" pg_isready -U "$TARGET_ROLE" -d "$TARGET_DB" -q || { bad "disposable postgres did not become ready"; exit 1; }

# ----------------------------------------------------------------------------- 2. restore
info "pg_restore --no-owner --no-acl into ${TARGET_DB} (owner ${TARGET_ROLE}, not the source role)"
if docker run --rm --network "$NET" -v "$BACKUP_DIR:/b:ro" -e PGPASSWORD="$TARGET_PW" "$PG_IMAGE" \
     pg_restore --no-owner --no-acl --exit-on-error -h "$DBC" -U "$TARGET_ROLE" -d "$TARGET_DB" /b/db.dump 2>"$WORKDIR/restore.err"; then
  ok "pg_restore completed with --exit-on-error"
else
  bad "pg_restore failed"; sed 's/^/    /' "$WORKDIR/restore.err" | head -20
fi

q() { docker exec "$DBC" psql -U "$TARGET_ROLE" -d "$TARGET_DB" -tAc "$1"; }

# ----------------------------------------------------------------------------- 3. migrations
R_MIGR="$(q "SELECT count(*) FILTER (WHERE finished_at IS NOT NULL) FROM _prisma_migrations")"
R_BAD="$(q "SELECT count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) FROM _prisma_migrations")"
R_MIGR_HASH="$(q "SELECT migration_name||' '||checksum FROM _prisma_migrations ORDER BY migration_name" | sha256sum | awk '{print $1}')"
[ "$R_MIGR" = "$MANI_MIGR" ] && ok "migrations applied: $R_MIGR (== backup)" || bad "migrations applied: restored $R_MIGR vs backup $MANI_MIGR"
[ "${R_BAD:-1}" -eq 0 ] && ok "no unfinished/rolled-back migrations in the restore" || bad "$R_BAD unfinished/rolled-back migrations after restore"
[ "$R_MIGR_HASH" = "$MANI_MIGR_HASH" ] && ok "migration-history hash matches" || bad "migration-history hash: restored $R_MIGR_HASH vs backup $MANI_MIGR_HASH"

# ----------------------------------------------------------------------------- 4. structure
R_TABLES="$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
R_ROUTINES="$(q "SELECT count(*) FROM information_schema.routines WHERE routine_schema='public'")"
R_TRIGGERS="$(q "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal")"
R_FKS="$(q "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY'")"
[ "$R_TABLES" = "$MANI_TABLES" ]     && ok "public tables: $R_TABLES"        || bad "public tables: restored $R_TABLES vs backup $MANI_TABLES"
[ "$R_ROUTINES" = "$MANI_ROUTINES" ] && ok "public routines: $R_ROUTINES"    || bad "public routines: restored $R_ROUTINES vs backup $MANI_ROUTINES"
[ "$R_TRIGGERS" = "$MANI_TRIGGERS" ] && ok "triggers: $R_TRIGGERS"           || bad "triggers: restored $R_TRIGGERS vs backup $MANI_TRIGGERS"
[ "$R_FKS" = "$MANI_FKS" ]           && ok "foreign keys: $R_FKS"            || bad "foreign keys: restored $R_FKS vs backup $MANI_FKS"

# ----------------------------------------------------------------------------- 5. per-table row counts
COUNT_SQL="$(q "SELECT string_agg(format('SELECT %L t, count(*) c FROM %I.%I', tablename, schemaname, tablename), ' UNION ALL ') FROM pg_tables WHERE schemaname='public'")"
q "SELECT t, c FROM ($COUNT_SQL) x ORDER BY t" | tr '|' '=' > "$WORKDIR/restored-row-counts.txt"
# psql -tAc uses '|' as default field sep; normalise both files to key=value
awk -F'[|=]' '{print $1"="$2}' "$BACKUP_DIR/row-counts.txt" | sort > "$WORKDIR/backup-rc.norm"
awk -F'[|=]' '{print $1"="$2}' "$WORKDIR/restored-row-counts.txt" | sort > "$WORKDIR/restored-rc.norm"
if diff -u "$WORKDIR/backup-rc.norm" "$WORKDIR/restored-rc.norm" > "$WORKDIR/rc.diff"; then
  ok "per-table row counts identical for all $(wc -l < "$WORKDIR/backup-rc.norm") public tables"
else
  bad "per-table row counts differ:"; sed 's/^/    /' "$WORKDIR/rc.diff" | head -30
fi

# ----------------------------------------------------------------------------- 6. all-data fingerprint
if [ -n "$MANI_DATA_HASH" ]; then
  R_DATA_HASH="$(docker exec "$DBC" pg_dump -U "$TARGET_ROLE" -d "$TARGET_DB" --data-only --inserts --no-owner 2>/dev/null \
    | grep -vE '^\\(un)?restrict ' | LC_ALL=C sort | sha256sum | awk '{print $1}')"
  [ "$R_DATA_HASH" = "$MANI_DATA_HASH" ] && ok "all-data fingerprint matches the backup exactly" \
    || bad "all-data fingerprint: restored $R_DATA_HASH vs backup $MANI_DATA_HASH"
else
  info "no data.sha256 in backup — skipping all-data fingerprint check"
fi

# ----------------------------------------------------------------------------- 7. uploads archive
if [ -f "$BACKUP_DIR/uploads.tar.gz" ]; then
  mkdir -p "$WORKDIR/uploads" && tar -C "$WORKDIR/uploads" -xzf "$BACKUP_DIR/uploads.tar.gz"
  X_FILES="$(find "$WORKDIR/uploads" -type f | wc -l | tr -d ' ')"
  M_FILES="$(awk -F= '/^uploads_files /{print $2}' "$BACKUP_DIR/manifest.txt" | tr -d ' ')"
  [ "$X_FILES" = "$M_FILES" ] && ok "uploads archive extracts $X_FILES files (== manifest)" \
    || bad "uploads archive: extracted $X_FILES vs manifest $M_FILES"
elif [ -f "$BACKUP_DIR/uploads.empty" ]; then
  ok "uploads recorded as empty (uploads.empty present)"
else
  bad "backup has neither uploads.tar.gz nor uploads.empty"
fi

# ----------------------------------------------------------------------------- 8. optional app smoke
# TT_SMOKE=1 boots the release image against the RESTORED database (read-only intent — no writes)
# and checks that /api/ready reports the schema as ready. Needs TT_SMOKE_IMAGE and TT_SMOKE_ENVFILE
# (an env file whose DATABASE_URL is overridden here to point at the disposable DB — the file's
# real DATABASE_URL is never used and never printed).
if [ "${TT_SMOKE:-0}" = "1" ]; then
  info "app smoke: boot ${TT_SMOKE_IMAGE:?set TT_SMOKE_IMAGE} against the restored DB"
  APPC="tt-${SUFFIX}-app"
  RESTORED_URL="postgresql://${TARGET_ROLE}:${TARGET_PW}@${DBC}:5432/${TARGET_DB}"
  docker run -d --name "$APPC" --network "$NET" \
    ${TT_SMOKE_ENVFILE:+--env-file "$TT_SMOKE_ENVFILE"} \
    -e DATABASE_URL="$RESTORED_URL" -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 \
    -e NEXT_TELEMETRY_DISABLED=1 \
    "$TT_SMOKE_IMAGE" >/dev/null
  trap 'docker rm -f "$APPC" >/dev/null 2>&1 || true; cleanup' EXIT
  READY=""
  for _ in $(seq 1 40); do
    READY="$(docker exec "$APPC" node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('x'))" 2>/dev/null || echo x)"
    [ "$READY" = "200" ] && break
    sleep 2
  done
  [ "$READY" = "200" ] && ok "restored app /api/ready = 200" || bad "restored app /api/ready = ${READY:-<no response>}"
  docker logs "$APPC" 2>&1 | grep -iE 'error|migration|schema' | head -5 | sed 's/^/    /' || true
  docker rm -f "$APPC" >/dev/null 2>&1 || true
fi

# ----------------------------------------------------------------------------- verdict
echo
echo "RESTORE TEST: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
echo "PASS"
