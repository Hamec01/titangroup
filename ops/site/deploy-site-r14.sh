#!/usr/bin/env bash
# titanorgroup.fi (public site) — R14 deploy: /fi <html lang="fi"> + Employee-login link.
#
# Same fail-closed / smoke-first / auto-rollback structure as ops/site/deploy-site-r07b.sh.
# The public site has NO database. Ships commit af829fe (feat(site): /fi html lang + Employee
# login link) on top of the live site-3321c09.
#
# Runbook step 18 — run AFTER the cutover + Caddy switch, once app.titanorgroup.fi serves the app
# (the new header link points there). Owner runs it (deploy user, docker group); no sudo.
#
# IMPORTANT: VERIFY_PORT is 3198, NOT 3199 — 3199 is the new Titanor Time prod web after R14.
# titanorgroup-web-1 is a hand-run container (compose-detached since R07-B) — do not
# `docker compose up -d` in /home/deploy/projects/titanorgroup afterwards.
set -Eeuo pipefail

REPO=/home/deploy/projects/titanorgroup-worktrees/titanor-time-foundation
BRANCH=feature/titanor-time-foundation
ENVFILE=/home/deploy/projects/titanorgroup/.env.production
NET=titanorgroup_default
DATA_VOL=titanorgroup_titanorgroup_data
UPLOADS_VOL=titanorgroup_titanorgroup_uploads
LIVE=titanorgroup-web-1
LIVE_PORT=3100
VERIFY=titanorgroup-web-verify
VERIFY_PORT=3198
MARK=r14
IMAGE_REPO=titanorgroup-web
BACKUP_ROOT=/home/deploy/backups/titanorgroup
MIRROR_ROOT=/mnt/250gb/titanorgroup/backups
LOCK=/home/deploy/projects/titanorgroup/.deploy-${MARK}.lock
PROBE_IP=192.0.2.247
EXTERNAL_URL=https://titanorgroup.fi

HEALTHCMD='node -e "fetch(\"http://127.0.0.1:3000/api/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'
SWAP_STARTED=0
SHA=""

die() { echo "DEPLOY ABORTED: $*" >&2; exit 1; }
git_worktree_ok() { [ "$(git -C "${1:-.}" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ]; }
git_tree_clean()  { [ -z "$(git -C "${1:-.}" status --porcelain 2>/dev/null)" ]; }
http_code() { local o; if o=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null); then printf '%s' "$o"; else printf '000'; fi; }

wait_health() {
  local c=$1 t=$2 d=0 h
  while [ "$d" -lt "$t" ]; do
    h=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)
    [ "$h" = healthy ] && return 0
    [ "$h" = missing ] && return 1
    sleep 5; d=$((d + 5))
  done
  return 1
}
cleanup_verify() { docker rm -f "$VERIFY" >/dev/null 2>&1 || true; }

rollback() {
  echo; echo "!!!!!!!!!!!!!!!!!!!!  ROLLBACK  !!!!!!!!!!!!!!!!!!!!"
  docker rm -f "$LIVE" 2>/dev/null || true
  if docker inspect "${LIVE}-pre-${MARK}" >/dev/null 2>&1; then
    docker rename "${LIVE}-pre-${MARK}" "$LIVE" && docker start "$LIVE" || echo "  !! restart $LIVE by hand"
  else
    echo "  !! ${LIVE}-pre-${MARK} missing — restore $LIVE by hand"
  fi
  docker ps -a --filter "name=titanorgroup-web" --format '  {{.Names}}  {{.Image}}  {{.Status}}' || true
}
on_err() { local rc=$? line=$1; echo "ERROR (rc=$rc) at line $line" >&2; cleanup_verify; [ "$SWAP_STARTED" = 1 ] && rollback; exit "$rc"; }
trap 'on_err $LINENO' ERR

