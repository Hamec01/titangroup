#!/usr/bin/env bash
# R14 — Titanor Time production cutover, runbook steps 3–16 (docs/titanor-time/R14_CUTOVER_RUNBOOK_RU.md).
#
# Does NOT need sudo. Does NOT touch Caddy or DNS (that is step 17 — apply-caddy-r14.sh, run by
# the owner with sudo). Fail-closed: any failure after the old stack is stopped triggers an
# automatic rollback (old prod + pilot back up; the new prod stack is left for inspection).
#
# The restore / boot / reconcile / rollback mechanics here are the ones proven 10/10 on
# disposable infra by ops/titanor-time/r12-rehearsal.sh; this script runs them against the
# real container names and the real old-prod stack.
#
#   bash ops/titanor-time/r14/preflight-r14.sh            # read-only, run first (also standalone)
#   bash ops/titanor-time/r14/cutover-r14.sh --go         # execute steps 3–16
#   bash ops/titanor-time/r14/rollback-r14.sh             # manual rollback (also auto on failure)
#
# Env overrides (defaults are the R14 plan):
#   RELEASE_IMAGE   titanor-time-app:r14-release-1416503
#   RELEASE_DIGEST  sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb
#   PREV_IMAGE      titanor-time-app:t97-pilot-edd950c        (rollback web/scheduler image)
#   PROD_ENV        /home/deploy/app-data/titanor-time-prod/app.env
set -Eeuo pipefail

REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
RELEASE_IMAGE="${RELEASE_IMAGE:-titanor-time-app:r14-release-1416503}"
RELEASE_DIGEST="${RELEASE_DIGEST:-sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb}"
PREV_IMAGE="${PREV_IMAGE:-titanor-time-app:t97-pilot-edd950c}"
EXPECT_MIGRATIONS="${EXPECT_MIGRATIONS:-98}"

# --- new prod stack ---
PROD_NET=titanor-time-prod-net
PROD_DB=titanor-time-prod-db
PROD_WEB=titanor-time-prod-app
PROD_SCHED=titanor-time-prod-scheduler
PROD_DB_VOL=titanor-time-prod-db-data
PROD_PORT=3199
PROD_DATA=/home/deploy/app-data/titanor-time-prod
PROD_ENV="${PROD_ENV:-$PROD_DATA/app.env}"
PROD_UPLOADS="$PROD_DATA/uploads"
PROD_DB_ROLE=titanor_time_prod
PROD_DB_NAME=titanor_time

# --- old prod stack (compose.titanor-time.yaml) — stopped, kept for rollback ---
OLD_WEB=titanor-time-app-1
OLD_SCHED=titanor-time-scheduler-1
OLD_DB=titanor-time-db-1
OLD_DB_USER=titanor_time_app
OLD_DB_NAME=titanor_time
OLD_UPLOADS=/home/deploy/app-data/titanor-time/uploads

# --- pilot (data source) — frozen during the window ---
PILOT_WEB=t97-pilot-app
PILOT_SCHED=t97-pilot-scheduler
PILOT_DB=t97-pilot-db
PILOT_ENV=/home/deploy/app-data/t97-pilot/app.env
BACKUP_ROOT=/home/deploy/backups/titanor-time-pilot
OLDPROD_BACKUP_ROOT=/home/deploy/backups/titanor-time-old-prod

STAGE=pre    # pre = nothing destructive done yet; swap = old stack stopped
die() { echo "CUTOVER ABORTED: $*" >&2; exit 1; }
q_prod() { docker exec "$PROD_DB" psql -U "$PROD_DB_ROLE" -d "$PROD_DB_NAME" -tAc "$1"; }
# curl prints "000" (from -w) AND exits non-zero on connection failure -> a `|| echo 000` form
# yields "000000". Take curl's output only when curl succeeded; otherwise emit one "000".
http_code() { local o; if o=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null); then printf '%s' "$o"; else printf '000'; fi; }

