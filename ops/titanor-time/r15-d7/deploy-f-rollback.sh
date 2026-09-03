#!/usr/bin/env bash
# R15-D7 Deploy F — rollback. Reverts the production web container to the pre-swap image
# (d7e-5cce319, Deploy E). Image revert ONLY — there was NO migration, so the schema (100)
# is NOT touched. Scheduler / Caddy / DNS / passwords / public site are NOT touched.
#
# Safe to run any time after deploy-f-swap.sh while titanor-time-prod-app-pre-d216482 still exists.

set -euo pipefail

PRE=titanor-time-prod-app-pre-d216482

docker inspect "$PRE" >/dev/null 2>&1 || { echo "ABORT: $PRE not found — nothing to roll back to"; exit 1; }
pre_img=$(docker inspect "$PRE" --format '{{.Config.Image}}')
[ "$pre_img" = "titanor-time-app:d7e-5cce319" ] || { echo "ABORT: $PRE is on '$pre_img', expected titanor-time-app:d7e-5cce319"; exit 1; }

echo "T0 $(date -u +%FT%T.%3NZ)  rolling back to $pre_img"
docker stop -t 30 titanor-time-prod-app
docker rename titanor-time-prod-app "titanor-time-prod-app-failed-d7f-$(date -u +%Y%m%dT%H%M%SZ)"
docker rename "$PRE" titanor-time-prod-app
docker start titanor-time-prod-app

ready=0
for i in $(seq 1 40); do
  # `|| true` is load-bearing under `set -e` — see deploy-f-swap.sh.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:3199/api/ready || true)
  if [ "$code" = 200 ]; then
    echo "READY 200 $(date -u +%FT%T.%3NZ)  (~${i}s)"
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "ABORT: rollback container did not become ready within 40 seconds" >&2; exit 1; }
echo "--- /api/ready ---"; curl -s http://127.0.0.1:3199/api/ready; echo
echo "--- running image ---"; docker inspect titanor-time-prod-app --format '{{.Config.Image}}'
echo "(the failed d7f container is kept as titanor-time-prod-app-failed-d7f-* for inspection — remove by hand once done)"
