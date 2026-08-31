#!/usr/bin/env bash
# Titanor Time — Worker Dossier browser QA (the stock lane can't seed its fixed fixture).
#
#   IMAGE=titanor-time-app:t97-pilot-<sha> \
#   PILOT_ENV=/home/deploy/app-data/t97-pilot/app.env \
#   ops/titanor-time/run-worker-dossier-qa.sh
#
#   1. disposable PG16 + release-image app container
#   2. run scripts/_qa-seed-worker-dossier.ts  -> employee QA-0001, qa_admin / qa_worker, photos,
#      HETU/contact/address, two qualification cards
#   3. run scripts/_test-worker-dossier-browser-qa.ts against it
# Nothing touches pilot or production.
set -uo pipefail

IMAGE="${IMAGE:?set IMAGE to a built release image, e.g. titanor-time-app:t97-pilot-<sha>}"
PILOT_ENV="${PILOT_ENV:-/home/deploy/app-data/t97-pilot/app.env}"
REPO="${REPO:-/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation}"
APP="$REPO/titanor-time-app"
NET=tt-wd-net
DBC=tt-wd-db
APPC=tt-wd-app
DBPORT="${DBPORT:-55462}"
APPPORT="${APPPORT:-3931}"
WORK="$(mktemp -d /tmp/tt-wd.XXXXXX)"

docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not found" >&2; exit 1; }
[ -r "$PILOT_ENV" ] || { echo "$PILOT_ENV not readable" >&2; exit 1; }
[ -d "$APP/node_modules/playwright" ] || { echo "playwright not installed" >&2; exit 1; }

PGUSER=$(grep -oE '^POSTGRES_USER=.*' "$PILOT_ENV" | cut -d= -f2-)
PGPASS=$(grep -oE '^POSTGRES_PASSWORD=.*' "$PILOT_ENV" | cut -d= -f2-)
PGDB=$(grep -oE '^POSTGRES_DB=.*' "$PILOT_ENV" | cut -d= -f2-)
: "${PGUSER:?}" "${PGPASS:?}" "${PGDB:?}"
for k in IDEMPOTENCY_ENCRYPTION_KEY ACTIVATION_TOKEN_HMAC_KEY PERSONAL_DATA_ENCRYPTION_KEY PASSWORD_RESET_TOKEN_HMAC_KEY GPS_ARCHIVE_ENCRYPTION_KEY; do
  v=$(grep -oE "^${k}=.*" "$PILOT_ENV" | cut -d= -f2-); [ -n "$v" ] && export "$k=$v"
done

cleanup() { docker rm -f "$APPC" "$DBC" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT

echo "== worker dossier QA =="; echo "   image: $IMAGE"; echo

docker network create "$NET" >/dev/null
docker run -d --name "$DBC" --network "$NET" -p "127.0.0.1:${DBPORT}:5432" \
  -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" \
  --health-cmd "pg_isready -U $PGUSER -d $PGDB" --health-interval 3s --health-retries 20 postgres:16 >/dev/null
for _ in $(seq 1 40); do [ "$(docker inspect "$DBC" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break; sleep 2; done
sleep 2

BASE_ENV="$WORK/app.env"
sed "s#@[a-zA-Z0-9_.-]*:5432#@${DBC}:5432#g" "$PILOT_ENV" > "$BASE_ENV"
grep -q "@${DBC}:" "$BASE_ENV" || { echo "could not rewrite DATABASE_URL host" >&2; exit 1; }

docker run --rm --network "$NET" --env-file "$BASE_ENV" -w /app --entrypoint node "$IMAGE" \
  .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma >/dev/null 2>&1 \
  || { echo "migrate deploy failed" >&2; exit 1; }

# Pre-create the uploads bind dir as this user so both the host seed and the container (image
# runs as `node`, UID 1000 == this user) can write into it — otherwise Docker makes it root-owned.
mkdir -p "${WORK}/uploads/employees"
chmod -R 777 "${WORK}/uploads"
docker run -d --name "$APPC" --network "$NET" -p "127.0.0.1:${APPPORT}:3000" \
  -v "${WORK}/uploads:/app/uploads" --env-file "$BASE_ENV" "$IMAGE" >/dev/null
ready=0
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:${APPPORT}/api/ready")" = 200 ] && { ready=1; break; }; sleep 2
done
[ "$ready" = 1 ] || { echo "app never ready" >&2; docker logs "$APPC" 2>&1 | tail -20; exit 1; }
echo "app ready on :${APPPORT}"

DBURL="postgresql://${PGUSER}:${PGPASS}@127.0.0.1:${DBPORT}/${PGDB}"
# The seed writes qualification/profile photos via lib/employee-files.ts, whose UPLOAD_ROOT is
# `process.cwd()/uploads/employees` — so it must run from $WORK, which is the container's
# /app/uploads bind mount. The browser test itself only needs $APP as cwd.
seed_node() { ( cd "$WORK" && DATABASE_URL="$DBURL" node "$APP/node_modules/.bin/tsx" --tsconfig "$APP/tsconfig.json" "$APP/scripts/_qa-seed-worker-dossier.ts" ); }
test_node() { ( cd "$APP" && DATABASE_URL="$DBURL" TEST_BASE_URL="http://127.0.0.1:${APPPORT}" npx tsx scripts/_test-worker-dossier-browser-qa.ts ); }

rc=0
echo ">> seed"
seed_node || { echo "seed failed" >&2; exit 1; }
echo ">> test"
test_node || rc=1

echo
[ "$rc" -eq 0 ] && echo "== worker dossier QA PASS ==" || echo "== worker dossier QA FAIL =="
exit "$rc"