rollback() {
  echo
  echo "!!!!!!!!!!!!!!!!!!!!  ROLLBACK  !!!!!!!!!!!!!!!!!!!!"
  echo "  old prod DB was only read (pg_dump) — no restore needed."
  docker rm -f "$PROD_WEB" "$PROD_SCHED" >/dev/null 2>&1 || true
  echo "  (kept $PROD_DB + volume $PROD_DB_VOL for inspection — remove by hand once satisfied)"
  echo "  restarting old prod stack..."
  docker start "$OLD_DB" >/dev/null 2>&1 || echo "   !! start $OLD_DB by hand"
  sleep 3
  docker start "$OLD_WEB" "$OLD_SCHED" >/dev/null 2>&1 || echo "   !! start $OLD_WEB/$OLD_SCHED by hand"
  echo "  restarting pilot..."
  docker start "$PILOT_WEB" "$PILOT_SCHED" >/dev/null 2>&1 || echo "   !! start pilot by hand"
  echo "  Caddy: app.titanorgroup.fi is still on 503 holding (not switched) — leave it."
  echo "  If step 17 already ran: sudo bash $REPO/ops/titanor-time/r14/apply-caddy-r14.sh --rollback"
  docker ps --format '  {{.Names}}  {{.Image}}  {{.Status}}' | grep -E 'titanor-time|t97-pilot' || true
}
on_err() { local rc=$? ln=$1; echo "ERROR rc=$rc at line $ln" >&2; [ "$STAGE" = swap ] && rollback; exit "$rc"; }
trap 'on_err $LINENO' ERR

[ "${1:-}" = "--go" ] || die "refusing to run without --go (this replaces production). Run preflight-r14.sh first."

echo "==================== R14 CUTOVER — steps 3–16 ===================="
echo "release: $RELEASE_IMAGE"
echo "date:    $(date -u +%FT%TZ) / $(TZ=Europe/Helsinki date '+%H:%M:%S Helsinki')"
echo

echo "== guard =="
docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}' | grep -qx "$RELEASE_DIGEST" \
  || die "$RELEASE_IMAGE is not $RELEASE_DIGEST"
docker image inspect "$PREV_IMAGE" >/dev/null 2>&1 || die "rollback image $PREV_IMAGE missing"
[ -r "$PROD_ENV" ] || die "prod env $PROD_ENV not readable — create it first (13 keys, runbook §1)"
for k in DATABASE_URL POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB ACTIVATION_TOKEN_HMAC_KEY \
         GPS_ARCHIVE_ENCRYPTION_KEY IDEMPOTENCY_ENCRYPTION_KEY PASSWORD_RESET_TOKEN_HMAC_KEY \
         PERSONAL_DATA_ENCRYPTION_KEY NODE_ENV PORT HOSTNAME NEXT_TELEMETRY_DISABLED; do
  grep -qE "^${k}=" "$PROD_ENV" || die "prod env missing key: $k"
