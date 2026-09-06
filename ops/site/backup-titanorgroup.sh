#!/usr/bin/env bash
set -euo pipefail

umask 077

PROJECT_DIR="/home/deploy/projects/titanorgroup"
BACKUP_ROOT="/home/deploy/backups/titanorgroup"
MIRROR_ROOT="/mnt/250gb/titanorgroup/backups"
CONTAINER="titanorgroup-web-1"
RETENTION_DAYS="14"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="auto-${STAMP}"
STAGE="${BACKUP_ROOT}/.${NAME}.partial"
BACKUP_DIR="${BACKUP_ROOT}/${NAME}"
MIRROR_DIR="${MIRROR_ROOT}/${NAME}"
LOCK_FILE="/tmp/titanorgroup-backup.lock"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

cleanup() {
  rm -rf -- "$STAGE"
}
trap cleanup EXIT

exec 9>"$LOCK_FILE"
flock -n 9 || die "another Titanor Group backup is already running"

[ -d "$PROJECT_DIR/.git" ] || die "$PROJECT_DIR is not a Git work tree"
mountpoint -q /mnt/250gb || die "/mnt/250gb is not mounted"
[ -w "$BACKUP_ROOT" ] || die "$BACKUP_ROOT is not writable"
[ -w "$MIRROR_ROOT" ] || die "$MIRROR_ROOT is not writable"

docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER does not exist"
[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}')" = "true" ] \
  || die "container $CONTAINER is not running"
HEALTH="$(docker inspect "$CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
[ "$HEALTH" = "healthy" ] || die "container $CONTAINER health is $HEALTH"

[ ! -e "$STAGE" ] && [ ! -e "$BACKUP_DIR" ] || die "backup path already exists: $NAME"
[ ! -e "$MIRROR_DIR" ] || die "mirror path already exists: $NAME"
mkdir -p "$STAGE"

docker exec "$CONTAINER" tar -czf - -C /app data > "$STAGE/titanorgroup-data.tar.gz"
docker exec "$CONTAINER" tar -czf - -C /app/public uploads > "$STAGE/titanorgroup-uploads.tar.gz"

cp "$PROJECT_DIR/compose.yaml" "$STAGE/compose.yaml"
cp "$PROJECT_DIR/package.json" "$STAGE/package.json"
cp "$PROJECT_DIR/package-lock.json" "$STAGE/package-lock.json"
cp "$PROJECT_DIR/.env.production" "$STAGE/.env.production"
cp /etc/caddy/Caddyfile "$STAGE/Caddyfile"
chmod 600 "$STAGE/.env.production"

git -C "$PROJECT_DIR" status -sb > "$STAGE/git-status.txt"
git -C "$PROJECT_DIR" rev-parse HEAD > "$STAGE/git-commit.txt"
curl -fsS http://127.0.0.1:3100/api/health > "$STAGE/health-local.json"
curl -fsS https://titanorgroup.fi/api/health > "$STAGE/health-domain.json"

tar -tzf "$STAGE/titanorgroup-data.tar.gz" > "$STAGE/data-files.txt"
tar -tzf "$STAGE/titanorgroup-uploads.tar.gz" > "$STAGE/uploads-files.txt"

IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
IMAGE_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
GIT_HEAD="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
{
  echo "utc_timestamp=$STAMP"
  echo "container=$CONTAINER"
  echo "image=$IMAGE"
  echo "image_id=$IMAGE_ID"
  echo "git_head=$GIT_HEAD"
  echo "archive=titanorgroup-data.tar.gz"
  echo "archive=titanorgroup-uploads.tar.gz"
} > "$STAGE/manifest.txt"

(
  cd "$STAGE"
  sha256sum \
    titanorgroup-data.tar.gz \
    titanorgroup-uploads.tar.gz \
    manifest.txt > SHA256SUMS
  sha256sum --quiet -c SHA256SUMS
)

mv "$STAGE" "$BACKUP_DIR"
mkdir -p "$MIRROR_DIR"
cp -p \
  "$BACKUP_DIR/titanorgroup-data.tar.gz" \
  "$BACKUP_DIR/titanorgroup-uploads.tar.gz" \
  "$BACKUP_DIR/manifest.txt" \
  "$BACKUP_DIR/SHA256SUMS" \
  "$MIRROR_DIR/"
(
  cd "$MIRROR_DIR"
  sha256sum --quiet -c SHA256SUMS
)
printf 'completed_at=%s\n' "$(date -u +%FT%TZ)" > "$MIRROR_DIR/COMPLETE"

# Remove only backups owned by the service user. Old root-owned snapshots are retained for
# explicit owner-reviewed cleanup.
find "$BACKUP_ROOT" -maxdepth 1 -type d -user "$(id -u)" -name 'auto-*' \
  -mtime +"$RETENTION_DAYS" -print -exec rm -rf -- {} \;
# S3/FUSE directory rename and recursive deletion can block for a long time. Off-box retention is
# therefore an explicit maintenance task; COMPLETE is written last and marks a usable mirror.

trap - EXIT
echo "BACKUP OK"
echo "on-box:  $BACKUP_DIR"
echo "off-box: $MIRROR_DIR"
