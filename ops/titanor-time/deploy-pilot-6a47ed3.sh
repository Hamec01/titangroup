#!/usr/bin/env bash
# Titanor Time — pilot deploy of R08 (GPS encrypted archive + safe retention). Commit 6a47ed3.
# Same fail-closed / auto-rollback / stale-lease structure as ops/titanor-time/deploy-pilot-8724480.sh
# (R07-A) and deploy-pilot-256565a.sh (R06-B.1). Canonical copy in the repo; identical copy at
# /home/deploy/app-data/t97-pilot/deploy-6a47ed3.sh.
#
# This deploy DOES change the schema: one additive migration
#   20260830160000_add_gps_archive_day   (CREATE TYPE "GpsArchiveStatus"; CREATE TABLE
#   "GpsArchiveDay" + CHECKs + trigger trg_gps_archive_day_verified_immutable)   97 -> 98
# and swaps the image
#   titanor-time-app:t97-pilot-8724480  ->  titanor-time-app:t97-pilot-6a47ed3
#
# R08 behaviour that goes live:
#   * the scheduler's raw-GPS retention step is now ARCHIVE-GATED — it deletes a
#     ClockEventLocation / ShiftPresenceSample row only when its UTC reading-day has a VERIFIED
#     GpsArchiveDay and no un-archived row for that day remains;
#   * if GPS_ARCHIVE_ENCRYPTION_KEY is absent/malformed the retention step deletes NOTHING
#     (gateSkippedReason 'skipped_no_archive_key');
#   * GpsArchiveDay is empty on day one, so retention deletes 0 rows until the daily archive job
#     (systemd titanor-time-gps-archive@pilot — a SEPARATE install, see
#     R08_GPS_ARCHIVE_REPORT_RU.md §6) has run and VERIFIED some days. No data is deleted by this
#     deploy.
#   * .runtime/gps-archive.cjs (write / promote) ships in the image.
# R07-A behaviour (security headers, DB-backed rate limit, guardApiRequest, malformed-UUID 4xx)
# is re-verified below to prove nothing regressed.
#
#   Run:  bash /home/deploy/app-data/t97-pilot/deploy-6a47ed3.sh
#
set -Eeuo pipefail

IMAGE=titanor-time-app:t97-pilot-6a47ed3
ENVFILE=/home/deploy/app-data/t97-pilot/app.env
REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
NET=t97-pilot-net
DB=t97-pilot-db
DB_USER=t97_app
DB_NAME=titanor_time_t97
APP_PORT=3297
PREV_TAG=t97-pilot-8724480          # image to roll back to
MARK=6a47ed3                        # rollback-container suffix ("state before deploying <MARK>")
EXPECT_MIGRATIONS=98
PREV_MIGRATIONS=97
BACKUP_ROOT=/home/deploy/backups/titanor-time-pilot
MIRROR_ROOT=/mnt/250gb/titanor-time-foundation/backups/pilot
PUBLIC_URL=https://t97-dd686bc3d4.84.247.130.242.nip.io
LOCK=/home/deploy/app-data/t97-pilot/.deploy-${MARK}.lock

APP_HEALTHCMD='node -e "fetch(\"http://127.0.0.1:3000/api/ready\").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"'
SCHED_HEALTHCMD='node .runtime/attendance-scheduler-healthcheck.cjs'

SWAP_STARTED=0

die()  { echo "DEPLOY ABORTED: $*" >&2; exit 1; }
psqlq() { docker exec "$DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || echo 000; }

wait_health() {  # $1 container  $2 timeout_s
  local c=$1 t=$2 d=0 h
  while [ "$d" -lt "$t" ]; do
    h=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)
    [ "$h" = healthy ] && return 0
    [ "$h" = missing ] && return 1
    sleep 5; d=$((d + 5))
  done
  return 1
}

