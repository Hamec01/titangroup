#!/usr/bin/env bash
# titanorgroup.fi (public site) — deploy R04 (dependency security) + R07-B (security hardening).
#
# Same fail-closed / smoke-test-first / auto-rollback structure as the Titanor Time pilot deploy
# scripts (ops/titanor-time/deploy-pilot-8724480.sh). The public site has NO database — no
# migrations. This script:
#
#   1. builds an immutable image  titanorgroup-web:site-<shortsha>  from this worktree's HEAD;
#   2. backs up both named volumes (titanorgroup_titanorgroup_data + _uploads) on-box + off-box;
#   3. smoke-tests the new image in a THROWAWAY container on a spare port — live is untouched and
#      there is nothing to roll back if this fails;
#   4. only then swaps titanorgroup-web-1 (stop -> rename to -pre-<mark> -> docker run new), with
#      automatic rollback on any verification failure;
#   5. re-checks that Titanor Time (prod + pilot) was not touched.
#
# R07-B behaviour that goes live (see docs/titanor-time/R07B_PUBLIC_SITE_HARDENING_REPORT_RU.md):
#   * admin login: rate-limit 10/15min per trusted client IP, timing-safe password, CSRF header,
#     append-only login audit at /app/data/admin-login-audit.log (persists in the data volume);
#   * contact form: rate-limit 5/15min, SMTP connect/greeting/socket timeouts, sanitised error log;
#   * uploads: magic-byte format check, GIF rejected, sharp re-encode (EXIF/GPS stripped),
#     Content-Disposition + nosniff, path-traversal containment;
#   * security response headers on every route + no X-Powered-By; robots disallows the admin path.
#
# IMPORTANT — compose detachment. titanorgroup-web-1 is currently a docker-compose service
# (/home/deploy/projects/titanorgroup/compose.yaml). After this swap it is a hand-run container.
# Do NOT run `docker compose up -d` / `down` in that directory afterwards — it would recreate the
# container from the OLD compose build and revert this deploy. To re-sync compose later: check that
# repo out to the feature branch, `docker build` the same tag, point compose `image:` at it.
#
#   Run (as the deploy user, in the docker group):  bash ops/site/deploy-site-r07b.sh
#
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
VERIFY_PORT=3199
MARK=r07b                                   # rollback-container suffix ("state before deploying <MARK>")
IMAGE_REPO=titanorgroup-web
BACKUP_ROOT=/home/deploy/backups/titanorgroup
MIRROR_ROOT=/mnt/250gb/titanorgroup/backups
LOCK=/home/deploy/projects/titanorgroup/.deploy-${MARK}.lock
PROBE_IP=192.0.2.247                        # RFC 5737 TEST-NET-1 documentation address
EXTERNAL_URL=https://titanorgroup.fi        # informational only — Caddy/DNS not in scope

HEALTHCMD='node -e "fetch(\"http://127.0.0.1:3000/api/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'

SWAP_STARTED=0
SHA=""

die()  { echo "DEPLOY ABORTED: $*" >&2; exit 1; }

