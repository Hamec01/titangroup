#!/usr/bin/env bash
# Titanor Time — R12 production-like rehearsal. Fully disposable: nothing here touches the pilot,
# production, Caddy, DNS or the public site. It reads the pilot only through a backup directory
# produced by backup-titanor-time.sh (itself a read-only pg_dump).
#
# The exhaustive data reconciliation (per-table row counts, all-data fingerprint, structure,
# uploads) is proven separately by:
#   TT_SMOKE=1 TT_SMOKE_IMAGE=<candidate> TT_SMOKE_ENVFILE=<env> \
#     ops/titanor-time/restore-test-titanor-time.sh <snapshot>
# This script does the LIVE-STACK rehearsal on top of that:
#
#   SNAPSHOT=/path/to/pilot-<UTC>-manual  IMAGE=titanor-time-app:r12-candidate-<sha> \
#   PILOT_ENV=/home/deploy/app-data/t97-pilot/app.env  OUT=/path/to/evidence \
#   ops/titanor-time/r12-rehearsal.sh
#
#   1. disposable PG16 <- restore snapshot  --no-owner --no-acl  as owner titanor_time_prod
#   2. `prisma migrate status` against the restored DB (expect: up to date, no pending)
#   3. EXACT release image as web + scheduler against the restored DB
#   4. schema-aware readiness (/api/ready -> schema:current, applied==expected==98)
#   5. scheduler: >=2 healthy heartbeat ticks, healthcheck exit 0, no OVERLAPPING
#   6. session/token revocation: wipe UserSession, prove a stale cookie -> 401 and /login still 200
#   7. rehearsal-env re-backup + full restore-test of THAT backup
#   8. ROLLBACK DRILL: stop new stack, restore into a 2nd DB, boot the previous image, timed
#   9. tear down by exact name; keep $OUT
set -uo pipefail

SNAPSHOT="${SNAPSHOT:?set SNAPSHOT to a backup dir from backup-titanor-time.sh}"
IMAGE="${IMAGE:?set IMAGE to the release candidate image}"
PILOT_ENV="${PILOT_ENV:-/home/deploy/app-data/t97-pilot/app.env}"
REPO="${REPO:-/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation}"
PREV_IMAGE="${PREV_IMAGE:-titanor-time-app:t97-pilot-edd950c}"
OUT="${OUT:-$(mktemp -d /tmp/tt-r12.XXXXXX)}"; mkdir -p "$OUT"

SUF="r12-$(date -u +%Y%m%dT%H%M%SZ)-$$"
NET="tt-${SUF}-net"; DBC="tt-${SUF}-db"; WEBC="tt-${SUF}-web"; SCHEDC="tt-${SUF}-sched"
RB_DBC="tt-${SUF}-rbdb"; RB_WEBC="tt-${SUF}-rbweb"
WORK="$(mktemp -d /tmp/tt-${SUF}-work.XXXXXX)"; WEBPORT=4390
TARGET_ROLE=titanor_time_prod; TARGET_DB=titanor_time
TARGET_PW="$(head -c18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

t0() { date +%s.%N; }
took() { awk "BEGIN{printf \"%.1f\", $2-$1}"; }
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $*"; }

cleanup() {
  docker rm -f "$WEBC" "$SCHEDC" "$RB_WEBC" "$DBC" "$RB_DBC" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -r "$SNAPSHOT/db.dump" ] || { echo "no db.dump in $SNAPSHOT" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "image $IMAGE not found" >&2; exit 1; }

KEYS=()
for k in IDEMPOTENCY_ENCRYPTION_KEY ACTIVATION_TOKEN_HMAC_KEY PERSONAL_DATA_ENCRYPTION_KEY PASSWORD_RESET_TOKEN_HMAC_KEY GPS_ARCHIVE_ENCRYPTION_KEY; do
  v=$(grep -oE "^${k}=.*" "$PILOT_ENV" | cut -d= -f2-); [ -n "$v" ] && KEYS+=(-e "${k}=${v}")
