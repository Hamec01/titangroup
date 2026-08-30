#!/usr/bin/env bash
# Titanor Time — daily GPS encrypted archive (roadmap R08, TZ §9).
#
# Docker cannot bind-mount the s3fs off-box path, so this runs like backup-titanor-time.sh:
#
#   1. WRITE   — a throwaway container runs `.runtime/gps-archive.cjs write`, encrypting every
#                sealable UTC reading-day of raw GPS into a LOCAL staging dir and recording
#                GpsArchiveDay = WRITTEN. The container never sees /mnt/250gb.
#   2. SYNC    — this script copies each WRITTEN day's <day>.jsonl.gz.enc + .manifest.json from
#                staging to the off-box archive root, then re-reads the off-box copy and checks
#                its SHA-256 against the value the runner recorded. Confirmed days go into
#                staging/gps-archive/_offbox-verified.json.
#   3. PROMOTE — a throwaway container runs `.runtime/gps-archive.cjs promote`, which re-checks
#                each confirmed day (off-box sha, staging sha, decrypt, plaintext sha, counts)
#                and records GpsArchiveDay = VERIFIED. Only a VERIFIED day lets the scheduler's
#                retention step delete that day's raw GPS.
#
# Fail-closed: nothing runs, and the DB is never touched, unless GPS_ARCHIVE_ENCRYPTION_KEY is set
# in the env file and /mnt/250gb is mounted. NEVER prints coordinates, the key, or DATABASE_URL.
#
# Parameterised for pilot now / production later:
#   TT_GPS_ENV            label for logs                         (default: pilot)
#   TT_GPS_APP_CONTAINER  running app container (for its image)  (default: t97-pilot-app)
#   TT_GPS_IMAGE          override the image                     (default: that container's image)
#   TT_GPS_NET            docker network                         (default: t97-pilot-net)
#   TT_GPS_ENVFILE        app env file with GPS_ARCHIVE_ENCRYPTION_KEY (default: /home/deploy/app-data/t97-pilot/app.env)
#   TT_GPS_STAGING        local staging dir                      (default: /home/deploy/app-data/t97-pilot/gps-archive-staging)
#   TT_GPS_ARCHIVE_ROOT   off-box archive root                   (default: /mnt/250gb/titanor-time-foundation/gps-archive-store)
#   TT_GPS_KEEP_STAGING_DAYS  prune a staged .enc this many days after it also exists off-box (default: 21)
#
# Exit: 0 all sealable days VERIFIED · 1 a day failed to write/verify · 2 bad config · 3 lock held.

set -Eeuo pipefail

TT_GPS_ENV="${TT_GPS_ENV:-pilot}"
TT_GPS_APP_CONTAINER="${TT_GPS_APP_CONTAINER:-t97-pilot-app}"
TT_GPS_NET="${TT_GPS_NET:-t97-pilot-net}"
TT_GPS_ENVFILE="${TT_GPS_ENVFILE:-/home/deploy/app-data/t97-pilot/app.env}"
TT_GPS_STAGING="${TT_GPS_STAGING:-/home/deploy/app-data/t97-pilot/gps-archive-staging}"
TT_GPS_ARCHIVE_ROOT="${TT_GPS_ARCHIVE_ROOT:-/mnt/250gb/titanor-time-foundation/gps-archive-store}"
TT_GPS_KEEP_STAGING_DAYS="${TT_GPS_KEEP_STAGING_DAYS:-21}"

UTC="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_PREFIX="[gps-archive ${TT_GPS_ENV} ${UTC}]"
LOCKFILE="/tmp/titanor-time-gps-archive-${TT_GPS_ENV}.lock"
PENDING="$TT_GPS_STAGING/gps-archive/_pending-offbox.json"
OFFBOX_VERIFIED="$TT_GPS_STAGING/gps-archive/_offbox-verified.json"

log()  { echo "${LOG_PREFIX} $*"; }
warn() { echo "${LOG_PREFIX} WARNING: $*" >&2; }
die()  { echo "${LOG_PREFIX} ABORT: $*" >&2; exit "${2:-2}"; }

trap 'echo "${LOG_PREFIX} ERROR at line $LINENO" >&2' ERR

# --------------------------------------------------------------------------- lock + preflight
mkdir -p "$TT_GPS_STAGING/gps-archive"
exec 9>"$LOCKFILE"
flock -n 9 || die "another gps-archive run for ${TT_GPS_ENV} is active" 3

command -v jq >/dev/null 2>&1 || die "jq is required"
[ -r "$TT_GPS_ENVFILE" ] || die "env file $TT_GPS_ENVFILE not readable"
grep -qE '^GPS_ARCHIVE_ENCRYPTION_KEY=.+' "$TT_GPS_ENVFILE" \
  || die "GPS_ARCHIVE_ENCRYPTION_KEY missing from $TT_GPS_ENVFILE — archive + retention are fail-closed"