rollback() {
  echo
  echo "!!!!!!!!!!!!!!!!!!!!  ROLLBACK to $PREV_TAG  !!!!!!!!!!!!!!!!!!!!"
  echo "  NOTE: migration 98 (GpsArchiveDay) stays applied — it is additive and the"
  echo "  $PREV_TAG image tolerates an extra table ('schema: ahead' -> /api/ready still 200). No down-migration."
  echo "  GpsArchiveDay is empty; the $PREV_TAG scheduler's un-gated retention will resume its old"
  echo "  behaviour (delete raw GPS > 90 days). That is the pre-R08 state — acceptable for a rollback."
  docker rm -f t97-pilot-app t97-pilot-scheduler 2>/dev/null || true
  if docker inspect "t97-pilot-app-pre-$MARK" >/dev/null 2>&1; then
    docker rename "t97-pilot-app-pre-$MARK" t97-pilot-app && docker start t97-pilot-app \
      || echo "  !! could not restore t97-pilot-app — do it by hand"
  else
    echo "  !! t97-pilot-app-pre-$MARK missing — restore t97-pilot-app by hand"
  fi
  if docker inspect "t97-pilot-scheduler-pre-$MARK" >/dev/null 2>&1; then
    docker rename "t97-pilot-scheduler-pre-$MARK" t97-pilot-scheduler && docker start t97-pilot-scheduler \
      || echo "  !! could not restore t97-pilot-scheduler — do it by hand"
  else
    echo "  !! t97-pilot-scheduler-pre-$MARK missing — restore t97-pilot-scheduler by hand"
  fi
  echo "  the restored old scheduler re-INSERTs its own SchedulerLease row on its next tick."
  echo "  candidate image $IMAGE is untouched — fix the cause and retry."
  docker ps --filter name=t97-pilot --format '  {{.Names}}  {{.Image}}  {{.Status}}' || true
}

on_err() {
  local rc=$? line=$1
  echo "ERROR (rc=$rc) at line $line" >&2
  if [ "$SWAP_STARTED" = 1 ]; then rollback; fi
  exit "$rc"
}
trap 'on_err $LINENO' ERR

# ============================================================================================
echo "== 0/8  concurrency + state guard =="
exec 9>"$LOCK" || die "cannot open lock $LOCK"
flock -n 9 || die "another deploy-${MARK}.sh holds $LOCK (or a dead run left it — remove it only if you are sure)"

app_img=$(docker inspect t97-pilot-app       --format '{{.Config.Image}}' 2>/dev/null || echo none)
sch_img=$(docker inspect t97-pilot-scheduler --format '{{.Config.Image}}' 2>/dev/null || echo none)
pre_app=$(docker inspect "t97-pilot-app-pre-$MARK"       --format '{{.Id}}' 2>/dev/null || true)
pre_sch=$(docker inspect "t97-pilot-scheduler-pre-$MARK" --format '{{.Id}}' 2>/dev/null || true)

if [ -n "$pre_app" ] || [ -n "$pre_sch" ]; then
  echo "  rollback containers from a previous attempt exist:"
  [ -n "$pre_app" ] && echo "    t97-pilot-app-pre-$MARK"
  [ -n "$pre_sch" ] && echo "    t97-pilot-scheduler-pre-$MARK"
  die "this deploy was already attempted — resolve first (roll back, or once satisfied remove the -pre-$MARK containers BY HAND). This script never deletes rollback containers."
fi
if [ "$app_img" = "$IMAGE" ] && [ "$sch_img" = "$IMAGE" ]; then
  echo "  both t97-pilot-app and t97-pilot-scheduler already run $IMAGE — nothing to do."
  exit 0
fi
if [ "$app_img" = "$IMAGE" ] || [ "$sch_img" = "$IMAGE" ]; then
  die "half-swapped state (app=$app_img scheduler=$sch_img) — resolve by hand before re-running"
fi
echo "  ok — app on $app_img, scheduler on $sch_img, no -pre-$MARK containers"

echo
echo "== 1/8  candidate image present + labelled =="
docker image inspect "$IMAGE" --format '  id={{.Id}}' \
  || die "image $IMAGE not found — build it: cd $REPO && DOCKER_BUILDKIT=1 docker build -f titanor-time-app/Dockerfile --provenance=false --sbom=false --build-arg GIT_SHA=$MARK --build-arg GIT_REF=feature/titanor-time-foundation --build-arg BUILD_TIME=\$(date -u +%FT%TZ) -t $IMAGE ."
REV=$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[ "$REV" = "$MARK" ] || die "image revision label '$REV' != '$MARK' — wrong build"
docker image inspect "$IMAGE" --format '  revision={{index .Config.Labels "org.opencontainers.image.revision"}} created={{index .Config.Labels "org.opencontainers.image.created"}}'
docker run --rm -w /app --entrypoint sh "$IMAGE" -c 'test -f .runtime/gps-archive.cjs' \
  || die ".runtime/gps-archive.cjs missing from the image — wrong build"

