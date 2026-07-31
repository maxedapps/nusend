#!/bin/sh
set -eu

umask 077

SOURCE=${NUSEND_BACKUP_SOURCE:-/var/lib/nusend/nusend.sqlite}
WORK_DIR=${NUSEND_BACKUP_WORK_DIR:-/work}
HEALTH_MARKER=$WORK_DIR/.nusend-backup-healthy
LOCK_FILE=$WORK_DIR/.nusend-backup.lock
RUN_DIR=
LOCK_HELD=0

fail() {
  printf 'backup: %s\n' "$1" >&2
  exit 1
}

require_nonblank() {
  value=$1
  label=$2
  [ -n "$(printf '%s' "$value" | tr -d '[:space:]')" ] || fail "$label is blank"
}

cleanup() {
  if [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ]; then
    rm -rf -- "$RUN_DIR"
  fi
  release_lock
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

invalidate_health() {
  rm -f -- "$HEALTH_MARKER"
}

mark_healthy() {
  date +%s >"$HEALTH_MARKER"
  chmod 0600 "$HEALTH_MARKER"
}

acquire_lock() {
  [ -d "$WORK_DIR" ] && [ -w "$WORK_DIR" ] || fail "backup work directory is missing or unwritable"
  # Hold only for the active backup/restore critical section, not across schedule sleeps.
  exec 9>"$LOCK_FILE"
  flock -n -E 75 9 || fail "another backup or restore is already running"
  LOCK_HELD=1
}

release_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    flock -u 9 2>/dev/null || true
    exec 9>&- 2>/dev/null || true
    LOCK_HELD=0
  fi
}

repository_command() {
  case "${RESTIC_REPOSITORY:-}" in
    s3:*)
      restic -o s3.bucket-lookup=path "$@"
      ;;
    *)
      restic "$@"
      ;;
  esac
}

ensure_repository() {
  require_nonblank "${RESTIC_REPOSITORY:-}" 'RESTIC_REPOSITORY'
  require_nonblank "${RESTIC_PASSWORD:-}" 'RESTIC_PASSWORD'
  export RESTIC_REPOSITORY RESTIC_PASSWORD
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
  export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
  # Non-root image has no home directory; keep restic cache on the work volume.
  RESTIC_CACHE_DIR=${RESTIC_CACHE_DIR:-$WORK_DIR/.restic-cache}
  mkdir -p "$RESTIC_CACHE_DIR"
  chmod 0700 "$RESTIC_CACHE_DIR"
  export RESTIC_CACHE_DIR

  set +e
  repository_command cat config >/dev/null 2>&1
  status=$?
  set -e

  case "$status" in
    0) return 0 ;;
    10)
      repository_command init >/dev/null
      printf 'backup: initialized repository\n'
      ;;
    *)
      fail "restic repository is not accessible (exit $status)"
      ;;
  esac
}

quick_check_db() {
  database=$1
  if ! quick_check=$(sqlite3 -batch -readonly -cmd '.timeout 30000' "$database" 'PRAGMA quick_check;'); then
    fail "SQLite quick_check could not read $database"
  fi
  [ "$quick_check" = "ok" ] || fail "SQLite quick_check did not return ok"
}

run_backup() {
  [ -f "$SOURCE" ] && [ -r "$SOURCE" ] || fail "backup source is missing or unreadable"
  case "$SOURCE$WORK_DIR" in
    *"'"* | *"
"*) fail "source and work paths may not contain quotes or newlines" ;;
  esac

  RUN_DIR=$(mktemp -d "$WORK_DIR/.nusend-backup.XXXXXX")
  chmod 0700 "$RUN_DIR"
  STAGING=$RUN_DIR/nusend.sqlite
  RESTIC_CACHE_DIR=$RUN_DIR/restic-cache
  export RESTIC_CACHE_DIR
  mkdir -m 0700 "$RESTIC_CACHE_DIR"

  if ! sqlite3 -batch -readonly -cmd '.timeout 30000' "$SOURCE" ".backup '$STAGING'"; then
    fail 'SQLite online backup failed'
  fi
  [ -f "$STAGING" ] || fail 'SQLite online backup did not create a snapshot'
  quick_check_db "$STAGING"

  if ! repository_command backup \
    --host "${RESTIC_HOST:-nusend}" \
    --tag nusend-db \
    --stdin \
    --stdin-filename nusend.sqlite \
    <"$STAGING" >/dev/null; then
    fail 'restic backup failed'
  fi

  rm -f -- "$STAGING"
  [ ! -e "$STAGING" ] || fail 'local staging snapshot could not be deleted'

  repository_command forget \
    --host "${RESTIC_HOST:-nusend}" \
    --tag nusend-db \
    --keep-daily 30 \
    --keep-monthly 12 \
    --prune >/dev/null

  mark_healthy
  printf 'backup: completed\n'
  rm -rf -- "$RUN_DIR"
  RUN_DIR=
}

restore_backup() {
  snapshot_id=$1
  case "$snapshot_id" in
    latest) fail 'restore requires an explicit 64-character snapshot id; latest is not allowed' ;;
    *[!0-9a-f]* | '') fail 'restore requires an explicit 64-character lowercase hex snapshot id' ;;
  esac
  [ "${#snapshot_id}" -eq 64 ] || fail 'restore requires an explicit 64-character lowercase hex snapshot id'

  [ -d "$(dirname "$SOURCE")" ] && [ -w "$(dirname "$SOURCE")" ] ||
    fail 'database directory is missing or unwritable'

  RUN_DIR=$(mktemp -d "$WORK_DIR/.nusend-restore.XXXXXX")
  chmod 0700 "$RUN_DIR"
  TARGET_DIR=$RUN_DIR/restored
  RESTIC_CACHE_DIR=$RUN_DIR/restic-cache
  export RESTIC_CACHE_DIR
  mkdir -m 0700 "$TARGET_DIR" "$RESTIC_CACHE_DIR"

  repository_command restore "$snapshot_id" --target "$TARGET_DIR" >/dev/null
  RESTORED=$TARGET_DIR/nusend.sqlite
  [ -f "$RESTORED" ] || fail 'restore did not produce nusend.sqlite'
  quick_check_db "$RESTORED"

  PRE_RESTORE="$(dirname "$SOURCE")/nusend.sqlite.pre-restore"
  if [ -e "$SOURCE" ]; then
    rm -f -- "$PRE_RESTORE"
    mv -- "$SOURCE" "$PRE_RESTORE"
  fi
  rm -f -- "${SOURCE}-wal" "${SOURCE}-shm"
  mv -- "$RESTORED" "$SOURCE"
  chmod 0600 "$SOURCE"

  printf 'backup: restored snapshot %s\n' "$snapshot_id"
  if [ -e "$PRE_RESTORE" ]; then
    printf 'backup: previous database preserved at %s\n' "$PRE_RESTORE"
  fi
  rm -rf -- "$RUN_DIR"
  RUN_DIR=
}

mode=${1:-schedule}
case "$mode" in
  schedule)
    invalidate_health
    while true; do
      acquire_lock
      ensure_repository
      run_backup
      release_lock
      sleep 86400
    done
    ;;
  run)
    acquire_lock
    ensure_repository
    run_backup
    ;;
  restore)
    [ "${2-}" != "" ] || fail 'usage: backup.sh restore <64-hex-snapshot-id>'
    acquire_lock
    ensure_repository
    restore_backup "$2"
    ;;
  *)
    fail 'usage: backup.sh [schedule|run|restore <snapshot-id>]'
    ;;
esac
