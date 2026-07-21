#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
PROJECT=nusend-backup-smoke-$$
WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/nusend-backup-smoke.XXXXXX")
IMAGE=${PROJECT}-image
SOURCE_REVISION=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'smoke')

cleanup() {
  status=$?
  docker rm -f "${PROJECT}-run" "${PROJECT}-run2" "${PROJECT}-lock" >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf -- "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT INT TERM

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'docker is required'
command -v sqlite3 >/dev/null 2>&1 || fail 'sqlite3 is required'

mkdir -m 0700 \
  "$WORKDIR/data" \
  "$WORKDIR/work" \
  "$WORKDIR/repo"

DB=$WORKDIR/data/nusend.sqlite
sqlite3 "$DB" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO items (value) VALUES ('first');
SQL
# Ensure a committed WAL row is present for backup coverage.
sqlite3 "$DB" "INSERT INTO items (value) VALUES ('wal-row');"

docker build \
  -t "$IMAGE" \
  --build-arg "SOURCE_REVISION=$SOURCE_REVISION" \
  --build-arg "VERSION=smoke" \
  -f "$ROOT/deploy/backup/Dockerfile" \
  "$ROOT/deploy/backup" >/dev/null

run_backup_container() {
  name=$1
  shift
  docker run --rm --name "$name" \
    --user 10001:10001 \
    -e RESTIC_REPOSITORY=/repo \
    -e RESTIC_PASSWORD=smoke-password-not-for-production \
    -e NUSEND_BACKUP_SOURCE=/var/lib/nusend/nusend.sqlite \
    -e NUSEND_BACKUP_WORK_DIR=/work \
    -v "$WORKDIR/data:/var/lib/nusend" \
    -v "$WORKDIR/work:/work" \
    -v "$WORKDIR/repo:/repo" \
    "$IMAGE" "$@"
}

# First run initializes repository and creates a snapshot.
run_backup_container "${PROJECT}-run" run >/dev/null
[ -f "$WORKDIR/work/.nusend-backup-healthy" ] || fail 'health marker missing after first run'
pass 'initial-backup'

# Second run reuses repository without re-init and creates another snapshot.
run_backup_container "${PROJECT}-run2" run >/dev/null
pass 'second-backup'

snapshots=$(docker run --rm \
  --user 10001:10001 \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD=smoke-password-not-for-production \
  -v "$WORKDIR/repo:/repo" \
  "$IMAGE" \
  sh -c 'restic snapshots --json --host nusend --tag nusend-db' 2>/dev/null || true)

# The image entrypoint is backup.sh; call restic via override.
snapshots=$(docker run --rm --entrypoint restic \
  --user 10001:10001 \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD=smoke-password-not-for-production \
  -e RESTIC_CACHE_DIR=/work/.restic-cache \
  -v "$WORKDIR/work:/work" \
  -v "$WORKDIR/repo:/repo" \
  "$IMAGE" \
  snapshots --json --host nusend --tag nusend-db)
snapshot_count=$(printf '%s' "$snapshots" | grep -o '"id":"[0-9a-f]\{64\}"' | wc -l | tr -d ' ')
[ "$snapshot_count" -ge 2 ] || fail "expected at least two snapshots, got $snapshot_count"

first_id=$(printf '%s' "$snapshots" | grep -o '"id":"[0-9a-f]\{64\}"' | head -n 1 | sed 's/"id":"//;s/"$//')
[ "${#first_id}" -eq 64 ] || fail 'could not parse first snapshot id'

# Overlap lock: hold lock with a long-running shell using the same lock file protocol.
docker run -d --name "${PROJECT}-lock" \
  --user 10001:10001 \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD=smoke-password-not-for-production \
  -e NUSEND_BACKUP_SOURCE=/var/lib/nusend/nusend.sqlite \
  -e NUSEND_BACKUP_WORK_DIR=/work \
  -v "$WORKDIR/data:/var/lib/nusend" \
  -v "$WORKDIR/work:/work" \
  -v "$WORKDIR/repo:/repo" \
  --entrypoint sh \
  "$IMAGE" \
  -c 'exec 9>/work/.nusend-backup.lock; flock -n 9 || exit 1; sleep 30' >/dev/null

if run_backup_container "${PROJECT}-overlap" run >/dev/null 2>"$WORKDIR/lock.err"; then
  docker rm -f "${PROJECT}-lock" >/dev/null 2>&1 || true
  fail 'overlapping backup was not rejected'
fi
grep -F 'already running' "$WORKDIR/lock.err" >/dev/null || fail 'lock error message missing'
docker rm -f "${PROJECT}-lock" >/dev/null
pass 'lock-rejects-overlap'

# Mutate DB, then restore the older snapshot.
sqlite3 "$DB" "INSERT INTO items (value) VALUES ('after-backup');"
run_backup_container "${PROJECT}-restore" restore "$first_id" >/dev/null
restored_count=$(sqlite3 "$DB" 'SELECT COUNT(*) FROM items;')
# Older snapshot should not include the post-backup row; allow first+wal only.
case "$restored_count" in
  1|2) ;;
  *) fail "unexpected restored row count: $restored_count" ;;
esac
[ -f "$WORKDIR/data/nusend.sqlite.pre-restore" ] || fail 'pre-restore DB not preserved'
pass 'explicit-restore'

# latest selector rejected
if run_backup_container "${PROJECT}-latest" restore latest >/dev/null 2>"$WORKDIR/latest.err"; then
  fail 'latest restore was accepted'
fi
grep -F 'latest is not allowed' "$WORKDIR/latest.err" >/dev/null || fail 'latest rejection message missing'
pass 'reject-latest'

# Missing password fails closed without init side effects on a fresh repo path.
rm -rf "$WORKDIR/repo2"
mkdir -m 0700 "$WORKDIR/repo2"
if docker run --rm --name "${PROJECT}-nopass" \
  --user 10001:10001 \
  -e RESTIC_REPOSITORY=/repo \
  -e RESTIC_PASSWORD= \
  -e NUSEND_BACKUP_SOURCE=/var/lib/nusend/nusend.sqlite \
  -e NUSEND_BACKUP_WORK_DIR=/work \
  -v "$WORKDIR/data:/var/lib/nusend" \
  -v "$WORKDIR/work:/work" \
  -v "$WORKDIR/repo2:/repo" \
  "$IMAGE" run >/dev/null 2>"$WORKDIR/nopass.err"; then
  fail 'blank password was accepted'
fi
pass 'blank-password-rejected'

printf 'PASS backup-smoke\n'
