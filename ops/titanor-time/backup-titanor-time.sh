#!/usr/bin/env bash
# Titanor Time — verified backup: PostgreSQL custom-format dump + uploads archive + manifest.
# Roadmap R01 (docs/titanor-time/PRODUCTION_RELEASE_ROADMAP_RU.md).
#
# One backup = one directory:
#   <BACKUP_ROOT>/<env>-<UTC>-<reason>/
#     db.dump          pg_dump -F c  (faithful archive; restore with pg_restore --no-owner --no-acl)
#     db.toc.txt       pg_restore --list of the dump       (proves the archive parses)
#     uploads.tar.gz   tar of the uploads directory        (absent when uploads is empty -> uploads.empty)
#     structure.txt    migrations / table / routine / trigger / FK counts (no row content)
#     row-counts.txt   exact count(*) per public table     (no row content)
#     manifest.txt     env, UTC, host, git SHA/branch, image, sizes, TOC entries, structure
#     SHA256SUMS       sha256 of every file above
#
# Parameterised via env vars so the SAME script serves pilot now and production later:
#   TT_ENV            label used in filenames + manifest        (default: pilot)
#   TT_DB_CONTAINER   docker container running PostgreSQL        (default: t97-pilot-db)
#   TT_DB_USER        (default: t97_app)
#   TT_DB_NAME        (default: titanor_time_t97)
#   TT_UPLOADS_DIR    host dir of uploaded files                 (default: /home/deploy/app-data/t97-pilot/uploads)
#   TT_APP_CONTAINER  running app container, for the image tag   (default: t97-pilot-app)
#   TT_REPO_DIR       repo checkout, for the git SHA             (default: this script's repo)
#   TT_BACKUP_ROOT    on-box backup directory                    (default: /home/deploy/backups/titanor-time-<env>)
#   TT_MIRROR_ROOT    optional off-box copy (e.g. the s3fs mount); "" disables  (default: "")
#   TT_KEEP_DAILY / TT_KEEP_WEEKLY / TT_KEEP_MONTHLY             (default: 7 / 4 / 12)
#   TT_KEEP_EVENT_DAYS  how long to keep pre-deploy/pre-migration/manual backups (default: 30)
#
# Arg 1 = reason: scheduled | pre-deploy | pre-migration | manual   (default: scheduled)
#
# Exit codes: 0 OK · 1 failure (dump/parse/tar/checksum) · 3 another run holds the lock.
# NEVER prints row content, secrets, DATABASE_URL, tokens or GPS coordinates.

set -euo pipefail

# ----------------------------------------------------------------------------- config
TT_ENV="${TT_ENV:-pilot}"
TT_DB_CONTAINER="${TT_DB_CONTAINER:-t97-pilot-db}"
TT_DB_USER="${TT_DB_USER:-t97_app}"
TT_DB_NAME="${TT_DB_NAME:-titanor_time_t97}"
TT_UPLOADS_DIR="${TT_UPLOADS_DIR:-/home/deploy/app-data/t97-pilot/uploads}"
TT_APP_CONTAINER="${TT_APP_CONTAINER:-t97-pilot-app}"
TT_REPO_DIR="${TT_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TT_BACKUP_ROOT="${TT_BACKUP_ROOT:-/home/deploy/backups/titanor-time-${TT_ENV}}"
TT_MIRROR_ROOT="${TT_MIRROR_ROOT:-}"
TT_KEEP_DAILY="${TT_KEEP_DAILY:-7}"
TT_KEEP_WEEKLY="${TT_KEEP_WEEKLY:-4}"
TT_KEEP_MONTHLY="${TT_KEEP_MONTHLY:-12}"
TT_KEEP_EVENT_DAYS="${TT_KEEP_EVENT_DAYS:-30}"
PG_IMAGE="${TT_PG_IMAGE:-postgres:16}"

REASON="${1:-scheduled}"
case "$REASON" in scheduled|pre-deploy|pre-migration|manual) ;; *) echo "invalid reason: $REASON" >&2; exit 1;; esac

UTC="$(date -u +%Y%m%dT%H%M%SZ)"
LOCKFILE="/tmp/titanor-time-backup-${TT_ENV}.lock"
LOG_PREFIX="[backup ${TT_ENV} ${REASON} ${UTC}]"

