#!/usr/bin/env bash
# R14 — read-only preflight (docs/titanor-time/R14_CUTOVER_RUNBOOK_RU.md §2.1).
# Changes nothing. No sudo. Run before every cutover window.
set -uo pipefail

REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
RELEASE_IMAGE="${RELEASE_IMAGE:-titanor-time-app:r14-release-1416503}"
RELEASE_DIGEST="${RELEASE_DIGEST:-sha256:864267bb1698dc43d585fb0a094345766a1eff7afc006d778c42fc7eff5c4bbb}"
PREV_IMAGE="${PREV_IMAGE:-titanor-time-app:t97-pilot-edd950c}"
PROD_ENV="${PROD_ENV:-/home/deploy/app-data/titanor-time-prod/app.env}"
EXPECT_MIGRATIONS=98

P=0; F=0; W=0
ok()   { P=$((P+1)); printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
bad()  { F=$((F+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$*"; }
warn() { W=$((W+1)); printf '  \033[33mTODO\033[0m  %s\n' "$*"; }
# On connection failure curl prints "000" (from -w) AND exits non-zero, so a `|| echo 000`
# form yields "000000". Take curl's output only when curl succeeded; else emit one "000".
hc() { local o; if o=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$@" 2>/dev/null); then printf '%s' "$o"; else printf '000'; fi; }

echo "==================== R14 PREFLIGHT (read-only) ===================="
echo "date: $(date -u +%FT%TZ) / $(TZ=Europe/Helsinki date '+%H:%M %Z')"
echo

echo "-- release artifact --"
ID=$(docker image inspect "$RELEASE_IMAGE" --format '{{.Id}}' 2>/dev/null || echo missing)
[ "$ID" = "$RELEASE_DIGEST" ] && ok "$RELEASE_IMAGE == $RELEASE_DIGEST" || bad "$RELEASE_IMAGE id=$ID (expected $RELEASE_DIGEST)"
REV=$(docker image inspect "$RELEASE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo '')
[ "$REV" = 1416503 ] && ok "revision label = 1416503" || bad "revision label = '$REV'"
TARBALL=/home/deploy/backups/titanor-time-prod-release/titanor-time-app-r14-release-1416503.tar.gz
[ -f "$TARBALL" ] && ( cd "$(dirname "$TARBALL")" && sha256sum --quiet -c "$(basename "$TARBALL").sha256" ) \
  && ok "off-disk release tarball checksum OK" || bad "off-disk release tarball missing/bad"
docker image inspect "$PREV_IMAGE" >/dev/null 2>&1 && ok "rollback image $PREV_IMAGE present" || bad "rollback image $PREV_IMAGE MISSING"

echo
echo "-- ports (all must be loopback / 3199 free) --"
[ "$(hc http://127.0.0.1:3199/api/ready)" = 000 ] && ok "127.0.0.1:3199 free" || bad "something already on :3199"
ss -ltn 2>/dev/null | grep -qE '0\.0\.0\.0:3199|\[::\]:3199' && bad "3199 bound on a public interface" || ok "3199 not publicly bound"
for p in 3200 3297 3100 2019; do
  ss -ltn 2>/dev/null | grep -qE "127\.0\.0\.1:$p\b" && ok "port $p is loopback-only" || warn "port $p not seen as loopback (check manually)"
done

echo
echo "-- old prod stack (to be stopped + backed up) --"
for c in titanor-time-app-1 titanor-time-db-1; do
  [ "$(docker inspect "$c" --format '{{.State.Running}}' 2>/dev/null)" = true ] && ok "$c running" || bad "$c not running"
done
S=$(docker inspect titanor-time-scheduler-1 --format '{{.State.Running}}' 2>/dev/null || echo false)
[ "$S" = true ] && ok "titanor-time-scheduler-1 running (unhealthy is fine — R14 replaces it)" || warn "titanor-time-scheduler-1 not running"
OPDB=$(docker exec titanor-time-db-1 psql -U titanor_time_app -d titanor_time -tAc "SELECT pg_size_pretty(pg_database_size('titanor_time'))" 2>/dev/null || echo '?')
ok "old prod DB size: $OPDB"

echo
echo "-- pilot (data source) --"
PR=$(hc http://127.0.0.1:3297/api/ready)
[ "$PR" = 200 ] && ok "pilot /api/ready 200" || bad "pilot /api/ready $PR"
PB=$(curl -s --max-time 8 http://127.0.0.1:3297/api/ready || echo '')
echo "$PB" | grep -Eq "\"applied\":${EXPECT_MIGRATIONS}[^0-9].*\"expected\":${EXPECT_MIGRATIONS}[^0-9]" \
  && ok "pilot schema current, $EXPECT_MIGRATIONS/$EXPECT_MIGRATIONS" || bad "pilot migration count: $PB"
for c in t97-pilot-app t97-pilot-scheduler t97-pilot-db; do
  [ "$(docker inspect "$c" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] && ok "$c healthy" || bad "$c not healthy"
done
PDB=$(docker exec t97-pilot-db psql -U t97_app -d titanor_time_t97 -tAc "SELECT pg_size_pretty(pg_database_size('titanor_time_t97'))" 2>/dev/null || echo '?')
ok "pilot DB size: $PDB"

echo
echo "-- new prod stack must NOT exist yet --"
for x in titanor-time-prod-net; do docker network inspect "$x" >/dev/null 2>&1 && bad "network $x already exists" || ok "network $x absent"; done
for x in titanor-time-prod-db titanor-time-prod-app titanor-time-prod-scheduler; do docker inspect "$x" >/dev/null 2>&1 && bad "container $x already exists" || ok "container $x absent"; done
docker volume inspect titanor-time-prod-db-data >/dev/null 2>&1 && warn "volume titanor-time-prod-db-data already exists (remove if from a failed attempt)" || ok "volume titanor-time-prod-db-data absent"

echo
echo "-- prod env file (§2.2 — owner prepares) --"
if [ -r "$PROD_ENV" ]; then
  MISS=""
  for k in DATABASE_URL POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB ACTIVATION_TOKEN_HMAC_KEY \
           GPS_ARCHIVE_ENCRYPTION_KEY IDEMPOTENCY_ENCRYPTION_KEY PASSWORD_RESET_TOKEN_HMAC_KEY \
           PERSONAL_DATA_ENCRYPTION_KEY NODE_ENV PORT HOSTNAME NEXT_TELEMETRY_DISABLED; do
    grep -qE "^${k}=" "$PROD_ENV" || MISS="$MISS $k"
  done
  [ -z "$MISS" ] && ok "$PROD_ENV has all 13 keys" || bad "$PROD_ENV missing:$MISS"
  grep -qE '^TITANOR_TRUSTED_PROXY_HOPS=' "$PROD_ENV" && bad "TITANOR_TRUSTED_PROXY_HOPS is set (must NOT be — Variant A)" || ok "no TITANOR_TRUSTED_PROXY_HOPS"
else
  warn "$PROD_ENV not present yet — owner creates it before the window (13 keys, crypto keys copied from pilot app.env)"
fi

echo
echo "-- host headroom --"
DISK=$(df -P / | awk 'NR==2{print $5" used, "$4" free"}')
ok "disk /: $DISK"
MEM=$(free -m | awk '/^Mem:/{print $7" MiB available"}')
ok "memory: $MEM"

echo
echo "-- Caddy / public endpoints (read-only) --"
systemctl is-active --quiet caddy 2>/dev/null && ok "caddy.service active" || warn "cannot read caddy.service state without privileges — owner confirms 'systemctl is-active caddy'"
AH=$(hc https://app.titanorgroup.fi/)
[ "$AH" = 503 ] && ok "app.titanorgroup.fi = 503 holding" || bad "app.titanorgroup.fi = $AH (expected 503)"
TH=$(hc https://titanorgroup.fi/)
[ "$TH" = 307 ] || [ "$TH" = 200 ] && ok "titanorgroup.fi = $TH" || bad "titanorgroup.fi = $TH"
[ -r "$REPO/ops/titanor-time/r14/caddy-app-block-r14.txt" ] && ok "R14 caddy block present" || bad "R14 caddy block missing"
[ -x "$REPO/ops/titanor-time/r14/apply-caddy-r14.sh" ] && ok "apply-caddy-r14.sh present +x" || warn "apply-caddy-r14.sh not executable"

echo
echo "-- git --"
cd "$REPO"
git fetch origin -q 2>/dev/null || true
LOCAL=$(git rev-parse HEAD); ORIGIN=$(git rev-parse origin/feature/titanor-time-foundation 2>/dev/null || echo '?')
[ "$LOCAL" = "$ORIGIN" ] && ok "branch in sync with origin ($LOCAL)" || warn "local $LOCAL vs origin $ORIGIN — push/pull before the window"
[ -z "$(git status --porcelain)" ] && ok "worktree clean" || warn "worktree dirty"

echo
echo "==================== $P PASS · $F FAIL · $W TODO ===================="
if [ "$F" -eq 0 ]; then
  echo "Non-sudo preflight: READY. Remaining TODO items above need the owner / sudo (§2.2)."
  echo "Owner still to confirm: (1) maintenance window, (2) explicit cutover permission."
  exit 0
else
  echo "NOT READY — resolve the FAIL lines above."
  exit 1
fi
