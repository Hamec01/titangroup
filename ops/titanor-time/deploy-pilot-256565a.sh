#!/usr/bin/env bash
# Titanor Time — pilot deploy of R06-B (Docker / runtime optimization). Commit 256565a.
# HARDENED after the R06-B.1 incident (see docs/titanor-time/R06B_DOCKER_RUNTIME_REPORT_RU.md §R06-B.1).
#
# Canonical copy lives in the repo at ops/titanor-time/deploy-pilot-256565a.sh; an identical copy is
# placed at /home/deploy/app-data/t97-pilot/deploy-256565a.sh for the operator to run.
#
# NO schema change (DB stays at 96 migrations). This deploy only swaps the image:
#   titanor-time-app:t97-pilot-d15586c   (1.79 GB, full dev node_modules, `sh -c 'npx tsx …'` scheduler)
#     -> titanor-time-app:t97-pilot-256565a  (792 MB, Next standalone + precompiled CJS bundles
#        + a minimal `prisma` CLI closure; one image, web vs scheduler differ only by command)
#
# What R06-B.1 fixed vs the first version:
#   * every check is fail-closed; HTTP 5xx / 000 fails the deploy;
#   * /api/ready body is asserted (status=ready, schema=current, applied=expected=96);
#   * the scheduler healthcheck exit code is checked directly (no `; echo` masking);
#   * Docker health of BOTH app and scheduler is waited on and asserted;
#   * fresh heartbeat + lastOutcome=ok + consecutiveFailures=0 + lease held & renewed by the NEW
#     scheduler are asserted;
#   * the old `sh -c 'npx tsx …'` scheduler is SIGKILLed on stop (npx swallows SIGTERM) -> its
#     SchedulerLease row is left orphaned with a fresh renewedAt and the new scheduler would sit in
#     OVERLAPPING for the full 90-min TTL. This script detects that and clears ONLY that exact,
#     provably-dead holder's row (name + exact holderId), after verifying the old container is
#     stopped, pid 0, and no other container owns its hostname;
#   * a flock + state guard makes a second run a no-op / hard refusal — it never deletes an
#     existing -pre-<MARK> rollback container;
#   * a failed swap or a failed verification triggers an automatic rollback to $PREV_TAG.
#
#   Run:  bash /home/deploy/app-data/t97-pilot/deploy-256565a.sh
#
set -Eeuo pipefail

IMAGE=titanor-time-app:t97-pilot-256565a
ENVFILE=/home/deploy/app-data/t97-pilot/app.env
REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
NET=t97-pilot-net
DB=t97-pilot-db
DB_USER=t97_app
DB_NAME=titanor_time_t97
APP_PORT=3297
PREV_TAG=t97-pilot-d15586c          # image to roll back to
MARK=256565a                        # rollback-container suffix ("state before deploying <MARK>")
EXPECT_MIGRATIONS=96
PUBLIC_URL=https://t97-dd686bc3d4.84.247.130.242.nip.io
LOCK=/home/deploy/app-data/t97-pilot/.deploy-${MARK}.lock

APP_HEALTHCMD='node -e "fetch(\"http://127.0.0.1:3000/api/ready\").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"'
SCHED_HEALTHCMD='node .runtime/attendance-scheduler-healthcheck.cjs'

SWAP_STARTED=0

die()  { echo "DEPLOY ABORTED: $*" >&2; exit 1; }
psqlq() { docker exec "$DB" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || echo 000; }

wait_health() {  # $1 container  $2 timeout_s  -> 0 if healthy within timeout
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

echo
echo "== 2/8  preflight =="
[ -r "$ENVFILE" ] || die "env file $ENVFILE not readable"
grep -q '^DATABASE_URL=' "$ENVFILE"                  || die "DATABASE_URL missing from $ENVFILE"
grep -q '^PASSWORD_RESET_TOKEN_HMAC_KEY=' "$ENVFILE" || die "PASSWORD_RESET_TOKEN_HMAC_KEY missing from $ENVFILE (run the R03 deploy first)"
docker network inspect "$NET" >/dev/null 2>&1        || die "docker network $NET missing"
wait_health "$DB" 30                                 || die "$DB is not healthy"
[ "$(http_code "http://127.0.0.1:${APP_PORT}/api/ready")" != 000 ] || die "pilot app not reachable on :$APP_PORT before deploy"
echo "  ok"

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
echo "== 4/8  pre-deploy backup (mandatory, fail-closed) =="
TT_BACKUP_ROOT=/home/deploy/backups/titanor-time-pilot \
TT_MIRROR_ROOT=/mnt/250gb/titanor-time-foundation/backups/pilot \
  bash "$REPO/ops/titanor-time/backup-titanor-time.sh" pre-deploy
BK=$(ls -1dt /home/deploy/backups/titanor-time-pilot/pilot-*-pre-deploy 2>/dev/null | head -1)
[ -n "$BK" ] && [ -f "$BK/SHA256SUMS" ] || die "pre-deploy backup did not publish a complete directory"
echo "  latest: $BK"

echo
echo "== 5/8  migrate t97-pilot-db via the baked minimal prisma CLI (fail-closed) =="
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
echo "  migrations: $APPLIED applied, 0 failed"

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
set +e
docker stop -t 30 t97-pilot-scheduler
STOP_RC=$?
set -e
docker rename t97-pilot-scheduler "t97-pilot-scheduler-pre-$MARK"
echo "     old scheduler stop rc=$STOP_RC (137 = SIGKILL: old npx/sh scheduler swallowed SIGTERM)"

# Stale-lease handling — ONLY for the provably-dead old holder.
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
  echo "     no SchedulerLease row (old scheduler released it cleanly, or none yet)"
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

echo "  -- app --"
wait_health t97-pilot-app 150 || note_fail "t97-pilot-app never became healthy"
RC=$(http_code "http://127.0.0.1:${APP_PORT}/api/ready")
BODY=$(curl -s --max-time 10 "http://127.0.0.1:${APP_PORT}/api/ready" || true)
echo "     /api/ready -> $RC  $BODY"
[ "$RC" = 200 ] || note_fail "/api/ready http $RC"
echo "$BODY" | grep -q '"status":"ready"'   || note_fail "/api/ready status != ready"
echo "$BODY" | grep -q '"schema":"current"' || note_fail "/api/ready schema != current"
echo "$BODY" | grep -Eq "\"applied\":${EXPECT_MIGRATIONS}\b"  || note_fail "/api/ready applied != $EXPECT_MIGRATIONS"
echo "$BODY" | grep -Eq "\"expected\":${EXPECT_MIGRATIONS}\b" || note_fail "/api/ready expected != $EXPECT_MIGRATIONS"
HRC=$(http_code "http://127.0.0.1:${APP_PORT}/api/health")
[ "$HRC" = 200 ] || note_fail "/api/health http $HRC"
for p in /login /reset-password; do
  c=$(http_code "http://127.0.0.1:${APP_PORT}$p")
  echo "     $p -> $c"
  case "$c" in 2*|3*) :;; *) note_fail "$p http $c";; esac