log()  { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} WARNING: $*" >&2; }
fail() { echo "${LOG_PREFIX} FAILED: $*" >&2; exit 1; }

# ----------------------------------------------------------------------------- lock
mkdir -p "$TT_BACKUP_ROOT"
exec 9>"$LOCKFILE"
flock -n 9 || { echo "${LOG_PREFIX} another backup for ${TT_ENV} is already running" >&2; exit 3; }

# ----------------------------------------------------------------------------- preflight
docker inspect "$TT_DB_CONTAINER" >/dev/null 2>&1 || fail "db container '${TT_DB_CONTAINER}' not found"
docker exec "$TT_DB_CONTAINER" pg_isready -U "$TT_DB_USER" -d "$TT_DB_NAME" -q || fail "database not ready"

STAGE="$(mktemp -d "${TT_BACKUP_ROOT}/.stage-${UTC}.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
FINAL="${TT_BACKUP_ROOT}/${TT_ENV}-${UTC}-${REASON}"
[ -e "$FINAL" ] && fail "target already exists: $FINAL"

# ----------------------------------------------------------------------------- 1. DB dump
log "pg_dump ${TT_DB_NAME} (custom format)"
docker exec "$TT_DB_CONTAINER" pg_dump -U "$TT_DB_USER" -d "$TT_DB_NAME" -F c > "$STAGE/db.dump" \
  || fail "pg_dump"
[ -s "$STAGE/db.dump" ] || fail "dump is empty"

log "validate: pg_restore --list"
docker run --rm -v "${STAGE}:/stage:ro" "$PG_IMAGE" pg_restore --list /stage/db.dump > "$STAGE/db.toc.txt" \
  || fail "dump does not parse with pg_restore --list"
TOC_ENTRIES="$(grep -cE '^[0-9]+;' "$STAGE/db.toc.txt" || true)"
[ "${TOC_ENTRIES:-0}" -gt 0 ] || fail "dump TOC is empty"

# ----------------------------------------------------------------------------- 2. uploads archive
if [ -d "$TT_UPLOADS_DIR" ] && [ -n "$(ls -A "$TT_UPLOADS_DIR" 2>/dev/null || true)" ]; then
  log "tar uploads from ${TT_UPLOADS_DIR}"
  tar --numeric-owner -C "$TT_UPLOADS_DIR" -czf "$STAGE/uploads.tar.gz" . || fail "tar uploads"
  UPLOADS_FILES="$(find "$TT_UPLOADS_DIR" -type f | wc -l | tr -d ' ')"
  UPLOADS_BYTES="$(du -sb "$TT_UPLOADS_DIR" | cut -f1)"
else
  log "uploads directory is empty or missing — recording uploads.empty"
  : > "$STAGE/uploads.empty"
  UPLOADS_FILES=0
  UPLOADS_BYTES=0
fi

# ----------------------------------------------------------------------------- 3. structure + row counts (no row content)
docker exec "$TT_DB_CONTAINER" psql -U "$TT_DB_USER" -d "$TT_DB_NAME" -tAX -F= -c "
  SELECT 'migrations_applied',    count(*) FILTER (WHERE finished_at IS NOT NULL) FROM _prisma_migrations
  UNION ALL SELECT 'migrations_unfinished', count(*) FILTER (WHERE finished_at IS NULL)    FROM _prisma_migrations
  UNION ALL SELECT 'migrations_rolledback', count(*) FILTER (WHERE rolled_back_at IS NOT NULL) FROM _prisma_migrations
  UNION ALL SELECT 'public_tables',   count(*) FROM information_schema.tables      WHERE table_schema='public' AND table_type='BASE TABLE'
  UNION ALL SELECT 'public_routines', count(*) FROM information_schema.routines    WHERE routine_schema='public'
  UNION ALL SELECT 'triggers',        count(*) FROM pg_trigger WHERE NOT tgisinternal
  UNION ALL SELECT 'foreign_keys',    count(*) FROM information_schema.table_constraints WHERE constraint_schema='public' AND constraint_type='FOREIGN KEY'
" > "$STAGE/structure.txt" || fail "structure query"