echo
echo "== 2/8  preflight =="
[ -r "$ENVFILE" ] || die "env file $ENVFILE not readable"
grep -q '^DATABASE_URL=' "$ENVFILE"                  || die "DATABASE_URL missing from $ENVFILE"
grep -q '^PASSWORD_RESET_TOKEN_HMAC_KEY=' "$ENVFILE" || die "PASSWORD_RESET_TOKEN_HMAC_KEY missing from $ENVFILE"
# R08 — without a valid 32-byte base64 key the retention step is fail-closed (deletes nothing) and
# the archive job cannot run. Deploying without it would silently freeze raw-GPS retention.
grep -qE '^GPS_ARCHIVE_ENCRYPTION_KEY=[A-Za-z0-9+/]{42,}={0,2}$' "$ENVFILE" \
  || die "GPS_ARCHIVE_ENCRYPTION_KEY missing or not a base64 32-byte value in $ENVFILE (generate: openssl rand -base64 32)"
docker network inspect "$NET" >/dev/null 2>&1        || die "docker network $NET missing"
wait_health "$DB" 30                                 || die "$DB is not healthy"
[ "$(http_code "http://127.0.0.1:${APP_PORT}/api/ready")" != 000 ] || die "pilot app not reachable on :$APP_PORT before deploy"
PRE=$(psqlq "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
[ "$PRE" = "$PREV_MIGRATIONS" ] || die "pilot DB is at $PRE migrations, expected $PREV_MIGRATIONS before this deploy"
echo "  ok — pilot DB at $PRE migrations; GPS_ARCHIVE_ENCRYPTION_KEY present"

echo
echo "== 3/8  production baseline guard (captured now, re-checked at the end) =="
PROD_IMG_BEFORE=$(docker inspect titanor-time-app-1 --format '{{.Image}}')
PROD_STARTED_BEFORE=$(docker inspect titanor-time-app-1 --format '{{.State.StartedAt}}')
PROD_RESTARTS_BEFORE=$(docker inspect titanor-time-app-1 --format '{{.RestartCount}}')
PROD_SCHED_STARTED_BEFORE=$(docker inspect titanor-time-scheduler-1 --format '{{.State.StartedAt}}')
PROD_LATEST_BEFORE=$(docker images --no-trunc titanor-time-app:latest --format '{{.ID}}')
echo "  app-1 image=$PROD_IMG_BEFORE started=$PROD_STARTED_BEFORE restarts=$PROD_RESTARTS_BEFORE"
echo "  scheduler-1 started=$PROD_SCHED_STARTED_BEFORE"
echo "  :latest=$PROD_LATEST_BEFORE"

echo
echo "== 4/8  pre-deploy backup + off-box mirror (mandatory, fail-closed) =="
TT_BACKUP_ROOT="$BACKUP_ROOT" TT_MIRROR_ROOT="$MIRROR_ROOT" \
  bash "$REPO/ops/titanor-time/backup-titanor-time.sh" pre-deploy
BK=$(ls -1dt "$BACKUP_ROOT"/pilot-*-pre-deploy 2>/dev/null | head -1)
[ -n "$BK" ] && [ -f "$BK/SHA256SUMS" ] || die "pre-deploy backup did not publish a complete directory"
BKNAME=$(basename "$BK")
[ -f "$MIRROR_ROOT/$BKNAME/SHA256SUMS" ] || die "off-box mirror $MIRROR_ROOT/$BKNAME is incomplete — backup script warned; ABORT (task requires an off-box copy)"
( cd "$MIRROR_ROOT/$BKNAME" && sha256sum --quiet -c SHA256SUMS ) 2>/dev/null || die "off-box mirror checksum re-verify FAILED"
[ -f "$BK/gps-archive-manifest.json" ] || die "backup bundle is missing gps-archive-manifest.json (R08 backup-script change not in effect?)"
echo "  on-box:  $BK"
echo "  off-box: $MIRROR_ROOT/$BKNAME (checksum re-verified)"

echo
echo "== 5/8  migrate t97-pilot-db 97 -> 98 (fail-closed) =="
docker run --rm --network "$NET" --env-file "$ENVFILE" -w /app --entrypoint node "$IMAGE" \
  .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma \
  || die "migrate deploy failed"
STATUS_OUT=$(docker run --rm --network "$NET" --env-file "$ENVFILE" -w /app --entrypoint node "$IMAGE" \
  .prisma-tools/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma 2>&1)
echo "$STATUS_OUT" | sed 's/^/  /'
echo "$STATUS_OUT" | grep -q 'Database schema is up to date!' || die "migrate status is not 'up to date'"
APPLIED=$(psqlq "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
FAILED=$(psqlq  "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")
[ "$APPLIED" = "$EXPECT_MIGRATIONS" ] || die "applied migrations=$APPLIED, expected $EXPECT_MIGRATIONS"
[ "$FAILED" = "0" ]                   || die "$FAILED unfinished/rolled-back migration rows"
[ "$(psqlq "SELECT to_regclass('public.\"GpsArchiveDay\"') IS NOT NULL")" = "t" ] || die "GpsArchiveDay table not created"
[ "$(psqlq "SELECT count(*) FROM pg_trigger WHERE tgname='trg_gps_archive_day_verified_immutable'")" = "1" ] || die "trg_gps_archive_day_verified_immutable not created"
[ "$(psqlq "SELECT count(*) FROM \"GpsArchiveDay\"")" = "0" ] || die "GpsArchiveDay is not empty on a fresh migration"
LAST_MIG=$(psqlq "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 1")
echo "  migrations: $PRE -> $APPLIED (0 failed); newest = $LAST_MIG; GpsArchiveDay present + empty + trigger"

# ============================================================================================
echo
echo "== 6/8  swap (automatic rollback on any failure from here) =="
SWAP_STARTED=1

OLD_APP_ID=$(docker inspect t97-pilot-app --format '{{.Id}}')
OLD_SCHED_ID=$(docker inspect t97-pilot-scheduler --format '{{.Id}}')
OLD_SCHED_HOST=$(docker inspect t97-pilot-scheduler --format '{{.Config.Hostname}}')
echo "  old app=${OLD_APP_ID:0:12}  old scheduler=${OLD_SCHED_ID:0:12} (hostname $OLD_SCHED_HOST)"

# ---- app ----
echo "  -- t97-pilot-app --"
docker stop -t 30 t97-pilot-app || true
docker rename t97-pilot-app "t97-pilot-app-pre-$MARK"
docker run -d --name t97-pilot-app --network "$NET" --init \
  -p 127.0.0.1:${APP_PORT}:3000 \
  -v /home/deploy/app-data/t97-pilot/uploads:/app/uploads \
  --env-file "$ENVFILE" --restart unless-stopped \
  --health-cmd "$APP_HEALTHCMD" --health-interval 30s --health-timeout 10s --health-retries 3 --health-start-period 45s \
  "$IMAGE"

# ---- scheduler ----
echo "  -- t97-pilot-scheduler (graceful stop) --"
# The outgoing scheduler ($PREV_TAG) is the bundled `node .runtime/...cjs` with --init, so SIGTERM
# reaches it and it releases its SchedulerLease before exit 0. The stale-lease block below is kept
# as the R06-B.1 safety net in case the stop is not graceful for any reason.
set +e
docker stop -t 30 t97-pilot-scheduler
STOP_RC=$?
set -e
docker rename t97-pilot-scheduler "t97-pilot-scheduler-pre-$MARK"
echo "     old scheduler stop rc=$STOP_RC (0 = graceful; 137 = SIGKILL — would leave a stale lease)"

LEASE_HOLDER=$(psqlq "SELECT \"holderId\" FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler'" || true)
if [ -n "$LEASE_HOLDER" ] && [ "${LEASE_HOLDER%%:*}" = "$OLD_SCHED_HOST" ]; then
  RUNNING=$(docker inspect "$OLD_SCHED_ID" --format '{{.State.Running}}' 2>/dev/null || echo unknown)
  PID=$(docker inspect "$OLD_SCHED_ID" --format '{{.State.Pid}}' 2>/dev/null || echo unknown)
  OTHER=""
  for c in $(docker ps -q); do
    [ "$(docker inspect "$c" --format '{{.Config.Hostname}}' 2>/dev/null)" = "$OLD_SCHED_HOST" ] && OTHER="$c"
  done
  if [ "$RUNNING" = "false" ] && [ "$PID" = "0" ] && [ -z "$OTHER" ]; then
    echo "     old scheduler did not release its lease — clearing exactly that stale row ($LEASE_HOLDER)"
    DEL=$(psqlq "DELETE FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler' AND \"holderId\"='${LEASE_HOLDER}'; SELECT 'ok'")
    [ "$DEL" = ok ] || die "stale-lease DELETE did not run cleanly"
  else
    die "lease held by $LEASE_HOLDER but the old scheduler is not provably dead (running=$RUNNING pid=$PID other=$OTHER) — not touching the lease"
  fi
elif [ -n "$LEASE_HOLDER" ]; then
  echo "     lease currently held by $LEASE_HOLDER (not the old container) — left untouched"
else
  echo "     no SchedulerLease row (old scheduler released it cleanly)"
fi

docker run -d --name t97-pilot-scheduler --network "$NET" --init \
  --env-file "$ENVFILE" --restart unless-stopped \
  --health-cmd "$SCHED_HEALTHCMD" --health-interval 30s --health-timeout 10s --health-retries 3 --health-start-period 90s \
  "$IMAGE" node .runtime/attendance-auto-submit-scheduler.cjs

NEW_SCHED_HOST=$(docker inspect t97-pilot-scheduler --format '{{.Config.Hostname}}')
SCHED_STARTED_AT=$(docker inspect t97-pilot-scheduler --format '{{.State.StartedAt}}')

# ============================================================================================
echo
echo "== 7/8  verify (fail-closed — any failure rolls back) =="
FAILS=0
note_fail() { echo "  FAIL: $*"; FAILS=$((FAILS + 1)); }
BASE="http://127.0.0.1:${APP_PORT}"

echo "  -- app health + /api/ready body --"
wait_health t97-pilot-app 150 || note_fail "t97-pilot-app never became healthy"
RC=$(http_code "$BASE/api/ready")
BODY=$(curl -s --max-time 10 "$BASE/api/ready" || true)
echo "     /api/ready -> $RC  $BODY"
[ "$RC" = 200 ] || note_fail "/api/ready http $RC"
echo "$BODY" | grep -q '"status":"ready"'   || note_fail "/api/ready status != ready"
echo "$BODY" | grep -q '"schema":"current"' || note_fail "/api/ready schema != current"
echo "$BODY" | grep -Eq "\"applied\":${EXPECT_MIGRATIONS}\b"  || note_fail "/api/ready applied != $EXPECT_MIGRATIONS"
echo "$BODY" | grep -Eq "\"expected\":${EXPECT_MIGRATIONS}\b" || note_fail "/api/ready expected != $EXPECT_MIGRATIONS"
[ "$(http_code "$BASE/api/health")" = 200 ] || note_fail "/api/health not 200"
for p in /login /reset-password; do
  c=$(http_code "$BASE$p"); echo "     $p -> $c"
  case "$c" in 2*|3*) :;; *) note_fail "$p http $c";; esac
done

echo "  -- R07-A: security headers + no X-Powered-By + robots (regression) --"
H=$(curl -s -D - -o /dev/null --max-time 10 "$BASE/login" || true)
for want in "X-Content-Type-Options" "X-Frame-Options" "Referrer-Policy" "Cross-Origin-Opener-Policy" "Permissions-Policy" "Strict-Transport-Security" "X-Robots-Tag"; do
  printf '%s' "$H" | grep -qi "^${want}:" && echo "     header ok: ${want}" || note_fail "missing header ${want}"
done
printf '%s' "$H" | grep -qi '^x-powered-by:' && note_fail "X-Powered-By is present" || echo "     no X-Powered-By"
ROBOTS=$(curl -s --max-time 10 "$BASE/robots.txt" || true)
printf '%s' "$ROBOTS" | grep -qi 'Disallow: /' && echo "     /robots.txt disallows all" || note_fail "/robots.txt not Disallow: /"

echo "  -- R07-A: DB-backed rate limit is live (regression) --"
PROBE="__deploy_rl_probe_${MARK}__"
PROBE_IP="192.0.2.247"
PROBE_ID_KEY="identifier:$PROBE"
PROBE_IP_KEY="ip:$PROBE_IP"
[ -z "$(psqlq "SELECT 1 FROM \"RateLimitCounter\" WHERE key='$PROBE_IP_KEY'" || echo x)" ] \
  || note_fail "$PROBE_IP_KEY already exists in RateLimitCounter — cannot run a clean rate-limit probe"
LAST=""
for i in 1 2 3 4 5 6; do
  LAST=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BASE/api/auth/login" \
    -H 'content-type: application/json' -H 'x-requested-with: titanor-time' -H "x-forwarded-for: $PROBE_IP" \
    --data "{\"identifier\":\"$PROBE\",\"password\":\"wrong-on-purpose\"}")
done
echo "     6th probe login -> $LAST (expect 429)"
[ "$LAST" = 429 ] || note_fail "rate limit did not trigger (6th attempt was $LAST, not 429)"
[ -n "$(psqlq "SELECT count FROM \"RateLimitCounter\" WHERE key='$PROBE_IP_KEY'" || echo "")" ] \
  || note_fail "no RateLimitCounter row for $PROBE_IP_KEY"
psqlq "DELETE FROM \"RateLimitCounter\" WHERE key = '$PROBE_ID_KEY'" >/dev/null || true
psqlq "DELETE FROM \"RateLimitCounter\" WHERE key = '$PROBE_IP_KEY'" >/dev/null || true
echo "     probe rows removed ($PROBE_ID_KEY , $PROBE_IP_KEY)"

echo "  -- R07-A: malformed [id] -> 4xx not 500 (regression) --"
UC=$(http_code "$BASE/api/admin/reports/periods/not-a-uuid")
echo "     GET /api/admin/reports/periods/not-a-uuid (no session) -> $UC"
case "$UC" in 5*|000) note_fail "malformed UUID route returned $UC";; *) echo "     ok (4xx)";; esac