# --- git helpers ---
# This script builds from a *linked worktree*, where "$REPO/.git" is a FILE (a gitdir: pointer),
# not a directory — so `[ -d "$REPO/.git" ]` is the wrong test. Ask git instead.
git_worktree_ok() { [ "$(git -C "${1:-.}" rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ]; }
# Clean == no staged, unstaged, OR untracked (non-ignored) changes. Untracked source files would
# land in the image via `COPY . .`, so the built SHA would not describe what shipped.
git_tree_clean()  { [ -z "$(git -C "${1:-.}" status --porcelain 2>/dev/null)" ]; }

# Print the HTTP status code for a request, or exactly "000" on any curl failure
# (connection refused, DNS, timeout). Fail-closed: on failure curl itself prints "000" to stdout
# AND exits non-zero, so a `curl ... || echo 000` form yields "000000" — which broke the
# free-VERIFY_PORT guard below (it compares against "000"). Take curl's output only when curl
# succeeded; otherwise emit a single "000".
http_code() {
  local out
  if out=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null); then
    printf '%s' "$out"
  else
    printf '000'
  fi
}

if [ "${1:-}" = "--self-test" ]; then
  rc=0
  ok()   { echo "  ok: $*"; }
  bad()  { echo "  FAIL: $*"; rc=1; }

  echo "-- http_code: a free port (nothing listening) must yield exactly \"000\" --"
  for p in 1 2 3; do
    c=$(http_code "http://127.0.0.1:${p}/")
    [ "$c" = "000" ] && ok "free port 127.0.0.1:${p} -> '${c}'" \
      || bad "http_code for free port 127.0.0.1:${p} returned '${c}' (len ${#c}), expected exactly '000'"
  done

  echo "-- repo sanity: works for a linked worktree where .git is a FILE --"
  td=$(mktemp -d)
  git init -q "$td/main"
  git -C "$td/main" -c user.email=ci@example.invalid -c user.name=ci commit -q --allow-empty -m init
  git -C "$td/main" worktree add -q -b wt-selftest "$td/linked"
  [ -f "$td/linked/.git" ] && [ ! -d "$td/linked/.git" ] \
    && ok "linked worktree .git is a file (not a dir)" \
    || bad "expected $td/linked/.git to be a plain file"
  git_worktree_ok "$td/linked"     && ok "git_worktree_ok=true in the linked worktree" \
                                   || bad "git_worktree_ok said the linked worktree is not a work tree"
  git_worktree_ok "$td"            && bad "git_worktree_ok=true outside any repo" \
                                   || ok "git_worktree_ok=false outside a repo"
  git_tree_clean "$td/linked"      && ok "git_tree_clean=true for a clean linked worktree" \
                                   || bad "git_tree_clean=false for a clean linked worktree"
  : > "$td/linked/stray.txt"
  git_tree_clean "$td/linked"      && bad "git_tree_clean ignored an untracked file" \
                                   || ok "git_tree_clean=false with an untracked file present"
  rm -rf "$td"

  [ "$rc" = 0 ] && echo "self-test PASS" || echo "self-test FAIL"
  exit "$rc"
fi

wait_health() {  # $1 container  $2 timeout_s
  local c=$1 t=$2 d=0 h
  while [ "$d" -lt "$t" ]; do
    h=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo missing)
    [ "$h" = healthy ] && return 0
    [ "$h" = missing ] && return 1
    sleep 5; d=$((d + 5))
  done
  return 1
}

cleanup_verify() {
  docker rm -f "$VERIFY" >/dev/null 2>&1 || true
}

rollback() {
  echo
  echo "!!!!!!!!!!!!!!!!!!!!  ROLLBACK  !!!!!!!!!!!!!!!!!!!!"
  docker rm -f "$LIVE" 2>/dev/null || true
  if docker inspect "${LIVE}-pre-${MARK}" >/dev/null 2>&1; then
    docker rename "${LIVE}-pre-${MARK}" "$LIVE" && docker start "$LIVE" \
      || echo "  !! could not restart $LIVE — do it by hand: docker start $LIVE"
  else
    echo "  !! ${LIVE}-pre-${MARK} missing — restore $LIVE by hand"
  fi
  echo "  candidate image titanorgroup-web:site-${SHA} is untouched — fix the cause and retry."
  docker ps -a --filter "name=titanorgroup-web" --format '  {{.Names}}  {{.Image}}  {{.Status}}' || true
}

on_err() {
  local rc=$? line=$1
  echo "ERROR (rc=$rc) at line $line" >&2
  cleanup_verify
  if [ "$SWAP_STARTED" = 1 ]; then rollback; fi
  exit "$rc"
}
trap 'on_err $LINENO' ERR

