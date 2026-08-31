#!/usr/bin/env bash
# R11 — apply the app.titanorgroup.fi holding vhost to Caddy (Variant A, grey-cloud).
#
# Run AS ROOT, ON THE HOST, only AFTER the owner has created the Cloudflare DNS record:
#     Type A | Name app | Value 84.247.130.242 | Proxy status: DNS only | TTL Auto
#
#   sudo bash ops/titanor-time/r11/apply-caddy-r11.sh            # apply + verify (auto-rollback on failure)
#   sudo bash ops/titanor-time/r11/apply-caddy-r11.sh --rollback # restore the most recent pre-R11 backup
#
# What it does (fail-closed):
#   0. preconditions: caddy service ACTIVE, DNS resolves, baseline snapshot of every
#      existing vhost (abort if any is already down — we don't touch a broken Caddy)
#   1. install the holding page to /var/www/titanor-time-holding
#   2. back up /etc/caddy/Caddyfile
#   3. append the block from ops/titanor-time/r11/caddy-app-block.txt
#   4. caddy validate  -> on failure: restore backup, reload, exit 1
#   5. `systemctl reload caddy` (zero-downtime) -> fallback: caddy reload --address 127.0.0.1:2019
#   6. wait for the certificate, verify 503 holding + security headers + http->https
#   7. regression-check every existing vhost against its baseline
#   -> any verification failure restores the backup and reloads.
#
# NOTHING here touches DNS, the database, the pilot, or the old prod stack.
#
# INCIDENT 2026-08-31: never run `caddy stop` / `caddy start` / `caddy run`, and never
# `caddy reload` WITHOUT `--address` — those talk to the admin API at localhost:2019 and
# will hit the LIVE Caddy regardless of any test config. Reload only via systemd here.
set -Eeuo pipefail

HOST_IP=84.247.130.242
DOMAIN=app.titanorgroup.fi
ADMIN=127.0.0.1:2019
CADDYFILE=/etc/caddy/Caddyfile
REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
BLOCK="$REPO/ops/titanor-time/r11/caddy-app-block.txt"
HOLDING_SRC="$REPO/ops/titanor-time/r11/holding/index.html"
HOLDING_DIR=/var/www/titanor-time-holding
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/etc/caddy/Caddyfile.backup-before-r11-${TS}"

VHOSTS=(
  "https://titanorgroup.fi"
  "https://www.titanorgroup.fi"
  "https://collabstudio.run"
  "https://t97-dd686bc3d4.84.247.130.242.nip.io/login"
  "https://84-247-130-242.sslip.io"
)

die() { echo "ABORTED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"

code_of() { curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || echo 000; }

reload_caddy() {
  # systemd first (this script is root); explicit-IPv4 admin API as fallback.
  if systemctl reload caddy 2>/dev/null; then return 0; fi
  echo "   (systemctl reload failed, trying caddy reload --address $ADMIN)" >&2
  caddy reload --config "$CADDYFILE" --address "$ADMIN"
}

restore() {
  echo ">> restoring $1"
  cp -f "$1" "$CADDYFILE"
  reload_caddy || echo "WARNING: reload after restore failed — run: sudo systemctl reload caddy" >&2
}

# ---- rollback mode ----------------------------------------------------------
if [ "${1:-}" = "--rollback" ]; then
  latest="$(ls -1t /etc/caddy/Caddyfile.backup-before-r11-* 2>/dev/null | head -1 || true)"
  [ -n "$latest" ] || die "no /etc/caddy/Caddyfile.backup-before-r11-* found"
  restore "$latest"
  echo "rolled back to $latest ; the 'app' DNS record can stay (serves nothing) or be removed in Cloudflare"
  exit 0
fi

# ---- 0. preconditions -----------------------------------------------------
command -v caddy >/dev/null    || die "caddy not found"
command -v systemctl >/dev/null || die "systemctl not found"
[ -r "$BLOCK" ]       || die "missing $BLOCK"
[ -r "$HOLDING_SRC" ] || die "missing $HOLDING_SRC"
[ -w "$CADDYFILE" ]   || die "$CADDYFILE not writable"
grep -q "$DOMAIN" "$CADDYFILE" && die "$DOMAIN already present in $CADDYFILE — nothing to do"

systemctl is-active --quiet caddy || die "caddy.service is not active — start it and confirm all sites are up before running this"

echo ">> DNS check"
resolved="$(dig +short "$DOMAIN" A | tail -1 || true)"
[ "$resolved" = "$HOST_IP" ] || die "$DOMAIN resolves to '${resolved:-<empty>}', expected $HOST_IP — create the Cloudflare A record (DNS only) first"

echo ">> baseline snapshot of existing vhosts"
declare -A BASELINE
for u in "${VHOSTS[@]}"; do
  c="$(code_of "$u")"
  BASELINE["$u"]="$c"
  printf '   %-52s %s\n' "$u" "$c"
  case "$c" in 000|5??) die "$u is already $c BEFORE any change — refusing to touch Caddy";; esac