echo "  -- R08: gps-archive bundle in the running image + fail-closed --"
if docker exec t97-pilot-app node .runtime/gps-archive.cjs bogus >/dev/null 2>&1; then
  note_fail "gps-archive.cjs bogus mode should exit non-zero"
else
  GA_RC=$?
  [ "$GA_RC" = 2 ] && echo "     bogus mode -> exit 2 (bundle loads)" || note_fail "gps-archive.cjs bogus exit $GA_RC (expected 2)"
fi
if docker exec -e GPS_ARCHIVE_ENCRYPTION_KEY= t97-pilot-app node .runtime/gps-archive.cjs write >/dev/null 2>&1; then
  note_fail "gps-archive.cjs write with an empty key should exit non-zero (fail-closed)"
else
  GA_RC=$?
  [ "$GA_RC" = 3 ] && echo "     empty-key write -> exit 3 (fail-closed)" || note_fail "gps-archive.cjs empty-key write exit $GA_RC (expected 3)"
fi

echo "  -- scheduler: lease held & renewed by the NEW holder + ok tick --"
d=0; SCHED_OK=0
while [ "$d" -lt 300 ]; do
  LH=$(psqlq "SELECT \"holderId\" FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler'" || true)
  HB=$(docker exec t97-pilot-scheduler cat /tmp/attendance-scheduler-heartbeat.json 2>/dev/null || true)
  if [ "${LH%%:*}" = "$NEW_SCHED_HOST" ] && [ -n "$HB" ]; then
    OUT=$(printf '%s' "$HB" | sed -n 's/.*"lastOutcome":"\([a-z_]*\)".*/\1/p')
    CF=$(printf '%s' "$HB"  | sed -n 's/.*"consecutiveFailures":\([0-9]*\).*/\1/p')
    [ "$OUT" = ok ] && [ "$CF" = 0 ] && { SCHED_OK=1; break; }
  fi
  sleep 10; d=$((d + 10))
