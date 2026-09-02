#!/usr/bin/env bash
# Titanor Time — browser-lane acceptance run with PER-TEST isolation.
#
# The stock `node scripts/run-tests.mjs browser` shares ONE server + DB across all browser tests,
# so fixture bootstrap (bootstrapSuperAdmin) collides and aggregate-report assertions see other
# tests' rows. This script gives each test its own fresh DB (clone of a migrated template) and its
# own app container built from a release image, then runs the one test against it.
#
#   IMAGE=titanor-time-app:t97-pilot-<sha> \
#   PILOT_ENV=/home/deploy/app-data/t97-pilot/app.env \
#   ops/titanor-time/run-browser-acceptance.sh [test-file ...]
#
# With no test-file args, runs every `lane: "browser"` test from scripts/test-manifest.json that
# this harness can drive on its own (see SKIP below). Nothing touches pilot or production — only
# the pilot ENV file is read (for the crypto keys + pg credentials) and a disposable PG16 + app
# containers are created and destroyed. Requires: docker, a release IMAGE already built, Playwright
# + Chromium installed in titanor-time-app/node_modules (dev dep).
set -uo pipefail

IMAGE="${IMAGE:?set IMAGE to a built release image, e.g. titanor-time-app:t97-pilot-<sha>}"
PILOT_ENV="${PILOT_ENV:-/home/deploy/app-data/t97-pilot/app.env}"
REPO="${REPO:-/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation}"
APP="$REPO/titanor-time-app"
NET=tt-bacc-net
DBC=tt-bacc-db
DBPORT="${DBPORT:-55460}"
BASEPORT="${BASEPORT:-4300}"
WORK="$(mktemp -d /tmp/tt-bacc.XXXXXX)"

# These have their own dedicated runners because the per-test isolation here can't provide what
# they need — SKIP-HARNESS here, run them separately:
#   _test-t9-restart-persistence.ts  -> ops/titanor-time/run-restart-persistence.sh  (two-phase:
#                                       seed via _test-t9-full-flow, prepare, docker restart, verify)
#   _test-worker-dossier-browser-qa.ts -> ops/titanor-time/run-worker-dossier-qa.sh (needs the
#                                       scripts/_qa-seed-worker-dossier.ts fixture seeded first)
SKIP='_test-t9-restart-persistence.ts _test-worker-dossier-browser-qa.ts'

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
  docker ps -aq --filter "name=tt-bacc-app-" | xargs -r docker rm -f >/dev/null 2>&1
  docker rm -f "$DBC" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  if [ -n "${TT_KEEP_WORK:-}" ]; then echo "   (per-test logs kept in $WORK)"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

if [ "$#" -gt 0 ]; then
  TESTS=("$@")
else
  mapfile -t TESTS < <(node -e '
    const m = require("'"$APP"'/scripts/test-manifest.json");
    for (const t of m.tests) if (t.lane === "browser") console.log(t.file);
  ')
fi

echo "== browser acceptance =="
echo "   image:    $IMAGE"
echo "   tests:    ${#TESTS[@]}"
echo "   date:     $(date -u +%FT%TZ)"
echo

docker network create "$NET" >/dev/null
docker run -d --name "$DBC" --network "$NET" -p "127.0.0.1:${DBPORT}:5432" \
  -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" \
  --health-cmd "pg_isready -U $PGUSER -d $PGDB" --health-interval 3s --health-retries 20 \
  postgres:16 >/dev/null
for i in $(seq 1 40); do
  [ "$(docker inspect "$DBC" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break; sleep 2
done
ok=0; for i in $(seq 1 30); do
  docker exec "$DBC" psql -U "$PGUSER" -d "$PGDB" -tAc 'SELECT 1' >/dev/null 2>&1 && ok=$((ok+1)) || ok=0
  [ "$ok" -ge 3 ] && break; sleep 2
done
sleep 2

sed "s#@[a-zA-Z0-9_-]*:5432#@${DBC}:5432#; s#@[a-zA-Z0-9_.-]*:5432/#@${DBC}:5432/#" "$PILOT_ENV" > "$WORK/base.env"
grep -q "@${DBC}:" "$WORK/base.env" || { echo "could not rewrite DATABASE_URL host" >&2; exit 1; }

TMPL="tt_bacc_tmpl"
docker exec "$DBC" psql -U "$PGUSER" -d postgres -c "CREATE DATABASE ${TMPL}" >/dev/null
sed "s#/${PGDB}#/${TMPL}#" "$WORK/base.env" > "$WORK/tmpl.env"
docker run --rm --network "$NET" --env-file "$WORK/tmpl.env" -w /app --entrypoint node "$IMAGE" \
  .prisma-tools/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma >/dev/null 2>&1 \
  || { echo "template migrate deploy failed" >&2; exit 1; }
echo "template DB migrated"
echo

pass=0; fail=0; skip=0; n=0
for t in "${TESTS[@]}"; do
  n=$((n+1))
  case " $SKIP " in *" $t "*) echo "  SKIP-HARNESS  $t"; skip=$((skip+1)); continue;; esac
  db="tt_bacc_${n}"; port=$((BASEPORT + n)); cname="tt-bacc-app-${n}"
  docker exec "$DBC" psql -U "$PGUSER" -d postgres -c "CREATE DATABASE ${db} TEMPLATE ${TMPL}" >/dev/null 2>&1
  sed "s#/${PGDB}#/${db}#" "$WORK/base.env" > "$WORK/${cname}.env"
  docker run -d --name "$cname" --network "$NET" -p "127.0.0.1:${port}:3000" \
    -v "${WORK}/${cname}-uploads:/app/uploads" --env-file "$WORK/${cname}.env" "$IMAGE" >/dev/null
  ready=0
  for i in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:${port}/api/ready")" = 200 ] && { ready=1; break; }
    sleep 2
  done
  if [ "$ready" != 1 ]; then
    echo "  INFRA-FAIL    $t  (app never ready on :${port})"; fail=$((fail+1))
    docker rm -f "$cname" >/dev/null 2>&1
    docker exec "$DBC" psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" >/dev/null 2>&1
    continue
  fi
  start=$(date +%s)
  ( cd "$APP" && TEST_BASE_URL="http://127.0.0.1:${port}" \
      DATABASE_URL="postgresql://${PGUSER}:${PGPASS}@127.0.0.1:${DBPORT}/${db}" \
      TT_TEST_TIMEOUT_MS="${TT_TEST_TIMEOUT_MS:-420000}" \
      npx tsx "scripts/${t}" ) > "$WORK/${cname}.log" 2>&1
  rc=$?
  dur=$(( $(date +%s) - start ))
  if [ "$rc" = 0 ]; then
    echo "  PASS          $t  ${dur}s  $(grep -oE 'PASS: [0-9]+/[0-9]+|[0-9]+ passed(, [0-9]+ failed)?' "$WORK/${cname}.log" | tail -1)"
    pass=$((pass+1))
  else
    echo "  FAIL          $t  ${dur}s"
    grep -E 'FAIL:|Error|passed, [0-9]+ failed|"fail":' "$WORK/${cname}.log" | head -20 | sed 's/^/      | /'
    fail=$((fail+1))
  fi
  docker rm -f "$cname" >/dev/null 2>&1
  docker exec "$DBC" psql -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" >/dev/null 2>&1
  rm -f "$WORK/${cname}.env"
done

echo
echo "== ${pass} pass / ${fail} fail / ${skip} skip-harness =="
[ "$fail" -eq 0 ]