COUNT_SQL="$(docker exec "$TT_DB_CONTAINER" psql -U "$TT_DB_USER" -d "$TT_DB_NAME" -tAc \
  "SELECT string_agg(format('SELECT %L t, count(*) c FROM %I.%I', tablename, schemaname, tablename), ' UNION ALL ')
   FROM pg_tables WHERE schemaname='public'")"
[ -n "$COUNT_SQL" ] || fail "could not build row-count query"
docker exec "$TT_DB_CONTAINER" psql -U "$TT_DB_USER" -d "$TT_DB_NAME" -tAX -F= -c \
  "SELECT t, c FROM ($COUNT_SQL) x ORDER BY t" > "$STAGE/row-counts.txt" || fail "row-count query"
ROWS_TOTAL="$(awk -F= '{s+=$2} END{print s+0}' "$STAGE/row-counts.txt")"

MIGRATIONS_APPLIED="$(awk -F= '$1=="migrations_applied"{print $2}' "$STAGE/structure.txt")"
MIGRATIONS_BAD="$(awk -F= '$1=="migrations_unfinished"||$1=="migrations_rolledback"{s+=$2} END{print s+0}' "$STAGE/structure.txt")"
[ "${MIGRATIONS_BAD:-0}" -eq 0 ] || fail "database has ${MIGRATIONS_BAD} unfinished/rolled-back migrations — refusing to record a broken backup"

# Migration-history fingerprint (names + checksums, ordered) — no timestamps, so it is stable
# across a restore. Used by restore-test-titanor-time.sh for exact parity.
docker exec "$TT_DB_CONTAINER" psql -U "$TT_DB_USER" -d "$TT_DB_NAME" -tAc \
  "SELECT migration_name||' '||checksum FROM _prisma_migrations ORDER BY migration_name" \
  | sha256sum | awk '{print $1}' > "$STAGE/migration-history.sha256" || fail "migration-history hash"

# Deterministic, order-independent all-data fingerprint (T9.6 method): dump every row of every
# table as INSERT statements, strip PostgreSQL's randomised \restrict/\unrestrict wrappers, sort
# whole SQL lines under LC_ALL=C, SHA-256. This is the single strongest "the data survived the
# round-trip unchanged" check. It never leaves the pipe — no row content is written to disk or
# printed.
if [ "${TT_DATA_HASH:-1}" = "1" ]; then
  log "compute all-data fingerprint"
  docker exec "$TT_DB_CONTAINER" pg_dump -U "$TT_DB_USER" -d "$TT_DB_NAME" --data-only --inserts --no-owner 2>/dev/null \
    | grep -vE '^\\(un)?restrict ' \
    | LC_ALL=C sort \
    | sha256sum | awk '{print $1}' > "$STAGE/data.sha256" || fail "all-data fingerprint"
fi

# ----------------------------------------------------------------------------- 4. manifest
APP_IMAGE="$(docker inspect --format '{{.Config.Image}} ({{.Image}})' "$TT_APP_CONTAINER" 2>/dev/null || echo 'unknown')"
GIT_SHA="$(git -C "$TT_REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$TT_REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
GIT_DIRTY="$(git -C "$TT_REPO_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

{
  echo "environment         = ${TT_ENV}"
  echo "reason              = ${REASON}"
  echo "utc_timestamp       = ${UTC}"
  echo "host                = $(hostname)"
  echo "db_container         = ${TT_DB_CONTAINER}"
  echo "db_name              = ${TT_DB_NAME}"
  echo "app_image            = ${APP_IMAGE}"
  echo "git_branch           = ${GIT_BRANCH}"
  echo "git_sha              = ${GIT_SHA}"
  echo "git_uncommitted_files = ${GIT_DIRTY}"
  echo "dump_bytes           = $(stat -c%s "$STAGE/db.dump")"
  echo "dump_toc_entries     = ${TOC_ENTRIES}"
  echo "uploads_files        = ${UPLOADS_FILES}"
  echo "uploads_bytes        = ${UPLOADS_BYTES}"
  echo "public_row_total     = ${ROWS_TOTAL}"
  echo "migration_history_sha256 = $(cat "$STAGE/migration-history.sha256")"
  [ -f "$STAGE/data.sha256" ] && echo "all_data_sha256      = $(cat "$STAGE/data.sha256")"
  echo "--- structure ---"
  cat "$STAGE/structure.txt"
} > "$STAGE/manifest.txt"

