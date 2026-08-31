#!/usr/bin/env bash
# R14 — switch app.titanorgroup.fi from the R11 holding-503 to reverse_proxy 127.0.0.1:3199.
#
# Run AS ROOT, ON THE HOST, ONLY at runbook step 17 — i.e. AFTER the new prod stack is up and
# `curl -s 127.0.0.1:3199/api/ready` already returns 200 with "schema":"current".
#
#   sudo bash ops/titanor-time/r14/apply-caddy-r14.sh             # switch to the app + verify
#   sudo bash ops/titanor-time/r14/apply-caddy-r14.sh --rollback  # back to R11 holding-503
#
# Fail-closed: any validate/reload/verify/regression failure restores the pre-switch Caddyfile
# and reloads. NOTHING here touches DNS, the database, the pilot, or the app containers.
#
# INCIDENT 2026-08-31: never `caddy stop|start|run`, never bare `caddy reload`. Reload only via
# `systemctl reload caddy`; fallback is `caddy reload --address 127.0.0.1:2019` (explicit admin
# API). `caddy validate`/`adapt` on a file are safe.
set -Eeuo pipefail

DOMAIN=app.titanorgroup.fi
ADMIN=127.0.0.1:2019
CADDYFILE=/etc/caddy/Caddyfile
UPSTREAM_PORT=3199
REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
BLOCK_R14="$REPO/ops/titanor-time/r14/caddy-app-block-r14.txt"
BLOCK_HOLDING="$REPO/ops/titanor-time/r11/caddy-app-block.txt"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/etc/caddy/Caddyfile.backup-before-r14-${TS}"

VHOSTS=(
  "https://titanorgroup.fi"
  "https://www.titanorgroup.fi"
  "https://collabstudio.run"
  "https://84-247-130-242.sslip.io"
)
FROZEN_PILOT_VHOST="https://t97-dd686bc3d4.84.247.130.242.nip.io/login"

die() { echo "ABORTED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
code_of() { curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || echo 000; }

reload_caddy() {
  if systemctl reload caddy 2>/dev/null; then return 0; fi
  echo "   (systemctl reload failed, trying caddy reload --address $ADMIN)" >&2
  caddy reload --config "$CADDYFILE" --address "$ADMIN"
}
restore() {
  echo ">> restoring $1"
  cp -f "$1" "$CADDYFILE"
  reload_caddy || echo "WARNING: reload after restore failed — run: sudo systemctl reload caddy" >&2
}

# Replace the whole `app.titanorgroup.fi { ... }` block in $CADDYFILE with the file in $1.
swap_block() {
  local newblock="$1" tmp
  tmp="$(mktemp)"
  awk '
    /^app\.titanorgroup\.fi[[:space:]]*\{/ {skip=1}
    skip==0 {print}
    skip==1 && /^\}/ {skip=0; next}
  ' "$CADDYFILE" > "$tmp"
  # drop any trailing blank lines, then append exactly one separator + the new block
  sed -i -e :a -e '/^[[:space:]]*$/{$d;N;ba}' "$tmp"
  { printf '\n'; grep -v '^#' "$newblock"; } >> "$tmp"
  install -m 0644 -o root -g root "$tmp" "$CADDYFILE"
  rm -f "$tmp"
  command -v caddy >/dev/null && caddy fmt --overwrite "$CADDYFILE" >/dev/null 2>&1 || true
}

verify_common() {
  systemctl is-active --quiet caddy || { restore "$BACKUP"; systemctl reload caddy || true; die "caddy not active after reload — backup restored"; }
  echo ">> regression check (other vhosts unchanged)"
  for u in "${VHOSTS[@]}"; do
    c="$(code_of "$u")"
    case "$c" in 000|5??) restore "$BACKUP"; die "$u -> $c after reload — backup restored";; *) printf '   ok  %-50s %s\n' "$u" "$c";; esac
  done
  # The cutover intentionally stops the pilot web at step 6 and keeps its Caddy
  # route in place for later cleanup. Caddy therefore returns 502 for this one
  # vhost both before and after the app.titanorgroup.fi switch.
  c="$(code_of "$FROZEN_PILOT_VHOST")"
  [ "$c" = 502 ] || { restore "$BACKUP"; die "$FROZEN_PILOT_VHOST -> $c (expected 502 for frozen pilot) — backup restored"; }
  printf '   ok  %-50s %s (frozen pilot, expected)\n' "$FROZEN_PILOT_VHOST" "$c"
}

# ---------------------------------------------------------------- rollback mode
if [ "${1:-}" = "--rollback" ]; then
  [ -r "$BLOCK_HOLDING" ] || die "missing $BLOCK_HOLDING"
  cp -f "$CADDYFILE" "/etc/caddy/Caddyfile.backup-before-r14-rollback-${TS}"
  BACKUP="/etc/caddy/Caddyfile.backup-before-r14-rollback-${TS}"
  echo ">> reverting $DOMAIN to R11 holding-503"
  swap_block "$BLOCK_HOLDING"
  caddy validate --config "$CADDYFILE" 2>&1 | tail -1 | grep -q "Valid configuration" \
    || { restore "$BACKUP"; die "caddy validate failed on the holding block — backup restored"; }
  reload_caddy || { restore "$BACKUP"; die "reload failed — backup restored"; }
  sleep 3
  hc="$(code_of "https://$DOMAIN")"
  [ "$hc" = 503 ] || { restore "$BACKUP"; die "$DOMAIN did not return 503 holding after rollback (got $hc) — backup restored"; }
  verify_common
  echo "== ROLLED BACK: $DOMAIN is back on the 503 holding page (backup: $BACKUP) =="
  exit 0
