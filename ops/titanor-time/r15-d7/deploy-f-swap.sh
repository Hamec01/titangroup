#!/usr/bin/env bash
# R15-D7 Deploy F — «Часы заказчику». Web-only swap of the production app container.
#
#   d7e-5cce319  ->  d7f-d216482   (NO migration — schema stays 100)
#
# History:
#   - 2026-09-03 19:08Z: first swap attempt on image d7f-18c2091 aborted on a script bug
#     (set -e + an unguarded curl in the readiness loop). The restore trap brought d7e-5cce319
#     back; ~11.5s prod blip, no data impact. Fixed here: `... || true` on the loop curl.
#   - Branch then moved to d216482 (readiness take:200 cap removed + regression test). Image
#     rebuilt as d7f-d216482 and re-verified. This script targets that image.
#
# Prereqs (must all be true before running — the guards below check the load-bearing ones):
#   - image titanor-time-app:d7f-d216482 built from HEAD d216482
#   - fresh backup-titanor-time.sh pre-deploy (on+off-box) + restore-test 13/13
#   - candidate d7f-d216482 booted on :3198 against the REAL prod DB: /api/ready 200 current
#     100/100, healthy, clean logs; /login 200, /reset-password 200, /admin/reports/customer 307
#   - db lane (incl. the new readiness test) + _test-customer-report-scope-ui green on d216482
#
# This script ONLY swaps the web container. It does NOT touch: the DB / schema, the scheduler
# (titanor-time-prod-scheduler on r14-release-1416503), Caddy, DNS, passwords, the public site.
# NO production write-smoke.
#
# Rollback: ops/titanor-time/r15-d7/deploy-f-rollback.sh  (revert to image d7e-5cce319)

set -euo pipefail

NEW=titanor-time-app:d7f-d216482
PRE=titanor-time-prod-app-pre-d216482
ENVFILE=/home/deploy/app-data/titanor-time-prod/app.env
UPLOADS=/home/deploy/app-data/titanor-time-prod/uploads
NET=titanor-time-prod-net
HC="node -e \"fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))\""
SWAP_STARTED=0

# Once the old container has been stopped, any failed command or readiness timeout must restore it
# automatically. Keep a failed new container for diagnosis; never leave the production name absent.
restore_on_failure() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "$SWAP_STARTED" -eq 1 ]; then
    echo "ABORT: swap failed; restoring d7e-5cce319"
    if docker inspect "$PRE" >/dev/null 2>&1; then
      if docker inspect titanor-time-prod-app >/dev/null 2>&1; then
        docker stop -t 10 titanor-time-prod-app >/dev/null 2>&1 || true
        docker rename titanor-time-prod-app "titanor-time-prod-app-failed-d7f-$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null 2>&1 || true
      fi
      docker rename "$PRE" titanor-time-prod-app
      docker start titanor-time-prod-app
      echo "RESTORED: titanor-time-app:d7e-5cce319"
    elif docker inspect titanor-time-prod-app >/dev/null 2>&1; then
      docker start titanor-time-prod-app >/dev/null 2>&1 || true
      echo "RESTORED: original container name was never moved"
    else
      echo "CRITICAL: rollback container is unavailable; investigate immediately" >&2
    fi
  fi
  exit "$rc"
}

# ---- guards --------------------------------------------------------------------------------
docker image inspect "$NEW" >/dev/null 2>&1        || { echo "ABORT: image $NEW not found"; exit 1; }
docker inspect "$PRE" >/dev/null 2>&1              && { echo "ABORT: $PRE already exists — resolve a prior attempt first"; exit 1; }
[ -r "$ENVFILE" ]                                  || { echo "ABORT: $ENVFILE not readable"; exit 1; }
cur=$(docker inspect titanor-time-prod-app --format '{{.Config.Image}}' 2>/dev/null || echo none)
[ "$cur" = "titanor-time-app:d7e-5cce319" ]        || { echo "ABORT: titanor-time-prod-app is on '$cur', expected titanor-time-app:d7e-5cce319"; exit 1; }
echo "  ok — prod on d7e-5cce319, no $PRE, image + env present"

echo
echo "== web-only swap =="
echo "T0 stop  $(date -u +%FT%T.%3NZ)"
trap restore_on_failure EXIT
docker stop -t 30 titanor-time-prod-app
SWAP_STARTED=1
echo "stopped  $(date -u +%FT%T.%3NZ)"
docker rename titanor-time-prod-app "$PRE"
docker run -d --name titanor-time-prod-app \
  --network "$NET" \
  -p 127.0.0.1:3199:3000 \
  --env-file "$ENVFILE" \
  -v "${UPLOADS}:/app/uploads" \
  --health-cmd "$HC" --health-interval 15s --health-timeout 5s --health-start-period 40s --health-retries 4 \
  --restart unless-stopped \
  "$NEW" >/dev/null
echo "started  $(date -u +%FT%T.%3NZ)"

ready=0
for i in $(seq 1 40); do
  # `|| true` is load-bearing: under `set -e` a curl that exits non-zero (56/7 while the new
  # container is still starting) would otherwise abort the script and fire the rollback trap on
  # iteration 1 — the loop must be allowed to retry. curl still writes '000' via -w on failure.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:3199/api/ready || true)
  if [ "$code" = 200 ]; then
    echo "READY 200 $(date -u +%FT%T.%3NZ)  (~${i}s)"
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "ABORT: new container did not become ready within 40 seconds" >&2; exit 1; }
trap - EXIT

echo
echo "--- /api/ready (local) ---"; curl -s http://127.0.0.1:3199/api/ready; echo
echo "--- running image ---";      docker inspect titanor-time-prod-app --format '{{.Config.Image}}'
echo "--- rollback container ---"; docker inspect "$PRE" --format '{{.Name}}  {{.Config.Image}}'
echo
echo "Now run the post-swap read-only checks (through Caddy):"
echo "  curl -s https://app.titanorgroup.fi/api/ready"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://app.titanorgroup.fi/login          # 200"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://app.titanorgroup.fi/reset-password  # 200"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://app.titanorgroup.fi/admin/reports/customer  # 307 -> login"
echo "  docker logs titanor-time-prod-app 2>&1 | tail -20     # expect clean"
echo "  docker logs titanor-time-prod-scheduler 2>&1 | tail -5"