done
EXTC=$(http_code "$PUBLIC_URL/login")
echo "     external $PUBLIC_URL/login -> $EXTC (informational; Caddy/DNS not in scope)"
case "$EXTC" in 2*|3*) :;; *) echo "     WARN external login not 2xx/3xx — check Caddy separately, not a deploy failure";; esac
docker exec t97-pilot-app sh -c 'for f in assets/fonts/DejaVuSans.ttf assets/fonts/DejaVuSans-Bold.ttf assets/brand/titanor-group.png; do [ -r "/app/$f" ] || { echo "MISSING $f"; exit 1; }; done' \
  || note_fail "PDF font/brand asset missing in the image"

echo "  -- scheduler --"
# wait for: lease held & renewed by the NEW scheduler + a completed ok tick
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
LH=$(psqlq "SELECT \"holderId\"||'  renewed '||\"renewedAt\" FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler'" || true)
echo "     lease: ${LH:-<none>}"
echo "     heartbeat: $(docker exec t97-pilot-scheduler cat /tmp/attendance-scheduler-heartbeat.json 2>/dev/null || echo '<none>')"
[ "$SCHED_OK" = 1 ] || note_fail "scheduler did not reach {lease held by $NEW_SCHED_HOST, lastOutcome=ok, consecutiveFailures=0} within 300s"
LEASE_AGE=$(psqlq "SELECT extract(epoch FROM now()-\"renewedAt\")::int FROM \"SchedulerLease\" WHERE \"name\"='attendance-scheduler'" || echo 99999)
case "$LEASE_AGE" in ''|*[!0-9]*) LEASE_AGE=99999;; esac
[ "$LEASE_AGE" -lt 180 ] || note_fail "lease renewedAt is stale (${LEASE_AGE}s) — not being renewed"

# real healthcheck exit code — no `; echo` masking
if docker exec t97-pilot-scheduler node .runtime/attendance-scheduler-healthcheck.cjs; then
  echo "     healthcheck exit 0"
else
  note_fail "scheduler healthcheck exit $?"
fi
wait_health t97-pilot-scheduler 180 || note_fail "t97-pilot-scheduler never became healthy"

# all background operations seen since this scheduler started
SLOG=$(docker logs --since "$SCHED_STARTED_AT" t97-pilot-scheduler 2>&1 || true)
for ev in attendance_auto_submit_tick abandoned_shift_auto_close attendance_location_retention timesheet_period_generation; do
  printf '%s' "$SLOG" | grep -q "\"event\":\"$ev\"" && echo "     op ok: $ev" || note_fail "background op not seen since start: $ev"
done
printf '%s' "$SLOG" | grep -q 'SCHEDULER_LEASE_HELD_BY_ANOTHER' && note_fail "scheduler still logging OVERLAPPING after the swap"

echo "  -- DB counters (informational) --"
psqlq "SELECT '     User='||count(*) FROM \"User\"" || true
psqlq "SELECT '     ClockEvent='||count(*) FROM \"ClockEvent\"" || true

if [ "$FAILS" -ne 0 ]; then
  echo
  echo "  $FAILS verification failure(s) — rolling back."
  SWAP_STARTED=0   # stop the ERR trap from double-rolling
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
echo "DEPLOY OK — pilot on $IMAGE."
echo
echo "Post-deploy manual check (recommended): open the pilot UI, download one Customer-hours or"
echo "Custom-report PDF, confirm it opens and worker names render (embedded DejaVu font)."
echo
echo "Manual rollback later (back to $PREV_TAG):"
echo "  docker rm -f t97-pilot-app t97-pilot-scheduler"
echo "  docker rename t97-pilot-app-pre-$MARK t97-pilot-app"
echo "  docker rename t97-pilot-scheduler-pre-$MARK t97-pilot-scheduler"
echo "  docker start t97-pilot-app t97-pilot-scheduler"
echo "  # the -pre-$MARK containers still run $PREV_TAG with the old commands/health-cmds."