fi

# ---------------------------------------------------------------- apply mode
command -v caddy >/dev/null    || die "caddy not found"
command -v systemctl >/dev/null || die "systemctl not found"
[ -r "$BLOCK_R14" ]  || die "missing $BLOCK_R14"
[ -w "$CADDYFILE" ]  || die "$CADDYFILE not writable"
grep -qE '^app\.titanorgroup\.fi[[:space:]]*\{' "$CADDYFILE" || die "no app.titanorgroup.fi block in $CADDYFILE — apply R11 first"
grep -q 'reverse_proxy 127.0.0.1:3199' "$CADDYFILE" && die "app block already points at :3199 — nothing to do"

systemctl is-active --quiet caddy || die "caddy.service not active — resolve before touching Caddy"

echo ">> upstream check: the new prod app must already answer on 127.0.0.1:${UPSTREAM_PORT}"
RB="$(curl -sS --max-time 8 "http://127.0.0.1:${UPSTREAM_PORT}/api/ready" || true)"
echo "   127.0.0.1:${UPSTREAM_PORT}/api/ready -> ${RB:-<none>}"
echo "$RB" | grep -q '"status":"ready"'    || die "upstream not ready — do NOT switch Caddy yet (runbook steps 13–16 first)"
echo "$RB" | grep -q '"schema":"current"'  || die "upstream schema not current — do NOT switch Caddy"

echo ">> baseline snapshot"
for u in "${VHOSTS[@]}"; do
  c="$(code_of "$u")"
  printf '   %-50s %s\n' "$u" "$c"
  case "$c" in 000|5??) die "$u is already $c BEFORE any change — refusing to touch Caddy";; esac
done
pilot_c="$(code_of "$FROZEN_PILOT_VHOST")"
printf '   %-50s %s (frozen pilot, expected)\n' "$FROZEN_PILOT_VHOST" "$pilot_c"
[ "$pilot_c" = 502 ] || die "$FROZEN_PILOT_VHOST is $pilot_c before change (expected 502 for frozen pilot)"
echo "   https://$DOMAIN (holding) -> $(code_of "https://$DOMAIN")"

echo ">> backup $CADDYFILE -> $BACKUP"
cp -f "$CADDYFILE" "$BACKUP"

echo ">> swapping the app.titanorgroup.fi block -> reverse_proxy 127.0.0.1:${UPSTREAM_PORT}"
swap_block "$BLOCK_R14"
echo "---- new block ----"
awk '/^app\.titanorgroup\.fi[[:space:]]*\{/,/^\}/' "$CADDYFILE" | sed 's/^/   /'
echo "-------------------"

echo ">> caddy validate"
caddy validate --config "$CADDYFILE" 2>&1 | tail -1 | grep -q "Valid configuration" \
  || { restore "$BACKUP"; die "caddy validate failed — backup restored"; }

echo ">> reload caddy (systemd)"
reload_caddy || { restore "$BACKUP"; die "reload failed — backup restored"; }

echo ">> verify $DOMAIN now serves the app (up to 60s)"
ok=0
for _ in $(seq 1 20); do
  c="$(code_of "https://$DOMAIN/api/ready")"
  [ "$c" = 200 ] && { ok=1; break; }
  sleep 3
done
[ "$ok" = 1 ] || { restore "$BACKUP"; die "https://$DOMAIN/api/ready did not become 200 (last $c) — backup restored"; }

RBODY="$(curl -sS --max-time 8 "https://$DOMAIN/api/ready" || true)"
echo "   https://$DOMAIN/api/ready -> $RBODY"
echo "$RBODY" | grep -q '"schema":"current"' || { restore "$BACKUP"; die "external /api/ready schema not current — backup restored"; }
ROOT_C="$(code_of "https://$DOMAIN/")"
echo "   https://$DOMAIN/ -> $ROOT_C"
case "$ROOT_C" in 200|302|303|307) : ;; *) restore "$BACKUP"; die "https://$DOMAIN/ -> $ROOT_C (expected 200 or redirect to /login) — backup restored";; esac
LOGIN_C="$(code_of "https://$DOMAIN/login")"
echo "   https://$DOMAIN/login -> $LOGIN_C"
[ "$LOGIN_C" = 200 ] || { restore "$BACKUP"; die "https://$DOMAIN/login -> $LOGIN_C (expected 200) — backup restored"; }

hdrs="$(curl -sS -D - -o /dev/null --max-time 6 "https://$DOMAIN/login")"
echo "$hdrs" | grep -qi '^strict-transport-security:' || { restore "$BACKUP"; die "HSTS header missing — backup restored"; }
echo "$hdrs" | grep -qi '^x-content-type-options: *nosniff' || { restore "$BACKUP"; die "nosniff header missing — backup restored"; }
echo "$hdrs" | grep -qi '^x-powered-by:' && { restore "$BACKUP"; die "X-Powered-By leaked — backup restored"; }

redir="$(code_of "http://$DOMAIN/login")"
case "$redir" in 200|301|302|307|308) : ;; *) restore "$BACKUP"; die "http://$DOMAIN -> $redir (expected redirect) — backup restored";; esac

verify_common

echo
echo "== R14 Caddy switch OK =="
echo "   $DOMAIN -> reverse_proxy 127.0.0.1:${UPSTREAM_PORT} ; /api/ready 200 schema:current ; /login 200 ; http->https $redir"
echo "   backup  : $BACKUP"
echo "   rollback: sudo bash $0 --rollback"
