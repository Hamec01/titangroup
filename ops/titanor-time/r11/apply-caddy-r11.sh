#!/usr/bin/env bash
# R11 — apply the app.titanorgroup.fi holding vhost to Caddy (Variant A, grey-cloud).
#
# Run AS ROOT, ON THE HOST, only AFTER the owner has created the Cloudflare DNS record:
#     Type A | Name app | Value 84.247.130.242 | Proxy status: DNS only | TTL Auto
#
#   sudo bash ops/titanor-time/r11/apply-caddy-r11.sh            # apply + verify (auto-rollback on failure)
#   sudo bash ops/titanor-time/r11/apply-caddy-r11.sh --rollback # restore the most recent pre-R11 backup
#
# What it does (fail-closed, same structure as the pilot deploy scripts):
#   1. preconditions + DNS check (app.titanorgroup.fi must resolve to this host)
#   2. install the holding page to /var/www/titanor-time-holding
#   3. back up /etc/caddy/Caddyfile
#   4. append the block from ops/titanor-time/r11/caddy-app-block.txt
#   5. caddy validate  -> on failure: restore backup, reload, exit 1
#   6. systemctl reload caddy
#   7. wait for the certificate, verify 503 holding + security headers + http->https
#   8. regression-check the four existing vhosts
#   -> any verification failure restores the backup and reloads.
#
# NOTHING here touches DNS, the database, the pilot, or the old prod stack.
set -Eeuo pipefail

HOST_IP=84.247.130.242
DOMAIN=app.titanorgroup.fi
CADDYFILE=/etc/caddy/Caddyfile
REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
BLOCK="$REPO/ops/titanor-time/r11/caddy-app-block.txt"
HOLDING_SRC="$REPO/ops/titanor-time/r11/holding/index.html"
HOLDING_DIR=/var/www/titanor-time-holding
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="/etc/caddy/Caddyfile.backup-before-r11-${TS}"

die() { echo "ABORTED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"

reload_caddy() {
  if command -v systemctl >/dev/null && systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    caddy reload --config "$CADDYFILE"
  fi
}

restore() {
  echo ">> restoring $1"
  cp -f "$1" "$CADDYFILE"
  reload_caddy || true
}

# ---- rollback mode -------------------------------------------------------------
if [ "${1:-}" = "--rollback" ]; then
  latest="$(ls -1t /etc/caddy/Caddyfile.backup-before-r11-* 2>/dev/null | head -1 || true)"
  [ -n "$latest" ] || die "no /etc/caddy/Caddyfile.backup-before-r11-* found"
  restore "$latest"
  echo "rolled back to $latest ; the 'app' DNS record can stay (serves nothing) or be removed in Cloudflare"
  exit 0
fi

# ---- preconditions -----------------------------------------------------------
command -v caddy >/dev/null || die "caddy not found"
[ -r "$BLOCK" ]       || die "missing $BLOCK"
[ -r "$HOLDING_SRC" ] || die "missing $HOLDING_SRC"
[ -w "$CADDYFILE" ]   || die "$CADDYFILE not writable"
grep -q "$DOMAIN" "$CADDYFILE" && die "$DOMAIN already present in $CADDYFILE — nothing to do"

echo ">> DNS check"
resolved="$(dig +short "$DOMAIN" A | tail -1 || true)"
[ "$resolved" = "$HOST_IP" ] || die "$DOMAIN resolves to '${resolved:-<empty>}', expected $HOST_IP — create the Cloudflare A record (DNS only) first"

# ---- 2. holding page --------------------------------------------------------
echo ">> installing holding page -> $HOLDING_DIR"
mkdir -p "$HOLDING_DIR"
install -m 0644 "$HOLDING_SRC" "$HOLDING_DIR/index.html"
chmod 0755 "$HOLDING_DIR"

# ---- 3-4. backup + append -------------------------------------------------
echo ">> backup $CADDYFILE -> $BACKUP"
cp -f "$CADDYFILE" "$BACKUP"

echo ">> appending block"
{ printf '\n'; grep -v '^#' "$BLOCK"; } >> "$CADDYFILE"

# ---- 5. validate ----------------------------------------------------------
echo ">> caddy validate"
if ! caddy validate --config "$CADDYFILE" 2>&1 | tail -1 | grep -q "Valid configuration"; then
  restore "$BACKUP"
  die "caddy validate failed — backup restored"
fi

# ---- 6. reload ----------------------------------------------------------
echo ">> reload caddy"
reload_caddy || { restore "$BACKUP"; die "reload failed — backup restored"; }

# ---- 7. verify new vhost --------------------------------------------------
echo ">> waiting for certificate + holding page (up to 150s)"
ok=0
for i in $(seq 1 30); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "https://$DOMAIN" 2>/dev/null || echo 000)"
  if [ "$code" = 503 ]; then ok=1; break; fi
  sleep 5
done
[ "$ok" = 1 ] || { restore "$BACKUP"; die "https://$DOMAIN did not return 503 holding (last code: ${code:-?}) — backup restored"; }

hdrs="$(curl -sS -D - -o /dev/null --max-time 6 "https://$DOMAIN")"
echo "$hdrs" | grep -qi '^strict-transport-security:'      || { restore "$BACKUP"; die "HSTS header missing — backup restored"; }
echo "$hdrs" | grep -qi '^x-robots-tag: *noindex'          || { restore "$BACKUP"; die "X-Robots-Tag noindex missing — backup restored"; }
echo "$hdrs" | grep -qi '^x-powered-by:'                   && { restore "$BACKUP"; die "X-Powered-By leaked — backup restored"; }
redir="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 6 "http://$DOMAIN" 2>/dev/null || echo 000)"
case "$redir" in 200|301|302|307|308) : ;; *) restore "$BACKUP"; die "http://$DOMAIN -> $redir (expected redirect) — backup restored";; esac

# ---- 8. regression on existing vhosts -----------------------------------
echo ">> regression check"
for u in \
  "https://titanorgroup.fi" \
  "https://www.titanorgroup.fi" \
  "https://collabstudio.run" \
  "https://t97-dd686bc3d4.84.247.130.242.nip.io/login" \
  "https://84-247-130-242.sslip.io" ; do
  c="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$u" 2>/dev/null || echo 000)"
  case "$c" in 000|5??) restore "$BACKUP"; die "$u -> $c after reload — backup restored";; *) echo "   ok  $u -> $c";; esac
done

echo
echo "== R11 apply OK =="
echo "   $DOMAIN : 503 holding, valid TLS, noindex, http->https ($redir)"
echo "   backup  : $BACKUP"
echo "   next    : agent verifies + writes R11_DOMAIN_CADDY_REPORT_RU.md ; app opens at R14"