done

: > "$OUT/timings.txt"
exec > >(tee "$OUT/rehearsal.log") 2>&1
echo "== R12 production-like rehearsal =="
echo "snapshot: $SNAPSHOT"
echo "image:    $IMAGE  digest=$(docker image inspect "$IMAGE" --format '{{.Id}}')"
echo "prev img: $PREV_IMAGE  digest=$(docker image inspect "$PREV_IMAGE" --format '{{.Id}}' 2>/dev/null || echo missing)"
echo "target:   db=$TARGET_DB owner=$TARGET_ROLE (NOT the pilot's t97_app)"
echo "date:     $(date -u +%FT%TZ)"
echo

docker network create "$NET" >/dev/null

# ---- 1. restore ----
S=$(t0)
docker run -d --name "$DBC" --network "$NET" \
  -e POSTGRES_DB="$TARGET_DB" -e POSTGRES_USER="$TARGET_ROLE" -e POSTGRES_PASSWORD="$TARGET_PW" \
  --health-cmd "pg_isready -U $TARGET_ROLE -d $TARGET_DB" --health-interval 2s --health-retries 30 postgres:16 >/dev/null
for _ in $(seq 1 60); do [ "$(docker inspect "$DBC" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break; sleep 1; done
if docker run --rm -v "${SNAPSHOT}:/b:ro" --network "$NET" -e PGPASSWORD="$TARGET_PW" postgres:16 \
     pg_restore --no-owner --no-acl --exit-on-error -h "$DBC" -U "$TARGET_ROLE" -d "$TARGET_DB" /b/db.dump 2>"$WORK/restore.err"; then
  ok "pg_restore --no-owner --no-acl into ${TARGET_DB} (owner ${TARGET_ROLE})"
else
  bad "pg_restore failed"; sed 's/^/    /' "$WORK/restore.err" | head
fi
echo "restore_db            $(took $S $(t0))s" >> "$OUT/timings.txt"
RESTORED_URL="postgresql://${TARGET_ROLE}:${TARGET_PW}@${DBC}:5432/${TARGET_DB}"
q() { docker exec "$DBC" psql -U "$TARGET_ROLE" -d "$TARGET_DB" -tAc "$1"; }

# ---- 1b. clear the carried-over scheduler lease ----
# The pilot snapshot carries a live SchedulerLease (90-min TTL, no expiresAt column — expiry is
# renewedAt + TTL). A new scheduler pointed at the restored DB would sit OVERLAPPING for up to
# ~90 min. Cutover must clear it right after restore (runbook step 11). Safe: the new scheduler
# acquires a fresh lease immediately.
LEASE_BEFORE="$(q "select coalesce(count(*),0) from \"SchedulerLease\"")"
q "delete from \"SchedulerLease\"" >/dev/null 2>&1 || true
LEASE_AFTER="$(q "select count(*) from \"SchedulerLease\"")"
[ "${LEASE_AFTER:-1}" = 0 ] && ok "cleared carried-over SchedulerLease (${LEASE_BEFORE} row -> 0)" || bad "SchedulerLease not cleared: ${LEASE_AFTER}"

MANI_ROWS="$(awk -F= '/^public_row_total/{gsub(/ /,"",$2);print $2}' "$SNAPSHOT/manifest.txt")"
GOT_ROWS="$(q "select coalesce(sum(c),0) from (select count(*) c from \"User\" union all select count(*) from \"Employee\" union all select count(*) from \"ClockEvent\" union all select count(*) from \"TimesheetVersion\") x")"
echo "  (spot rows User+Employee+ClockEvent+TimesheetVersion in restore: ${GOT_ROWS}; snapshot public_row_total=${MANI_ROWS})"

# ---- 2. migrate status ----
MST="$(docker run --rm --network "$NET" -e DATABASE_URL="$RESTORED_URL" -w /app --entrypoint node "$IMAGE" \
  .prisma-tools/node_modules/prisma/build/index.js migrate status --schema prisma/schema.prisma 2>&1 || true)"