echo "== 0/9  concurrency + state guard =="
exec 9>"$LOCK" || die "cannot open lock $LOCK"
flock -n 9 || die "another deploy-${MARK}.sh holds $LOCK"
docker inspect "${LIVE}-pre-${MARK}" >/dev/null 2>&1 && die "${LIVE}-pre-${MARK} exists — resolve a previous attempt first"
docker inspect "$VERIFY" >/dev/null 2>&1 && die "$VERIFY exists — remove it by hand"
[ "$(http_code "http://127.0.0.1:${VERIFY_PORT}/")" = "000" ] || die "port ${VERIFY_PORT} already answers — free it or change VERIFY_PORT"
docker inspect "$LIVE" >/dev/null 2>&1 || die "$LIVE not running — nothing to swap"

echo; echo "== 1/9  repo sanity =="
git_worktree_ok "$REPO" || die "$REPO not a git work tree"
git_tree_clean "$REPO"  || die "$REPO not clean:
$(git -C "$REPO" status --porcelain | sed 's/^/    /')"
[ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "worktree not on $BRANCH"
git -C "$REPO" fetch -q origin "$BRANCH" || die "git fetch failed"
git -C "$REPO" merge-base --is-ancestor HEAD "origin/$BRANCH" || die "HEAD not pushed to origin/$BRANCH"
git -C "$REPO" log --oneline -1 --grep='/fi html lang' "$BRANCH" >/dev/null 2>&1 || true
git -C "$REPO" merge-base --is-ancestor af829fe HEAD 2>/dev/null || die "HEAD does not contain af829fe (the R14 site change)"
SHA=$(git -C "$REPO" rev-parse --short=7 HEAD)
FULLSHA=$(git -C "$REPO" rev-parse HEAD)
IMAGE="${IMAGE_REPO}:site-${SHA}"
echo "  HEAD $SHA on $BRANCH (pushed, contains af829fe) -> image $IMAGE"

echo; echo "== 2/9  env file =="
[ -r "$ENVFILE" ] || die "env file $ENVFILE not readable"
for k in ADMIN_PASSWORD ADMIN_SESSION_SECRET SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD CONTACT_TO_EMAIL; do
  grep -qE "^${k}=[^[:space:]]" "$ENVFILE" || die "$k missing or empty in $ENVFILE"
done
echo "  ok"

echo; echo "== 3/9  Titanor Time baseline (captured now, re-checked at end) =="
tt_state() { docker inspect "$1" --format '{{.Image}} {{.State.StartedAt}} {{.RestartCount}}' 2>/dev/null || echo "absent"; }
TT_PROD_BEFORE=$(tt_state titanor-time-prod-app)
TT_PROD_SCH_BEFORE=$(tt_state titanor-time-prod-scheduler)
echo "  titanor-time-prod-app       : $TT_PROD_BEFORE"
echo "  titanor-time-prod-scheduler : $TT_PROD_SCH_BEFORE"

echo; echo "== 4/9  build immutable image =="
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  $IMAGE already built — reusing"
else
  DOCKER_BUILDKIT=1 docker build --provenance=false --sbom=false \
    --build-arg GIT_SHA="$SHA" --build-arg GIT_REF="$BRANCH" --build-arg BUILD_TIME="$(date -u +%FT%TZ)" \
    -f "$REPO/Dockerfile" -t "$IMAGE" "$REPO" || die "docker build failed"
fi
REV=$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[ "$REV" = "$SHA" ] || die "image revision label '$REV' != '$SHA'"
docker image inspect "$IMAGE" --format '  id={{.Id}}  revision={{index .Config.Labels "org.opencontainers.image.revision"}}'

echo; echo "== 5/9  pre-deploy backup (both volumes) — on-box + off-box =="
grep -q ' /mnt/250gb ' /proc/mounts || die "/mnt/250gb not mounted — off-box mirror would be fake. ABORT."
TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BACKUP_ROOT/pre-${MARK}-${TS}"; mkdir -p "$BK"
tarhelper() { docker run --rm --user 0:0 --entrypoint sh -v "$1":/src:ro -v "$BK":/dst "$IMAGE" -c "tar czf /dst/$2 -C /src ." || die "$1 backup failed"; }
tarhelper "$DATA_VOL" titanorgroup-data.tar.gz
tarhelper "$UPLOADS_VOL" titanorgroup-uploads.tar.gz
{ echo "utc_timestamp=$TS"; echo "git_head=$FULLSHA"; echo "reason=pre-deploy-${MARK}"; echo "archive=titanorgroup-data.tar.gz"; echo "archive=titanorgroup-uploads.tar.gz"; } > "$BK/manifest.txt"
( cd "$BK" && sha256sum titanorgroup-data.tar.gz titanorgroup-uploads.tar.gz manifest.txt > SHA256SUMS && sha256sum --quiet -c SHA256SUMS ) || die "on-box backup checksum failed"
mkdir -p "$MIRROR_ROOT/pre-${MARK}-${TS}" && cp -p "$BK"/* "$MIRROR_ROOT/pre-${MARK}-${TS}/" || die "off-box mirror copy failed"
( cd "$MIRROR_ROOT/pre-${MARK}-${TS}" && sha256sum --quiet -c SHA256SUMS ) || die "off-box mirror checksum FAILED"
echo "  on-box: $BK ; off-box: $MIRROR_ROOT/pre-${MARK}-${TS}"

run_checks() {  # $1 BASE  $2 CONTAINER  $3 live|verify
  local BASE=$1 C=$2 KIND=$3 F=0
  nf() { echo "     FAIL: $*"; F=$((F + 1)); }
  wait_health "$C" 120 || nf "$C never became healthy"
  [ "$(http_code "$BASE/api/health")" = 200 ] || nf "/api/health not 200"
  case "$(http_code "$BASE/")" in 2*|3*) : ;; *) nf "/ not 2xx/3xx" ;; esac

  local EN FI
  EN=$(curl -s --max-time 10 "$BASE/en" || true)
  FI=$(curl -s --max-time 10 "$BASE/fi" || true)
  [ "$(http_code "$BASE/en")" = 200 ] || nf "/en not 200"
  [ "$(http_code "$BASE/fi")" = 200 ] || nf "/fi not 200"
  printf '%s' "$FI" | grep -q 'Etusivu' && echo "     /fi has Finnish nav (Etusivu)" || nf "/fi missing Finnish content"
  printf '%s' "$EN" | grep -q '>Home<'  && echo "     /en has English nav (Home)"    || nf "/en missing English content"
  # R14: Employee-login link -> app.titanorgroup.fi, localised
  printf '%s' "$EN" | grep -q 'href="https://app.titanorgroup.fi"' && echo "     /en login link present" || nf "/en missing app.titanorgroup.fi link"
  printf '%s' "$EN" | grep -q 'Employee login' && echo "     /en 'Employee login'" || nf "/en missing 'Employee login'"
  printf '%s' "$FI" | grep -q 'Työntekijän kirjautuminen' && echo "     /fi 'Työntekijän kirjautuminen'" || nf "/fi missing FI login label"
  # R14: /fi <html lang> — the HtmlLang client component ships in the bundle (SSR still emits
  # lang="en"; the effect corrects it on hydration — curl cannot see the corrected value).
  printf '%s' "$FI" | grep -qE 'html-lang|HtmlLang|documentElement\.lang' && echo "     /fi ships the html-lang client fix" || nf "/fi bundle missing the html-lang fix"

  echo "     -- security headers --"
  local H; H=$(curl -s -D - -o /dev/null --max-time 10 "$BASE/en" || true)
  for key in X-Content-Type-Options X-Frame-Options Referrer-Policy Strict-Transport-Security; do
    printf '%s' "$H" | grep -qi "^${key}:" && echo "     header ok: $key" || nf "missing header $key"
  done
  printf '%s' "$H" | grep -qi '^x-powered-by:' && nf "X-Powered-By present" || echo "     no X-Powered-By"
  printf '%s' "$H" | grep -qi '^x-robots-tag:' && nf "X-Robots-Tag present (site must stay indexable)" || echo "     no X-Robots-Tag"
  printf '%s' "$(curl -s --max-time 10 "$BASE/robots.txt" || true)" | grep -q '/ship-admin-portal' || nf "robots.txt missing Disallow: /ship-admin-portal"
  printf '%s' "$(curl -s --max-time 10 "$BASE/sitemap.xml" || true)" | grep -q 'titanorgroup.fi' || nf "sitemap.xml missing/empty"

  echo "     -- admin login gate (regression) --"
  [ "$(http_code -X POST "$BASE/api/admin/login" -H 'content-type: application/json' --data '{"password":"x"}')" = 403 ] || nf "admin login without X-Requested-With did not 403"
  [ "$(http_code -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -H 'x-requested-with: titanor-admin' --data '{"password":"__deploy_wrong__"}')" = 401 ] || nf "admin login wrong password did not 401"
  local last=""
  for _ in $(seq 1 12); do last=$(http_code -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -H 'x-requested-with: titanor-admin' -H "x-forwarded-for: $PROBE_IP" --data '{"password":"__deploy_wrong__"}'); done
  echo "     12th admin-login probe -> $last (expect 429)"
  [ "$last" = 429 ] || nf "admin login rate limit did not trigger (got $last)"

  echo "     -- contact form + traversal (regression) --"
  case "$(http_code -X POST "$BASE/api/contact" -H 'content-type: application/json' -H "x-forwarded-for: $PROBE_IP" --data '{bad json')" in 4*) : ;; *) nf "malformed contact body not 4xx" ;; esac
  for u in "$BASE/uploads/../../etc/passwd" "$BASE/uploads/%2e%2e/%2e%2e/etc/passwd"; do
    case "$(http_code "$u")" in 5*) nf "traversal $u 5xx" ;; esac
  done
  echo "     traversal probes: no 5xx"
  return "$F"
}

echo; echo "== 6/9  SMOKE TEST on a throwaway container (live untouched) =="
cleanup_verify
docker run -d --name "$VERIFY" --network "$NET" --init -p "127.0.0.1:${VERIFY_PORT}:3000" \
  --env-file "$ENVFILE" -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 -e PORT=3000 -e HOSTNAME=0.0.0.0 -e UPLOAD_DIR=/app/public/uploads \
  --health-cmd "$HEALTHCMD" --health-interval 10s --health-timeout 3s --health-retries 5 --health-start-period 20s \
  "$IMAGE" >/dev/null
if run_checks "http://127.0.0.1:${VERIFY_PORT}" "$VERIFY" verify; then echo "  smoke PASS"; else cleanup_verify; die "smoke FAILED — live NOT touched"; fi
cleanup_verify

echo; echo "== 7/9  swap $LIVE =="
docker stop -t 30 "$LIVE" || true
docker rename "$LIVE" "${LIVE}-pre-${MARK}" || die "rename failed — restart it: docker start $LIVE"
SWAP_STARTED=1
docker run -d --name "$LIVE" --network "$NET" --init --restart unless-stopped -p "127.0.0.1:${LIVE_PORT}:3000" \
  --env-file "$ENVFILE" -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 -e PORT=3000 -e HOSTNAME=0.0.0.0 -e UPLOAD_DIR=/app/public/uploads \
  -v "$DATA_VOL":/app/data -v "$UPLOADS_VOL":/app/public/uploads \
  --health-cmd "$HEALTHCMD" --health-interval 10s --health-timeout 3s --health-retries 5 --health-start-period 20s \
  "$IMAGE" >/dev/null

echo; echo "== 8/9  verify live (fail-closed) =="
if run_checks "http://127.0.0.1:${LIVE_PORT}" "$LIVE" live; then SWAP_STARTED=0; echo "  all live checks passed"; else echo "  live verify FAILED — rolling back"; rollback; exit 1; fi
echo "  external (informational): $EXTERNAL_URL/fi -> $(http_code "$EXTERNAL_URL/fi")"

echo; echo "== 9/9  Titanor Time prod — must be identical =="
[ "$(tt_state titanor-time-prod-app)"       = "$TT_PROD_BEFORE" ]     || { echo "  !! titanor-time-prod-app CHANGED"; exit 2; }
[ "$(tt_state titanor-time-prod-scheduler)" = "$TT_PROD_SCH_BEFORE" ] || { echo "  !! titanor-time-prod-scheduler CHANGED"; exit 2; }
echo "  Titanor Time prod unchanged"

echo
docker ps --filter "name=titanorgroup-web" --format '  {{.Names}}  {{.Image}}  {{.Status}}'
echo
echo "DEPLOY OK — $LIVE on $IMAGE (R14: /fi html lang + Employee-login link)."
echo "Rollback: docker rm -f $LIVE && docker rename ${LIVE}-pre-${MARK} $LIVE && docker start $LIVE"
echo "Once satisfied: docker rm ${LIVE}-pre-${MARK}"