done
echo "     lease: $(psqlq "SELECT \"holderId\"||'  renewed '||\"renewedAt\" FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler'" || echo '<none>')"
echo "     heartbeat: $(docker exec t97-pilot-scheduler cat /tmp/attendance-scheduler-heartbeat.json 2>/dev/null || echo '<none>')"
[ "$SCHED_OK" = 1 ] || note_fail "scheduler did not reach {lease held by $NEW_SCHED_HOST, lastOutcome=ok, consecutiveFailures=0} within 300s"
LEASE_AGE=$(psqlq "SELECT extract(epoch FROM now()-\"renewedAt\")::int FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler'" || echo 99999)
case "$LEASE_AGE" in ''|*[!0-9]*) LEASE_AGE=99999;; esac
[ "$LEASE_AGE" -lt 180 ] || note_fail "lease renewedAt is stale (${LEASE_AGE}s)"
if docker exec t97-pilot-scheduler node .runtime/attendance-scheduler-healthcheck.cjs; then
  echo "     scheduler healthcheck exit 0"
else
  note_fail "scheduler healthcheck exit $?"
fi
wait_health t97-pilot-scheduler 180 || note_fail "t97-pilot-scheduler never became healthy"
SLOG=$(docker logs --since "$SCHED_STARTED_AT" t97-pilot-scheduler 2>&1 || true)
for ev in attendance_auto_submit_tick abandoned_shift_auto_close attendance_location_retention timesheet_period_generation; do
  printf '%s' "$SLOG" | grep -q "\"event\":\"$ev\"" && echo "     op ok: $ev" || note_fail "background op not seen since start: $ev"