# ----------------------------------------------------------------------------- 5. checksums
( cd "$STAGE" && sha256sum -- * > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS ) || fail "checksums"

# ----------------------------------------------------------------------------- 6. atomic publish
mv "$STAGE" "$FINAL"
trap - EXIT
chmod 0700 "$FINAL"
chmod 0600 "$FINAL"/*
log "published ${FINAL} (dump $(stat -c%s "$FINAL/db.dump") bytes, ${TOC_ENTRIES} TOC entries, ${ROWS_TOTAL} rows, ${MIGRATIONS_APPLIED} migrations)"

# ----------------------------------------------------------------------------- 7. off-box mirror (non-fatal)
if [ -n "$TT_MIRROR_ROOT" ]; then
  if mkdir -p "${TT_MIRROR_ROOT}" 2>/dev/null && cp -a "$FINAL" "${TT_MIRROR_ROOT}/" 2>/dev/null; then
    # verify the mirrored checksums re-read from the off-box copy
    if ( cd "${TT_MIRROR_ROOT}/$(basename "$FINAL")" && sha256sum --quiet -c SHA256SUMS ) 2>/dev/null; then
      log "off-box mirror OK: ${TT_MIRROR_ROOT}/$(basename "$FINAL")"
    else
      warn "off-box mirror copied but checksum re-verify FAILED — treat the off-box copy as unusable"
    fi
  else
    warn "off-box mirror to ${TT_MIRROR_ROOT} failed (on-box backup is intact)"
  fi
fi

# ----------------------------------------------------------------------------- 8. rotation
# 'scheduled' backups: keep the newest TT_KEEP_DAILY, plus one per ISO week for TT_KEEP_WEEKLY
# weeks, plus one per month for TT_KEEP_MONTHLY months. Event backups (pre-deploy / pre-migration
# / manual): keep for TT_KEEP_EVENT_DAYS days. Nothing outside TT_BACKUP_ROOT is ever touched, and
# an off-box mirror is never pruned by this script.
prune() {
  local root="$1"
  [ -d "$root" ] || return 0

  local -a sched
  mapfile -t sched < <(find "$root" -maxdepth 1 -type d -name "${TT_ENV}-*-scheduled" -printf '%f\n' | sort -r)

  local -A keep=()
  local f day wk mo i=0 wk_used=0 mo_used=0
  declare -A wk_seen=() mo_seen=()
  for f in "${sched[@]}"; do
    day="${f#"${TT_ENV}"-}"; day="${day%%T*}"          # YYYYMMDD
    if [ "$i" -lt "$TT_KEEP_DAILY" ]; then keep["$f"]=1; i=$((i+1)); continue; fi
    wk="$(date -u -d "${day:0:4}-${day:4:2}-${day:6:2}" +%G-%V 2>/dev/null || echo "raw-$day")"
    mo="${day:0:6}"
    if [ -z "${wk_seen[$wk]:-}" ] && [ "$wk_used" -lt "$TT_KEEP_WEEKLY" ]; then
      keep["$f"]=1; wk_seen[$wk]=1; wk_used=$((wk_used+1)); continue
    fi
    if [ -z "${mo_seen[$mo]:-}" ] && [ "$mo_used" -lt "$TT_KEEP_MONTHLY" ]; then
      keep["$f"]=1; mo_seen[$mo]=1; mo_used=$((mo_used+1)); continue
    fi
  done

  for f in "${sched[@]}"; do
    [ -n "${keep[$f]:-}" ] || { log "rotate: remove $f"; rm -rf -- "${root:?}/$f"; }
  done

  # event backups (pre-deploy / pre-migration / manual): keep by age only.
  while IFS= read -r f; do
    log "rotate: remove $(basename "$f")"
    rm -rf -- "$f"
  done < <(find "$root" -maxdepth 1 -type d \
              \( -name "${TT_ENV}-*-pre-deploy" -o -name "${TT_ENV}-*-pre-migration" -o -name "${TT_ENV}-*-manual" \) \
              -mtime "+${TT_KEEP_EVENT_DAYS}")
}
prune "$TT_BACKUP_ROOT"

# ----------------------------------------------------------------------------- done
echo "${LOG_PREFIX} OK"