if echo "$MST" | grep -qiE "Database schema is up to date|No pending migrations"; then
  ok "migrate status: up to date, no pending migrations"
else
  bad "migrate status not clean"; echo "$MST" | sed 's/^/    /' | tail -6
fi

# ---- 3+4. web + scheduler + readiness ----
S=$(t0)
docker run -d --name "$WEBC" --network "$NET" -p "127.0.0.1:${WEBPORT}:3000" \
  -e DATABASE_URL="$RESTORED_URL" -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 -e NEXT_TELEMETRY_DISABLED=1 \
  -e ATTENDANCE_SCHEDULER_HEARTBEAT_PATH=/tmp/hb.json "${KEYS[@]}" -v "${WORK}/uploads:/app/uploads" "$IMAGE" >/dev/null
docker run -d --name "$SCHEDC" --network "$NET" \
  -e DATABASE_URL="$RESTORED_URL" -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 \
  -e ATTENDANCE_SCHEDULER_HEARTBEAT_PATH=/tmp/hb.json "${KEYS[@]}" \
  "$IMAGE" node .runtime/attendance-auto-submit-scheduler.cjs >/dev/null
READY=""
for _ in $(seq 1 45); do READY="$(curl -s --max-time 4 "http://127.0.0.1:${WEBPORT}/api/ready" || true)"; echo "$READY" | grep -q '"schema":"current"' && break; sleep 2; done
echo "web_ready             $(took $S $(t0))s" >> "$OUT/timings.txt"
echo "$READY" | grep -q '"schema":"current"' && ok "web /api/ready -> schema:current" || bad "web not ready: ${READY:-<none>}"
echo "$READY" | grep -qE '"applied":98[^0-9].*"expected":98' && ok "readiness: 98/98 migrations, aheadBy 0" || bad "readiness migration count: $READY"

# ---- 5. scheduler heartbeat ----
S=$(t0); TICKS=0; HB=""
for _ in $(seq 1 40); do
  HB="$(docker exec "$SCHEDC" cat /tmp/hb.json 2>/dev/null || echo '')"
  echo "$HB" | grep -q 'OVERLAPPING' && { bad "scheduler heartbeat shows OVERLAPPING"; break; }
  TICKS="$(printf '%s' "$HB" | grep -oE '"consecutiveOk":[0-9]+|"tickCount":[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)"
  [ -n "${TICKS:-}" ] && [ "$TICKS" -ge 2 ] && break
  sleep 5
done
echo "sched_2ticks          $(took $S $(t0))s" >> "$OUT/timings.txt"
if docker exec "$SCHEDC" node .runtime/attendance-scheduler-healthcheck.cjs >/dev/null 2>&1; then
  ok "scheduler healthcheck exit 0 (heartbeat: $(printf '%s' "$HB" | tr -d '\n ' | cut -c1-160))"
else
  bad "scheduler healthcheck non-zero (heartbeat: ${HB:-<none>})"
fi

# ---- 6. session/token revocation ----
BEFORE="$(q 'select count(*) from "UserSession"')"
q 'delete from "UserSession"' >/dev/null
AFTER="$(q 'select count(*) from "UserSession"')"
C401="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 -H 'Cookie: tt_session=deadbeefdeadbeef' "http://127.0.0.1:${WEBPORT}/api/me/sessions")"
CLOGIN="$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://127.0.0.1:${WEBPORT}/login")"
{ [ "$AFTER" = 0 ] && [ "$C401" = 401 ] && [ "$CLOGIN" = 200 ]; } \
  && ok "revoked all ${BEFORE} sessions; stale cookie -> 401, /login still 200" \
  || bad "session revocation: after=${AFTER} authed-endpoint=${C401} login=${CLOGIN}"