# ============================================================================================
echo "== 0/9  concurrency + state guard =="
exec 9>"$LOCK" || die "cannot open lock $LOCK"
flock -n 9 || die "another deploy-${MARK}.sh holds $LOCK (or a dead run left it — remove it only if you are sure)"

if docker inspect "${LIVE}-pre-${MARK}" >/dev/null 2>&1; then
  die "${LIVE}-pre-${MARK} exists — this deploy was already attempted. Resolve first (roll back, or once satisfied remove that container BY HAND). This script never deletes rollback containers."
fi
docker inspect "$VERIFY" >/dev/null 2>&1 && die "$VERIFY container already exists — remove it by hand first"
VP=$(http_code "http://127.0.0.1:${VERIFY_PORT}/")   # exactly "000" when nothing is listening
[ "$VP" = "000" ] || die "port ${VERIFY_PORT} already answers HTTP ${VP} — free it or change VERIFY_PORT"
docker inspect "$LIVE" >/dev/null 2>&1 || die "$LIVE is not running — nothing to swap"

echo
echo "== 1/9  repo sanity =="
git_worktree_ok "$REPO" || die "$REPO is not inside a git work tree (rev-parse --is-inside-work-tree != true)"
git_tree_clean "$REPO"  || die "$REPO is not clean — commit or remove these before deploying:
$(git -C "$REPO" status --porcelain | sed 's/^/    /')"
CUR_BRANCH=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
[ "$CUR_BRANCH" = "$BRANCH" ] || die "worktree is on '$CUR_BRANCH', expected '$BRANCH'"
git -C "$REPO" fetch -q origin "$BRANCH" || die "git fetch failed"
git -C "$REPO" merge-base --is-ancestor HEAD "origin/$BRANCH" || die "HEAD is not pushed to origin/$BRANCH — push first"
SHA=$(git -C "$REPO" rev-parse --short=7 HEAD)
FULLSHA=$(git -C "$REPO" rev-parse HEAD)
IMAGE="${IMAGE_REPO}:site-${SHA}"
echo "  HEAD $SHA on $BRANCH (pushed) -> image $IMAGE"

echo
echo "== 2/9  env file =="
[ -r "$ENVFILE" ] || die "env file $ENVFILE not readable"
for k in ADMIN_PASSWORD ADMIN_SESSION_SECRET SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD CONTACT_TO_EMAIL; do
  # `KEY=` followed by at least one non-blank char. grep -q, no pipeline — a missing key must land
  # on the die below, not abort the script via pipefail+set -e.
  grep -qE "^${k}=[^[:space:]]" "$ENVFILE" || die "$k missing or empty in $ENVFILE"
done
echo "  ok — required admin/SMTP keys present"

echo
echo "== 3/9  Titanor Time baseline (captured now, re-checked at the end) =="
tt_state() { docker inspect "$1" --format '{{.Image}} {{.State.StartedAt}} {{.RestartCount}}' 2>/dev/null || echo "absent"; }
TT_PROD_BEFORE=$(tt_state titanor-time-app-1)
TT_PILOT_APP_BEFORE=$(tt_state t97-pilot-app)
TT_PILOT_SCH_BEFORE=$(tt_state t97-pilot-scheduler)
echo "  titanor-time-app-1     : $TT_PROD_BEFORE"
echo "  t97-pilot-app          : $TT_PILOT_APP_BEFORE"
echo "  t97-pilot-scheduler    : $TT_PILOT_SCH_BEFORE"

echo
echo "== 4/9  build immutable image =="
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  $IMAGE already built — reusing"
else
  DOCKER_BUILDKIT=1 docker build \
    --provenance=false --sbom=false \
    --build-arg GIT_SHA="$SHA" --build-arg GIT_REF="$BRANCH" --build-arg BUILD_TIME="$(date -u +%FT%TZ)" \
    -f "$REPO/Dockerfile" -t "$IMAGE" "$REPO" || die "docker build failed"