done

# ---- 1. holding page ----------------------------------------------------
echo ">> installing holding page -> $HOLDING_DIR"
mkdir -p "$HOLDING_DIR"
install -m 0644 "$HOLDING_SRC" "$HOLDING_DIR/index.html"
chmod 0755 "$HOLDING_DIR"

# ---- 2-3. backup + append --------------------------------------------
echo ">> backup $CADDYFILE -> $BACKUP"
cp -f "$CADDYFILE" "$BACKUP"

echo ">> appending block"
{ printf '\n'; grep -v '^#' "$BLOCK"; } >> "$CADDYFILE"

# ---- 4. validate ------------------------------------------------------
echo ">> caddy validate"
if ! caddy validate --config "$CADDYFILE" 2>&1 | tail -1 | grep -q "Valid configuration"; then
  restore "$BACKUP"
  die "caddy validate failed — backup restored"
fi

# ---- 5. reload ------------------------------------------------------
echo ">> reload caddy (systemd)"
reload_caddy || { restore "$BACKUP"; die "reload failed — backup restored"; }
systemctl is-active --quiet caddy || { restore "$BACKUP"; systemctl start caddy || true; die "caddy not active after reload — backup restored, started service"; }

# ---- 6. verify new vhost -------------------------------------------
echo ">> waiting for certificate + holding page (up to 150s)"
ok=0
for _ in $(seq 1 30); do
  code="$(code_of "https://$DOMAIN")"
  [ "$code" = 503 ] && { ok=1; break; }
  sleep 5
done
[ "$ok" = 1 ] || { restore "$BACKUP"; die "https://$DOMAIN did not return 503 holding (last: ${code:-?}) — backup restored"; }

hdrs="$(curl -sS -D - -o /dev/null --max-time 6 "https://$DOMAIN")"
echo "$hdrs" | grep -qi '^strict-transport-security:' || { restore "$BACKUP"; die "HSTS header missing — backup restored"; }
echo "$hdrs" | grep -qi '^x-robots-tag: *noindex'     || { restore "$BACKUP"; die "X-Robots-Tag noindex missing — backup restored"; }
echo "$hdrs" | grep -qi '^x-powered-by:'              && { restore "$BACKUP"; die "X-Powered-By leaked — backup restored"; }
redir="$(code_of "http://$DOMAIN")"
case "$redir" in 200|301|302|307|308) : ;; *) restore "$BACKUP"; die "http://$DOMAIN -> $redir (expected redirect) — backup restored";; esac

# ---- 7. regression vs baseline -----------------------------------
echo ">> regression check"
for u in "${VHOSTS[@]}"; do
  c="$(code_of "$u")"
  case "$c" in
    000|5??) restore "$BACKUP"; die "$u -> $c after reload (was ${BASELINE[$u]}) — backup restored";;
    *) printf '   ok  %-52s %s (was %s)\n' "$u" "$c" "${BASELINE[$u]}";;
  esac
done

echo
echo "== R11 apply OK =="
echo "   $DOMAIN : 503 holding, valid TLS, noindex, http->https ($redir)"
echo "   backup  : $BACKUP"
echo "   next    : agent verifies + writes R11_DOMAIN_CADDY_REPORT_RU.md ; app opens at R14"
