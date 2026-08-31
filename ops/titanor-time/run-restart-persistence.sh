#!/usr/bin/env bash
# Titanor Time — T9.5 restart-persistence acceptance (the two-phase test the stock browser lane
# can't drive on its own).
#
#   IMAGE=titanor-time-app:t97-pilot-<sha> \
#   PILOT_ENV=/home/deploy/app-data/t97-pilot/app.env \
#   ops/titanor-time/run-restart-persistence.sh
#
# Sequence, all against a disposable PG16 + a release-image app container (nothing touches pilot,
# production, or the shared network):
#   1. run scripts/_test-t9-full-flow.ts        -> seeds the T9.4 end-to-end fixture into the DB
#      (FINAL_APPROVED timesheet, 2 immutable versions, 420 worked min, real clock rows)
#   2. _test-t9-restart-persistence.ts PHASE=prepare -> snapshots the fixture, writes a 0600 manifest
#   3. docker restart the APP container ONLY (the DB container + its volume stay up)
#   4. _test-t9-restart-persistence.ts PHASE=verify  -> re-snapshots, asserts byte-identical hash +
#      that the restored stack still accepts a real authenticated ADMIN write
#
# _test-t9-restart-persistence.ts intentionally has no fixture builder of its own — it resolves the
# rows _test-t9-full-flow.ts left behind (t94-admin-*, Flowworker*). So step 1 must pass first.
set -uo pipefail

IMAGE="${IMAGE:?set IMAGE to a built release image, e.g. titanor-time-app:t97-pilot-<sha>}"
PILOT_ENV="${PILOT_ENV:-/home/deploy/app-data/t97-pilot/app.env}"
REPO="${REPO:-/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation}"
APP="$REPO/titanor-time-app"
NET=tt-rp-net
DBC=tt-rp-db
APPC=tt-rp-app
DBPORT="${DBPORT:-55461}"
APPPORT="${APPPORT:-39666}"
WORK="$(mktemp -d /tmp/tt-rp.XXXXXX)"
STATE_FILE="$WORK/manifest.json"

docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not found — build it first" >&2; exit 1; }
[ -r "$PILOT_ENV" ] || { echo "$PILOT_ENV not readable" >&2; exit 1; }
[ -d "$APP/node_modules/playwright" ] || { echo "playwright not installed in $APP/node_modules" >&2; exit 1; }

PGUSER=$(grep -oE '^POSTGRES_USER=.*' "$PILOT_ENV" | cut -d= -f2-)
PGPASS=$(grep -oE '^POSTGRES_PASSWORD=.*' "$PILOT_ENV" | cut -d= -f2-)
PGDB=$(grep -oE '^POSTGRES_DB=.*' "$PILOT_ENV" | cut -d= -f2-)
: "${PGUSER:?}" "${PGPASS:?}" "${PGDB:?}"

for k in IDEMPOTENCY_ENCRYPTION_KEY ACTIVATION_TOKEN_HMAC_KEY PERSONAL_DATA_ENCRYPTION_KEY PASSWORD_RESET_TOKEN_HMAC_KEY GPS_ARCHIVE_ENCRYPTION_KEY; do
  v=$(grep -oE "^${k}=.*" "$PILOT_ENV" | cut -d= -f2-)
  [ -n "$v" ] && export "$k=$v"
done

cleanup() {
  docker rm -f "$APPC" "$DBC" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== T9.5 restart persistence =="
echo "   image: $IMAGE"
echo "   date:  $(date -u +%FT%TZ)"
echo

docker network create "$NET" >/dev/null
docker run -d --name "$DBC" --network "$NET" -p "127.0.0.1:${DBPORT}:5432" \
  -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" \
  --health-cmd "pg_isready -U $PGUSER -d $PGDB" --health-interval 3s --health-retries 20 \
  postgres:16 >/dev/null
for _ in $(seq 1 40); do
  [ "$(docker inspect "$DBC" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break; sleep 2
done
sleep 2

BASE_ENV="$WORK/app.env"
sed "s#@[a-zA-Z0-9_.-]*:5432#@${DBC}:5432#g" "$PILOT_ENV" > "$BASE_ENV"
grep -q "@${DBC}:" "$BASE_ENV" || { echo "could not rewrite DATABASE_URL host" >&2; exit 1; }

docker run --rm --network "$NET" --env-file "$BASE_ENV" -w /app --entrypoint node "$IMAGE" \
  .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma >/dev/null 2>&1 \
  || { echo "migrate deploy failed" >&2; exit 1; }
echo "DB migrated"

docker run -d --name "$APPC" --network "$NET" -p "127.0.0.1:${APPPORT}:3000" \
  -v "${WORK}/uploads:/app/uploads" --env-file "$BASE_ENV" "$IMAGE" >/dev/null

wait_ready() {
  for _ in $(seq 1 40); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:${APPPORT}/api/ready")" = 200 ] && return 0
    sleep 2
  done
  return 1
}
wait_ready || { echo "app never became ready" >&2; docker logs "$APPC" 2>&1 | tail -30; exit 1; }
echo "app ready on :${APPPORT}"
echo

DBURL="postgresql://${PGUSER}:${PGPASS}@127.0.0.1:${DBPORT}/${PGDB}"
run_node() { ( cd "$APP" && DATABASE_URL="$DBURL" TEST_BASE_URL="http://127.0.0.1:${APPPORT}" TT_TEST_TIMEOUT_MS="${TT_TEST_TIMEOUT_MS:-600000}" "$@" ); }

rc=0

echo ">> 1/4  _test-t9-full-flow.ts  (seed the T9.4 fixture)"
run_node npx tsx scripts/_test-t9-full-flow.ts | tail -3 || { echo "full-flow failed — cannot seed the restart fixture" >&2; exit 1; }
echo

echo ">> 2/4  _test-t9-restart-persistence.ts  PHASE=prepare"
run_node env TEST_PHASE=prepare TEST_STATE_FILE="$STATE_FILE" npx tsx scripts/_test-t9-restart-persistence.ts | tail -3 || rc=1
[ -s "$STATE_FILE" ] || { echo "prepare did not write $STATE_FILE" >&2; exit 1; }
echo

echo ">> 3/4  docker restart ${APPC}  (DB + volume stay up)"
docker restart "$APPC" >/dev/null
wait_ready || { echo "app did not come back after restart" >&2; exit 1; }
echo "   app healthy again"
echo

echo ">> 4/4  _test-t9-restart-persistence.ts  PHASE=verify"
run_node env TEST_PHASE=verify TEST_STATE_FILE="$STATE_FILE" npx tsx scripts/_test-t9-restart-persistence.ts | tail -4 || rc=1

echo
[ "$rc" -eq 0 ] && echo "== T9.5 restart persistence PASS ==" || echo "== T9.5 restart persistence FAIL =="
exit "$rc"