done
grep -qE '^TITANOR_TRUSTED_PROXY_HOPS=' "$PROD_ENV" && die "TITANOR_TRUSTED_PROXY_HOPS must NOT be set (Variant A)"
for c in "$PROD_NET" ; do docker network inspect "$c" >/dev/null 2>&1 && die "network $c already exists — clean up a previous attempt"; done
for c in "$PROD_DB" "$PROD_WEB" "$PROD_SCHED"; do docker inspect "$c" >/dev/null 2>&1 && die "container $c already exists — clean up a previous attempt"; done
[ "$(http_code "http://127.0.0.1:${PROD_PORT}/api/ready")" = 000 ] || die "something already answers on :${PROD_PORT}"
for c in "$OLD_WEB" "$OLD_DB" "$PILOT_WEB" "$PILOT_SCHED"; do
  [ "$(docker inspect "$c" --format '{{.State.Running}}' 2>/dev/null)" = true ] || die "$c is not running — unexpected pre-cutover state"
done
PILOT_READY=$(curl -s --max-time 8 "http://127.0.0.1:3297/api/ready" || true)
echo "$PILOT_READY" | grep -Eq "\"applied\":${EXPECT_MIGRATIONS}[^0-9]" \
  || die "pilot /api/ready not at $EXPECT_MIGRATIONS migrations: ${PILOT_READY:-<none>}"
echo "  ok — release digest matches, prod env has 13 keys, :$PROD_PORT free, old prod + pilot running, pilot at $EXPECT_MIGRATIONS migrations"
mkdir -p "$PROD_UPLOADS"

# ---- crypto keys for the disposable restore checks / containers ----
KEYS=()
for k in IDEMPOTENCY_ENCRYPTION_KEY ACTIVATION_TOKEN_HMAC_KEY PERSONAL_DATA_ENCRYPTION_KEY PASSWORD_RESET_TOKEN_HMAC_KEY GPS_ARCHIVE_ENCRYPTION_KEY; do
  v=$(grep -oE "^${k}=.*" "$PROD_ENV" | cut -d= -f2-); [ -n "$v" ] && KEYS+=(-e "${k}=${v}")
done

echo
echo "== step 3–4: stop old prod scheduler + web =="
STAGE=swap
docker stop -t 30 "$OLD_SCHED" >/dev/null && echo "  stopped $OLD_SCHED"
docker stop -t 30 "$OLD_WEB"   >/dev/null && echo "  stopped $OLD_WEB"

echo
echo "== step 5: MANDATORY backup of the old prod DB + uploads =="
TT_ENV=old-prod TT_DB_CONTAINER="$OLD_DB" TT_DB_USER="$OLD_DB_USER" TT_DB_NAME="$OLD_DB_NAME" \
  TT_UPLOADS_DIR="$OLD_UPLOADS" TT_APP_CONTAINER="$OLD_WEB" TT_BACKUP_ROOT="$OLDPROD_BACKUP_ROOT" \
  bash "$REPO/ops/titanor-time/backup-titanor-time.sh" pre-migration
OP_BK=$(ls -1dt "$OLDPROD_BACKUP_ROOT"/old-prod-*-pre-migration 2>/dev/null | head -1)
[ -n "$OP_BK" ] && [ -f "$OP_BK/SHA256SUMS" ] || die "old-prod backup incomplete"
( cd "$OP_BK" && sha256sum --quiet -c SHA256SUMS ) || die "old-prod backup checksum FAILED"
echo "  old prod backup OK: $OP_BK"

echo
echo "== step 6: freeze the pilot =="
docker stop -t 30 "$PILOT_SCHED" >/dev/null && echo "  stopped $PILOT_SCHED"
docker stop -t 30 "$PILOT_WEB"   >/dev/null && echo "  stopped $PILOT_WEB"

echo
echo "== step 7: final pilot snapshot =="
bash "$REPO/ops/titanor-time/backup-titanor-time.sh" manual
SNAP=$(ls -1dt "$BACKUP_ROOT"/pilot-*-manual 2>/dev/null | head -1)
[ -n "$SNAP" ] && [ -f "$SNAP/SHA256SUMS" ] || die "final pilot snapshot incomplete"
( cd "$SNAP" && sha256sum --quiet -c SHA256SUMS ) || die "final pilot snapshot checksum FAILED"
SNAP_MIG=$(awk -F= '/^migrations_applied/{gsub(/ /,"",$2);print $2}' "$SNAP/structure.txt" | head -1)
SNAP_ROWS=$(awk -F= '/^public_row_total /{gsub(/ /,"",$2);print $2}' "$SNAP/manifest.txt")
SNAP_UPLOADS=$(awk -F= '/^uploads_files /{gsub(/ /,"",$2);print $2}' "$SNAP/manifest.txt")
[ "${SNAP_MIG:-0}" = "$EXPECT_MIGRATIONS" ] || die "final snapshot reports ${SNAP_MIG:-?} migrations, expected $EXPECT_MIGRATIONS"
echo "  snapshot: $SNAP  (migrations=$SNAP_MIG, public_row_total=${SNAP_ROWS:-?}, uploads_files=${SNAP_UPLOADS:-0})"

echo
echo "== step 8: prod network + DB =="
docker network create "$PROD_NET" >/dev/null && echo "  created $PROD_NET"
PROD_DB_PW=$(grep -oE '^POSTGRES_PASSWORD=.*' "$PROD_ENV" | cut -d= -f2-)
docker run -d --name "$PROD_DB" --network "$PROD_NET" --restart unless-stopped \
  -e POSTGRES_DB="$PROD_DB_NAME" -e POSTGRES_USER="$PROD_DB_ROLE" -e POSTGRES_PASSWORD="$PROD_DB_PW" \
  -v "$PROD_DB_VOL":/var/lib/postgresql/data \
  --health-cmd "pg_isready -U $PROD_DB_ROLE -d $PROD_DB_NAME" --health-interval 3s --health-retries 30 \
  postgres:16 >/dev/null
for _ in $(seq 1 60); do [ "$(docker inspect "$PROD_DB" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break; sleep 1; done
[ "$(docker inspect "$PROD_DB" --format '{{.State.Health.Status}}')" = healthy ] || die "$PROD_DB not healthy"
echo "  $PROD_DB healthy"

echo
echo "== step 9–10: restore snapshot (--no-owner --no-acl) + uploads =="
docker run --rm -v "${SNAP}:/b:ro" --network "$PROD_NET" -e PGPASSWORD="$PROD_DB_PW" postgres:16 \
  pg_restore --no-owner --no-acl --exit-on-error -h "$PROD_DB" -U "$PROD_DB_ROLE" -d "$PROD_DB_NAME" /b/db.dump \
  || die "pg_restore failed"
if [ -f "$SNAP/uploads.tar.gz" ]; then
  tar -C "$PROD_UPLOADS" -xzf "$SNAP/uploads.tar.gz"
  GOT_UP=$(find "$PROD_UPLOADS" -type f ! -name '.gitkeep' | wc -l | tr -d ' ')
  [ "$GOT_UP" = "${SNAP_UPLOADS:-0}" ] || die "uploads restore: $GOT_UP files vs snapshot ${SNAP_UPLOADS:-0}"
  echo "  uploads: $GOT_UP files restored (== snapshot)"
elif [ -f "$SNAP/uploads.empty" ]; then
  echo "  uploads: snapshot recorded empty"
fi
RES_MIG=$(q_prod "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
RES_FAIL=$(q_prod "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")
[ "$RES_MIG" = "$EXPECT_MIGRATIONS" ] || die "restored DB has $RES_MIG migrations, expected $EXPECT_MIGRATIONS"
[ "$RES_FAIL" = 0 ] || die "$RES_FAIL unfinished/rolled-back migration rows in restore"
echo "  restored: $RES_MIG migrations, 0 failed"

echo
echo "== step 11: revoke sessions + clear carried-over scheduler lease =="
S_BEFORE=$(q_prod 'SELECT count(*) FROM "UserSession"')
q_prod 'DELETE FROM "UserSession"' >/dev/null
L_BEFORE=$(q_prod 'SELECT count(*) FROM "SchedulerLease"')
q_prod 'DELETE FROM "SchedulerLease"' >/dev/null
[ "$(q_prod 'SELECT count(*) FROM "UserSession"')" = 0 ] || die "UserSession not cleared"
[ "$(q_prod 'SELECT count(*) FROM "SchedulerLease"')" = 0 ] || die "SchedulerLease not cleared"
echo "  UserSession $S_BEFORE -> 0 ; SchedulerLease $L_BEFORE -> 0"

echo
echo "== step 12: migrate status (read-only; expect up to date) =="
PROD_URL="postgresql://${PROD_DB_ROLE}:${PROD_DB_PW}@${PROD_DB}:5432/${PROD_DB_NAME}"
MST=$(docker run --rm --network "$PROD_NET" -e DATABASE_URL="$PROD_URL" -w /app --entrypoint node "$RELEASE_IMAGE" \
  .prisma-tools/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma 2>&1 || true)
echo "$MST" | grep -qiE 'Database schema is up to date|No pending migrations' \
  || { echo "$MST" | sed 's/^/    /'; die "migrate status not clean — investigate (this script never runs migrate deploy)"; }
echo "  migrate status: up to date, no pending"

echo
echo "== step 13: prod web on 127.0.0.1:${PROD_PORT} =="
APP_HEALTH='node -e "fetch(\"http://127.0.0.1:3000/api/ready\").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"'
docker run -d --name "$PROD_WEB" --network "$PROD_NET" --init --restart unless-stopped \
  -p 127.0.0.1:${PROD_PORT}:3000 -v "$PROD_UPLOADS":/app/uploads --env-file "$PROD_ENV" \
  -e DATABASE_URL="$PROD_URL" \
  --health-cmd "$APP_HEALTH" --health-interval 15s --health-timeout 5s --health-retries 4 --health-start-period 40s \
  "$RELEASE_IMAGE" >/dev/null
READY=""
for _ in $(seq 1 60); do READY=$(curl -s --max-time 4 "http://127.0.0.1:${PROD_PORT}/api/ready" || true); echo "$READY" | grep -q '"schema":"current"' && break; sleep 2; done
echo "  /api/ready -> $READY"
echo "$READY" | grep -q '"status":"ready"'   || die "prod web not ready"
echo "$READY" | grep -q '"schema":"current"' || die "prod web schema not current"
echo "$READY" | grep -Eq "\"applied\":${EXPECT_MIGRATIONS}[^0-9]" || die "prod web applied != $EXPECT_MIGRATIONS"

echo
echo "== step 14: prod scheduler =="
SCHED_HEALTH='node .runtime/attendance-scheduler-healthcheck.cjs'
docker run -d --name "$PROD_SCHED" --network "$PROD_NET" --init --restart unless-stopped \
  --env-file "$PROD_ENV" -e DATABASE_URL="$PROD_URL" \
  --health-cmd "$SCHED_HEALTH" --health-interval 30s --health-timeout 10s --health-retries 3 --health-start-period 90s \
  "$RELEASE_IMAGE" node .runtime/attendance-auto-submit-scheduler.cjs >/dev/null
NEW_SCHED_HOST=$(docker inspect "$PROD_SCHED" --format '{{.Config.Hostname}}')
SCHED_OK=0
for _ in $(seq 1 40); do
  LH=$(q_prod "SELECT \"holderId\" FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler'" || true)
  HB=$(docker exec "$PROD_SCHED" cat /tmp/attendance-scheduler-heartbeat.json 2>/dev/null || true)
  echo "$HB" | grep -q OVERLAPPING && die "prod scheduler OVERLAPPING"
  if [ "${LH%%:*}" = "$NEW_SCHED_HOST" ] && [ -n "$HB" ]; then
    OUT=$(printf '%s' "$HB" | sed -n 's/.*"lastOutcome":"\([a-z_]*\)".*/\1/p')
    CF=$(printf '%s' "$HB"  | sed -n 's/.*"consecutiveFailures":\([0-9]*\).*/\1/p')
    [ "$OUT" = ok ] && [ "$CF" = 0 ] && { SCHED_OK=1; break; }
  fi
  sleep 10
done
[ "$SCHED_OK" = 1 ] || die "prod scheduler did not reach {lease=$NEW_SCHED_HOST, lastOutcome=ok, consecutiveFailures=0}"
docker exec "$PROD_SCHED" node .runtime/attendance-scheduler-healthcheck.cjs || die "prod scheduler healthcheck non-zero"
echo "  scheduler healthy, lease held by $NEW_SCHED_HOST, tick ok"

echo
echo "== step 15: reconcile with the final snapshot =="
echo "  restored migrations: $RES_MIG (snapshot manifest: see $SNAP/manifest.txt)"
echo "  restored public rows spot-check:"
q_prod "SELECT 'User='||count(*) FROM \"User\"" ; q_prod "SELECT 'Employee='||count(*) FROM \"Employee\"" ; q_prod "SELECT 'ClockShift='||count(*) FROM \"ClockShift\""

echo
echo "== step 16 (agent part): endpoint + header checks =="
BASE="http://127.0.0.1:${PROD_PORT}"
FAILS=0; nf() { echo "  FAIL: $*"; FAILS=$((FAILS+1)); }
[ "$(http_code "$BASE/api/health")" = 200 ] || nf "/api/health not 200"
for p in /login /reset-password; do c=$(http_code "$BASE$p"); echo "  $p -> $c"; case "$c" in 2*|3*) :;; *) nf "$p $c";; esac; done
H=$(curl -s -D - -o /dev/null --max-time 10 "$BASE/login" || true)
for w in X-Content-Type-Options X-Frame-Options Referrer-Policy Strict-Transport-Security X-Robots-Tag; do
  printf '%s' "$H" | grep -qi "^${w}:" && echo "  header ok: $w" || nf "missing header $w"
done
printf '%s' "$H" | grep -qi '^x-powered-by:' && nf "X-Powered-By present" || echo "  no X-Powered-By"
[ "$FAILS" = 0 ] || die "$FAILS endpoint/header check(s) failed"

STAGE=pre
trap - ERR
echo
echo "==================== CUTOVER STEPS 3–16: OK ===================="
docker ps --format '  {{.Names}}  {{.Image}}  {{.Status}}' | grep -E 'titanor-time-prod' || true
cat <<EOF

  new prod: $PROD_WEB + $PROD_SCHED on $RELEASE_IMAGE, DB $PROD_DB ($EXPECT_MIGRATIONS migrations)
  old prod: $OLD_WEB / $OLD_SCHED / $OLD_DB — STOPPED, kept for rollback (do NOT remove until R15 done)
  pilot:    $PILOT_WEB / $PILOT_SCHED — STOPPED (frozen). $PILOT_DB left up for reference.
  backups:  old-prod  $OP_BK
            pilot     $SNAP

  NEXT (owner, with sudo) — runbook step 17:
     sudo bash $REPO/ops/titanor-time/r14/apply-caddy-r14.sh
  THEN step 18 (Employee-login link + /fi lang):
     bash $REPO/ops/site/deploy-site-r14.sh
  Owner smoke on http://127.0.0.1:${PROD_PORT} (SSH tunnel) BEFORE step 17 is recommended.

  ROLLBACK (if anything looks wrong):
     bash $REPO/ops/titanor-time/r14/rollback-r14.sh
EOF