grep -q ' /mnt/250gb ' /proc/mounts || die "/mnt/250gb is not mounted — the archive would have no off-box home"
docker network inspect "$TT_GPS_NET" >/dev/null 2>&1 || die "docker network $TT_GPS_NET missing"

IMAGE="${TT_GPS_IMAGE:-$(docker inspect "$TT_GPS_APP_CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)}"
[ -n "$IMAGE" ] && docker image inspect "$IMAGE" >/dev/null 2>&1 || die "app image '$IMAGE' not found (set TT_GPS_IMAGE or run $TT_GPS_APP_CONTAINER)"
mkdir -p "$TT_GPS_ARCHIVE_ROOT"

run_bundle() {  # $1 = write|promote
  docker run --rm --network "$TT_GPS_NET" --env-file "$TT_GPS_ENVFILE" \
    -e GPS_ARCHIVE_STAGING_DIR=/staging \
    -v "$TT_GPS_STAGING":/staging \
    -w /app --entrypoint node "$IMAGE" .runtime/gps-archive.cjs "$1"
}

# --------------------------------------------------------------------------- 1. write
log "image $IMAGE"
log "-- write --"
WRITE_RC=0
run_bundle write || WRITE_RC=$?
[ "$WRITE_RC" -le 1 ] || die "write phase exited $WRITE_RC" 1
[ -f "$PENDING" ] || die "write phase produced no $PENDING" 1

# --------------------------------------------------------------------------- 2. sync + off-box verify
log "-- sync to $TT_GPS_ARCHIVE_ROOT --"
CONFIRMED='[]'
COUNT=$(jq '.days | length' "$PENDING")
for i in $(seq 0 $((COUNT - 1))); do
  REL=$(jq -r ".days[$i].relativePath" "$PENDING")
  SHA=$(jq -r ".days[$i].ciphertextSha256" "$PENDING")
  DAY=$(jq -r ".days[$i].archiveDate" "$PENDING")
  REV=$(jq -r ".days[$i].revision" "$PENDING")
  SRC="$TT_GPS_STAGING/$REL"
  DST="$TT_GPS_ARCHIVE_ROOT/$REL"
  if [ ! -f "$SRC" ]; then warn "staged file missing: $REL"; continue; fi
  mkdir -p "$(dirname "$DST")"
  cp -f "$SRC" "$DST"
  [ -f "$SRC.manifest.json" ] && cp -f "$SRC.manifest.json" "$DST.manifest.json"
  ACTUAL=$(sha256sum "$DST" | awk '{print $1}')
  if [ "$ACTUAL" != "$SHA" ]; then
    warn "off-box SHA-256 mismatch for $REL — not confirming"
    continue
  fi
  CONFIRMED=$(jq -c --arg d "$DAY" --argjson r "$REV" --arg s "$SHA" '. + [{archiveDate:$d, revision:$r, ciphertextSha256:$s}]' <<<"$CONFIRMED")
  log "off-box OK: $REL"
done
jq -n --argjson days "$CONFIRMED" '{generatedAt: (now | todate), days: $days}' > "$OFFBOX_VERIFIED"
log "confirmed off-box: $(jq '.days | length' "$OFFBOX_VERIFIED") / $COUNT"

# --------------------------------------------------------------------------- 3. promote
log "-- promote --"
PROMOTE_RC=0
run_bundle promote || PROMOTE_RC=$?

# --------------------------------------------------------------------------- 4. prune staged files that are also off-box and old
log "-- prune staging (> ${TT_GPS_KEEP_STAGING_DAYS}d, off-box present) --"
PRUNED=0
while IFS= read -r -d '' f; do
  rel="${f#"$TT_GPS_STAGING"/}"
  if [ -f "$TT_GPS_ARCHIVE_ROOT/$rel" ]; then
    rm -f "$f" "$f.manifest.json"
    PRUNED=$((PRUNED + 1))
  fi
done < <(find "$TT_GPS_STAGING/gps-archive" -type f -name '*.jsonl.gz.enc' -mtime "+${TT_GPS_KEEP_STAGING_DAYS}" -print0 2>/dev/null || true)
log "pruned $PRUNED staged file(s)"

# --------------------------------------------------------------------------- done
if [ "$WRITE_RC" -ne 0 ] || [ "$PROMOTE_RC" -ne 0 ]; then
  warn "finished with issues (write rc=$WRITE_RC, promote rc=$PROMOTE_RC) — see the event lines above; raw GPS for any non-VERIFIED day is retained"
  exit 1
fi
log "OK — all sealable days written + verified off-box"
