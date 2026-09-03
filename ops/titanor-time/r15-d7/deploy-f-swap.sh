#!/usr/bin/env bash
# R15-D7 Deploy F — «Часы заказчику». Web-only swap of the production app container.
#
#   d7e-5cce319  ->  d7f-18c2091   (NO migration — schema stays 100)
#
# Prereqs already done by the assistant (2026-09-03):
#   - image titanor-time-app:d7f-18c2091 built from HEAD 18c2091 (runtime identical to the
#     fully-tested d7f-f6922cf — only the report .md differs, and docs/ is not in the image)
#   - backup production-20260903T175352Z-pre-deploy (on+off-box), restore-test 13/13 PASS
#   - candidate d7f-18c2091 booted on :3198 against the REAL prod DB: /api/ready 200 current
#     100/100, healthy, clean logs; /login 200, /reset-password 200, /admin/reports/customer 307,
#     scope API 401, bad-creds login 401
#
# This script ONLY swaps the web container. It does NOT touch: the DB / schema, the scheduler
# (titanor-time-prod-scheduler on r14-release-1416503), Caddy, DNS, passwords, the public site.
# NO production write-smoke.
#
# Rollback: ops/titanor-time/r15-d7/deploy-f-rollback.sh  (revert to image d7e-5cce319)

set -uo pipefail

NEW=titanor-time-app:d7f-18c2091
PRE=titanor-time-prod-app-pre-18c2091
ENVFILE=/home/deploy/app-data/titanor-time-prod/app.env
UPLOADS=/home/deploy/app-data/titanor-time-prod/uploads
NET=titanor-time-prod-net
HC="node -e \"fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))\""

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
docker stop -t 30 titanor-time-prod-app
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

for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:3199/api/ready)
  [ "$code" = 200 ] && { echo "READY 200 $(date -u +%FT%T.%3NZ)  (~${i}s)"; break; }
  sleep 1
done

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
