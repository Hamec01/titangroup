#!/usr/bin/env bash
# R14 — manual rollback of the production cutover (runbook §5).
# cutover-r14.sh calls this logic automatically on any failure; run it by hand if the app
# looks wrong after a "successful" cutover.
#
# No sudo. Does NOT touch Caddy — if step 17 already switched Caddy to :3199, run separately:
#     sudo bash ops/titanor-time/r14/apply-caddy-r14.sh --rollback
#
# The old prod DB was only read (pg_dump) during cutover — nothing to restore. This just brings
# the old prod stack and the pilot back up and removes the new prod web/scheduler.
set -uo pipefail

PROD_WEB=titanor-time-prod-app
PROD_SCHED=titanor-time-prod-scheduler
PROD_DB=titanor-time-prod-db
PROD_DB_VOL=titanor-time-prod-db-data
PROD_NET=titanor-time-prod-net
OLD_WEB=titanor-time-app-1
OLD_SCHED=titanor-time-scheduler-1
OLD_DB=titanor-time-db-1
PILOT_WEB=t97-pilot-app
PILOT_SCHED=t97-pilot-scheduler
REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation

echo "== R14 ROLLBACK =="
echo
echo ">> removing the new prod web + scheduler (keeping $PROD_DB + volume $PROD_DB_VOL for inspection)"
docker rm -f "$PROD_WEB" "$PROD_SCHED" 2>/dev/null && echo "   removed" || echo "   (already gone)"

echo ">> restarting old prod DB"
docker start "$OLD_DB" 2>/dev/null || echo "   !! start $OLD_DB by hand"
for _ in $(seq 1 30); do [ "$(docker inspect "$OLD_DB" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break; sleep 1; done

echo ">> restarting old prod web + scheduler"
docker start "$OLD_WEB" "$OLD_SCHED" 2>/dev/null || echo "   !! start $OLD_WEB / $OLD_SCHED by hand"

echo ">> restarting the pilot"
docker start "$PILOT_WEB" "$PILOT_SCHED" 2>/dev/null || echo "   !! start pilot by hand"

echo
echo ">> waiting for old prod /api/ready on 127.0.0.1:3200 (up to 90s)"
ok=0
for _ in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3200/api/ready || echo 000)
  [ "$c" = 200 ] && { ok=1; break; }
  sleep 3
done
[ "$ok" = 1 ] && echo "   old prod /api/ready 200" || echo "   !! old prod not answering 200 on :3200 — check docker logs $OLD_WEB"

echo ">> pilot /api/ready on 127.0.0.1:3297"
curl -s -o /dev/null -w '   :3297 -> %{http_code}\n' --max-time 5 http://127.0.0.1:3297/api/ready || echo "   pilot not answering"

echo
docker ps --format '  {{.Names}}  {{.Image}}  {{.Status}}' | grep -E 'titanor-time|t97-pilot' || true
cat <<EOF

  Rolled back. app.titanorgroup.fi:
    - if Caddy was NOT switched (still 503 holding): nothing to do.
    - if step 17 already ran: sudo bash $REPO/ops/titanor-time/r14/apply-caddy-r14.sh --rollback

  The new prod DB container $PROD_DB (+ volume $PROD_DB_VOL) is kept for inspection.
  Once the cause is understood and you don't need it:
    docker rm -f $PROD_DB && docker volume rm $PROD_DB_VOL && docker network rm $PROD_NET
EOF