# ---- 7. rehearsal-env re-backup + restore-test ----
S=$(t0)
if TT_BACKUP_ROOT="$OUT/rehearsal-backup" TT_MIRROR_ROOT="" TT_ENV=rehearsal \
   TT_DB_CONTAINER="$DBC" TT_DB_USER="$TARGET_ROLE" TT_DB_NAME="$TARGET_DB" \
   TT_UPLOADS_DIR="$WORK/uploads" TT_APP_CONTAINER="$WEBC" \
   bash "$REPO/ops/titanor-time/backup-titanor-time.sh" manual >"$OUT/rehearsal-backup.log" 2>&1; then
  ok "backup taken from the REHEARSAL environment"
  RB="$(ls -d "$OUT"/rehearsal-backup/rehearsal-*-manual 2>/dev/null | head -1)"
  if [ -n "$RB" ] && bash "$REPO/ops/titanor-time/restore-test-titanor-time.sh" "$RB" >"$OUT/rehearsal-restore-test.log" 2>&1; then
    ok "restore-test of the rehearsal backup PASSED"
  else
    bad "restore-test of the rehearsal backup FAILED (see $OUT/rehearsal-restore-test.log)"
  fi
else
  bad "rehearsal backup failed (see $OUT/rehearsal-backup.log)"
fi
echo "rehearsal_backup+test $(took $S $(t0))s" >> "$OUT/timings.txt"

# ---- 8. rollback drill ----
echo "-- rollback drill --"
S=$(t0); docker stop "$SCHEDC" "$WEBC" >/dev/null; echo "rb_stop_new           $(took $S $(t0))s" >> "$OUT/timings.txt"
S=$(t0)
docker run -d --name "$RB_DBC" --network "$NET" \
  -e POSTGRES_DB="$TARGET_DB" -e POSTGRES_USER="$TARGET_ROLE" -e POSTGRES_PASSWORD="$TARGET_PW" \
  --health-cmd "pg_isready -U $TARGET_ROLE -d $TARGET_DB" --health-interval 2s --health-retries 30 postgres:16 >/dev/null
for _ in $(seq 1 60); do [ "$(docker inspect "$RB_DBC" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && break; sleep 1; done
docker run --rm -v "${SNAPSHOT}:/b:ro" --network "$NET" -e PGPASSWORD="$TARGET_PW" postgres:16 \
  pg_restore --no-owner --no-acl --exit-on-error -h "$RB_DBC" -U "$TARGET_ROLE" -d "$TARGET_DB" /b/db.dump >/dev/null 2>&1 \
  && echo "  rollback restore ok" || bad "rollback restore failed"
echo "rb_restore_prev_dump  $(took $S $(t0))s" >> "$OUT/timings.txt"
S=$(t0)
RB_URL="postgresql://${TARGET_ROLE}:${TARGET_PW}@${RB_DBC}:5432/${TARGET_DB}"
docker run -d --name "$RB_WEBC" --network "$NET" -p "127.0.0.1:$((WEBPORT+1)):3000" \
  -e DATABASE_URL="$RB_URL" -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 -e NEXT_TELEMETRY_DISABLED=1 \
  "${KEYS[@]}" "$PREV_IMAGE" >/dev/null
RBREADY=""
for _ in $(seq 1 40); do RBREADY="$(curl -s --max-time 4 "http://127.0.0.1:$((WEBPORT+1))/api/ready" || true)"; echo "$RBREADY" | grep -q '"schema":"current"' && break; sleep 2; done
echo "rb_boot_prev_image    $(took $S $(t0))s" >> "$OUT/timings.txt"
echo "$RBREADY" | grep -q '"schema":"current"' \
  && ok "rollback: previous image boots against the rolled-back DB, schema:current" \
  || bad "rollback boot failed: ${RBREADY:-<none>}"

echo
echo "== R12 rehearsal: ${PASS} passed, ${FAIL} failed =="
echo "-- timings (s) --"; cat "$OUT/timings.txt"
echo "evidence: $OUT"
[ "$FAIL" -eq 0 ]