done
printf '%s' "$SLOG" | grep -q 'SCHEDULER_LEASE_HELD_BY_ANOTHER' && note_fail "scheduler logging OVERLAPPING after the swap"

echo "  -- R08: retention step is archive-gated and ran clean --"
RET_LINE=$(printf '%s' "$SLOG" | grep '"event":"attendance_location_retention"' | tail -1)
echo "     $RET_LINE"
printf '%s' "$RET_LINE" | grep -q '"retentionOutcome":"ok"' \
  && echo "     retentionOutcome=ok (key present)" \
  || note_fail "retention did not log retentionOutcome=ok (got: $RET_LINE)"
printf '%s' "$RET_LINE" | grep -q '"retentionOutcome":"top_level_error"' && note_fail "retention logged top_level_error"

echo "     external $PUBLIC_URL/login -> $(http_code "$PUBLIC_URL/login") (informational; Caddy not in scope)"

if [ "$FAILS" -ne 0 ]; then
  echo
  echo "  $FAILS verification failure(s) — rolling back."
  SWAP_STARTED=0
  rollback
  exit 1
fi
SWAP_STARTED=0
echo "  all verification checks passed."

# ============================================================================================
echo
echo "== 8/8  production baseline guard — must be identical =="
PROD_IMG_AFTER=$(docker inspect titanor-time-app-1 --format '{{.Image}}')
PROD_STARTED_AFTER=$(docker inspect titanor-time-app-1 --format '{{.State.StartedAt}}')
PROD_RESTARTS_AFTER=$(docker inspect titanor-time-app-1 --format '{{.RestartCount}}')
PROD_SCHED_STARTED_AFTER=$(docker inspect titanor-time-scheduler-1 --format '{{.State.StartedAt}}')
PROD_LATEST_AFTER=$(docker images --no-trunc titanor-time-app:latest --format '{{.ID}}')
echo "  app-1 image=$PROD_IMG_AFTER started=$PROD_STARTED_AFTER restarts=$PROD_RESTARTS_AFTER"
echo "  :latest=$PROD_LATEST_AFTER"
if [ "$PROD_IMG_BEFORE" != "$PROD_IMG_AFTER" ] || [ "$PROD_STARTED_BEFORE" != "$PROD_STARTED_AFTER" ] \
   || [ "$PROD_RESTARTS_BEFORE" != "$PROD_RESTARTS_AFTER" ] || [ "$PROD_LATEST_BEFORE" != "$PROD_LATEST_AFTER" ] \
   || [ "$PROD_SCHED_STARTED_BEFORE" != "$PROD_SCHED_STARTED_AFTER" ]; then
  echo "  !! PRODUCTION CHANGED — investigate immediately"; exit 2
fi
echo "  production unchanged"

echo
docker ps --filter name=t97-pilot --format '  {{.Names}}  {{.Image}}  {{.Status}}'
echo
echo "DEPLOY OK — pilot on $IMAGE, DB at $EXPECT_MIGRATIONS migrations."
echo
echo "NEXT (separate, owner): install the GPS archive timer so days actually get archived —"
echo "  R08_GPS_ARCHIVE_REPORT_RU.md §6 step 3. Until then GpsArchiveDay stays empty and the"
echo "  scheduler's retention step correctly deletes 0 raw-GPS rows."
echo
echo "Post-deploy manual check (recommended): open the pilot UI, log in, confirm normal use."
echo
echo "Manual rollback later (back to $PREV_TAG; migration 98 stays — additive, tolerated):"
echo "  docker rm -f t97-pilot-app t97-pilot-scheduler"
echo "  docker rename t97-pilot-app-pre-$MARK t97-pilot-app"
echo "  docker rename t97-pilot-scheduler-pre-$MARK t97-pilot-scheduler"
echo "  docker start t97-pilot-app t97-pilot-scheduler"