fi
REV=$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[ "$REV" = "$SHA" ] || die "image revision label '$REV' != '$SHA' — wrong build"
docker image inspect "$IMAGE" --format '  id={{.Id}}  revision={{index .Config.Labels "org.opencontainers.image.revision"}}  created={{index .Config.Labels "org.opencontainers.image.created"}}'

echo
echo "== 5/9  pre-deploy backup (both volumes) — on-box + off-box, fail-closed =="
grep -q ' /mnt/250gb ' /proc/mounts \
  || die "/mnt/250gb is not mounted — the off-box mirror would be a silent local fake. ABORT."
TS=$(date -u +%Y%m%dT%H%M%SZ)
BK="$BACKUP_ROOT/pre-${MARK}-${TS}"
mkdir -p "$BK"
# Use the freshly-built image as the tar helper (busybox tar, guaranteed present, no pull) with a
# root override so it can read the root-owned volume data and write the backup dir.
tarhelper() {  # $1 volume  $2 output-file
  docker run --rm --user 0:0 --entrypoint sh \
    -v "$1":/src:ro -v "$BK":/dst "$IMAGE" \
    -c "tar czf /dst/$2 -C /src ." || die "$1 backup failed"
}
tarhelper "$DATA_VOL" titanorgroup-data.tar.gz
tarhelper "$UPLOADS_VOL" titanorgroup-uploads.tar.gz
{
  echo "utc_timestamp=$TS"
  echo "git_branch=$BRANCH"
  echo "git_head=$FULLSHA"
  echo "container_name=/$LIVE"
  echo "reason=pre-deploy-${MARK}"
  echo "archive=titanorgroup-data.tar.gz"
  echo "archive=titanorgroup-uploads.tar.gz"
} > "$BK/manifest.txt"
( cd "$BK" && sha256sum titanorgroup-data.tar.gz titanorgroup-uploads.tar.gz manifest.txt > SHA256SUMS )
( cd "$BK" && sha256sum --quiet -c SHA256SUMS ) || die "on-box backup checksum verify failed"
mkdir -p "$MIRROR_ROOT/pre-${MARK}-${TS}"
cp -p "$BK"/* "$MIRROR_ROOT/pre-${MARK}-${TS}/" || die "off-box mirror copy failed"
( cd "$MIRROR_ROOT/pre-${MARK}-${TS}" && sha256sum --quiet -c SHA256SUMS ) || die "off-box mirror checksum re-verify FAILED"
echo "  on-box:  $BK"
echo "  off-box: $MIRROR_ROOT/pre-${MARK}-${TS} (checksum re-verified)"

# ============================================================================================
run_checks() {  # $1 BASE_URL  $2 CONTAINER  $3 live|verify
  local BASE=$1 C=$2 KIND=$3 F=0
  nf() { echo "     FAIL: $*"; F=$((F + 1)); }

  wait_health "$C" 120 || nf "$C never became healthy"
  [ "$(http_code "$BASE/api/health")" = 200 ] || nf "/api/health not 200"
  for p in /en /fi; do
    c=$(http_code "$BASE$p"); echo "     $p -> $c"; [ "$c" = 200 ] || nf "$p http $c"
  done
  case "$(http_code "$BASE/")" in 2*|3*) : ;; *) nf "/ not 2xx/3xx" ;; esac

  echo "     -- security headers --"
  local H; H=$(curl -s -D - -o /dev/null --max-time 10 "$BASE/en" || true)
  for key in X-Content-Type-Options X-Frame-Options Referrer-Policy Cross-Origin-Opener-Policy Permissions-Policy Strict-Transport-Security; do
    printf '%s' "$H" | grep -qi "^${key}:" && echo "     header ok: $key" || nf "missing header $key"
  done
  printf '%s' "$H" | grep -qi '^x-powered-by:' && nf "X-Powered-By present" || echo "     no X-Powered-By"
  printf '%s' "$H" | grep -qi '^x-robots-tag:' && nf "X-Robots-Tag present (site must stay indexable)" || echo "     no X-Robots-Tag"

  local ROB; ROB=$(curl -s --max-time 10 "$BASE/robots.txt" || true)
  printf '%s' "$ROB" | grep -q '/ship-admin-portal' && echo "     robots disallows the admin path" || nf "robots.txt missing Disallow: /ship-admin-portal"
  printf '%s' "$(curl -s --max-time 10 "$BASE/sitemap.xml" || true)" | grep -q 'titanorgroup.fi' || nf "sitemap.xml missing/empty"

  echo "     -- admin login gate --"
  [ "$(http_code -X POST "$BASE/api/admin/login" -H 'content-type: application/json' --data '{"password":"x"}')" = 403 ] \
    || nf "admin login without X-Requested-With did not 403"
  [ "$(http_code -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -H 'x-requested-with: titanor-admin' --data '{"password":"__deploy_wrong__"}')" = 401 ] \
    || nf "admin login wrong password did not 401"
  local last=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    last=$(http_code -X POST "$BASE/api/admin/login" -H 'content-type: application/json' -H 'x-requested-with: titanor-admin' \
      -H "x-forwarded-for: $PROBE_IP" --data '{"password":"__deploy_wrong__"}')
  done
  echo "     12th admin-login probe ($PROBE_IP) -> $last (expect 429)"
  [ "$last" = 429 ] || nf "admin login rate limit did not trigger (got $last)"

  echo "     -- contact form --"
  local cc; cc=$(http_code -X POST "$BASE/api/contact" -H 'content-type: application/json' -H "x-forwarded-for: $PROBE_IP" --data '{bad json')
  echo "     malformed contact body -> $cc (expect 400)"
  case "$cc" in 4*) : ;; *) nf "malformed contact body returned $cc (must be 4xx, never 5xx)" ;; esac

  echo "     -- upload path traversal --"
  for u in "$BASE/uploads/../../etc/passwd" "$BASE/uploads/%2e%2e/%2e%2e/etc/passwd" "$BASE/uploads/services/welding/..%2f..%2f..%2fetc%2fpasswd"; do
    local tc; tc=$(http_code "$u")
    case "$tc" in 5*) nf "traversal $u -> $tc" ;; *) : ;; esac
  done
  echo "     traversal probes: no 5xx"

  echo "     -- SMTP env present in the container --"
  for k in SMTP_HOST SMTP_USER SMTP_PASSWORD CONTACT_TO_EMAIL; do
    docker exec "$C" printenv "$k" >/dev/null 2>&1 && echo "     env ok: $k" || nf "env $k not set in $C"
  done

  if [ "$KIND" = live ]; then
    echo "     -- existing uploads still served --"
    local rel
    rel=$(docker exec "$C" sh -c 'find /app/public/uploads/services -type f 2>/dev/null | head -1' | sed 's#/app/public##' || true)
    if [ -n "$rel" ]; then
      local uc; uc=$(http_code "$BASE$rel")
      echo "     GET $rel -> $uc"
      [ "$uc" = 200 ] || nf "existing upload $rel not served ($uc) — volume mount wrong?"
    else
      echo "     (no existing uploads to probe — skipped)"
    fi
    echo "     -- login audit log is being written --"
    docker exec "$C" sh -c 'test -s /app/data/admin-login-audit.log' \
      && echo "     /app/data/admin-login-audit.log present + non-empty" \
      || nf "admin-login-audit.log missing/empty after login probes"
  fi

  return "$F"
}

echo
echo "== 6/9  SMOKE TEST on a throwaway container (live untouched) =="
cleanup_verify
docker run -d --name "$VERIFY" --network "$NET" --init \
  -p "127.0.0.1:${VERIFY_PORT}:3000" \
  --env-file "$ENVFILE" \
  -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 -e PORT=3000 -e HOSTNAME=0.0.0.0 -e UPLOAD_DIR=/app/public/uploads \
  --health-cmd "$HEALTHCMD" --health-interval 10s --health-timeout 3s --health-retries 5 --health-start-period 20s \
  "$IMAGE" >/dev/null
echo "  $VERIFY up on 127.0.0.1:${VERIFY_PORT} (no volumes, no restart policy)"
if run_checks "http://127.0.0.1:${VERIFY_PORT}" "$VERIFY" verify; then
  echo "  smoke test PASS"
else
  cleanup_verify
  die "smoke test FAILED — live site NOT touched, nothing to roll back. Fix and retry."
fi
cleanup_verify
echo "  $VERIFY removed"

# ============================================================================================
echo
echo "== 7/9  swap $LIVE =="
OLD_ID=$(docker inspect "$LIVE" --format '{{.Id}}') || die "cannot inspect $LIVE"
echo "  old container ${OLD_ID:0:12}  image $(docker inspect "$LIVE" --format '{{.Config.Image}}')"
docker stop -t 30 "$LIVE" || true
docker rename "$LIVE" "${LIVE}-pre-${MARK}" \
  || die "rename failed — $LIVE is stopped, no rollback container yet. Restart it: docker start $LIVE"
SWAP_STARTED=1   # ${LIVE}-pre-${MARK} now exists → automatic rollback can restore it
docker run -d --name "$LIVE" --network "$NET" --init --restart unless-stopped \
  -p "127.0.0.1:${LIVE_PORT}:3000" \
  --env-file "$ENVFILE" \
  -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 -e PORT=3000 -e HOSTNAME=0.0.0.0 -e UPLOAD_DIR=/app/public/uploads \
  -v "$DATA_VOL":/app/data \
  -v "$UPLOADS_VOL":/app/public/uploads \
  --health-cmd "$HEALTHCMD" --health-interval 10s --health-timeout 3s --health-retries 5 --health-start-period 20s \
  "$IMAGE" >/dev/null
echo "  new container $(docker inspect "$LIVE" --format '{{.Id}}' | cut -c1-12) on $IMAGE"

echo
echo "== 8/9  verify live (fail-closed — any failure rolls back) =="
if run_checks "http://127.0.0.1:${LIVE_PORT}" "$LIVE" live; then
  SWAP_STARTED=0
  echo "  all live verification checks passed."
else
  echo "  live verification FAILED — rolling back."
  rollback
  exit 1
fi
echo "  external (informational, Caddy not in scope): $EXTERNAL_URL/en -> $(http_code "$EXTERNAL_URL/en")"

echo
echo "== 9/9  Titanor Time baseline — must be identical =="
[ "$(tt_state titanor-time-app-1)"   = "$TT_PROD_BEFORE" ]      || { echo "  !! titanor-time-app-1 CHANGED"; exit 2; }
[ "$(tt_state t97-pilot-app)"        = "$TT_PILOT_APP_BEFORE" ] || { echo "  !! t97-pilot-app CHANGED"; exit 2; }
[ "$(tt_state t97-pilot-scheduler)"  = "$TT_PILOT_SCH_BEFORE" ] || { echo "  !! t97-pilot-scheduler CHANGED"; exit 2; }
echo "  Titanor Time prod + pilot unchanged"

echo
docker ps --filter "name=titanorgroup-web" --format '  {{.Names}}  {{.Image}}  {{.Status}}'
echo
echo "DEPLOY OK — $LIVE on $IMAGE (R04 + R07-B)."
echo
echo "Manual post-deploy check (owner): submit the real contact form once and confirm the email"
echo "arrives at CONTACT_TO_EMAIL — this script only verified the SMTP_* env is present, not delivery."
echo
echo "Rollback later (never deletes the -pre-${MARK} container):"
echo "  docker rm -f $LIVE && docker rename ${LIVE}-pre-${MARK} $LIVE && docker start $LIVE"
echo
echo "Once satisfied, remove the rollback container BY HAND:  docker rm ${LIVE}-pre-${MARK}"
echo "Do NOT run 'docker compose up -d' in /home/deploy/projects/titanorgroup (see header)."
