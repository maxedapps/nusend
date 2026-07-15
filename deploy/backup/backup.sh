#!/bin/sh
set -eu

umask 077

fail() {
  printf 'backup: %s\n' "$1" >&2
  exit 1
}

require_nonblank() {
  value=$1
  label=$2
  [ -n "$(printf '%s' "$value" | tr -d '[:space:]')" ] || fail "$label is blank"
  normalized=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  case "$normalized" in
    replace-with-* | replace-me | changeme | change-me | *placeholder* | *'<account'* | *'<bucket'*)
      fail "$label is a placeholder"
      ;;
  esac
}

read_secret() {
  secret_file=$1
  label=$2
  [ -f "$secret_file" ] && [ -r "$secret_file" ] || fail "$label file is missing or unreadable"
  secret_value=$(cat "$secret_file")
  require_nonblank "$secret_value" "$label"
  printf '%s' "$secret_value"
}

validate_sqlite() {
  database=$1
  if ! quick_check=$(sqlite3 -batch -readonly -cmd '.timeout 30000' "$database" 'PRAGMA quick_check;'); then
    fail "SQLite quick_check could not read $database"
  fi
  [ "$quick_check" = "ok" ] || fail "SQLite quick_check did not return exactly one ok row"

  if ! foreign_keys=$(sqlite3 -batch -readonly -cmd '.timeout 30000' "$database" 'PRAGMA foreign_key_check;'); then
    fail "SQLite foreign_key_check could not read $database"
  fi
  [ -z "$foreign_keys" ] || fail "SQLite foreign_key_check returned rows"
}

SOURCE=${NUSEND_BACKUP_SOURCE:-/source/nusend.sqlite}
WORK_DIR=${NUSEND_BACKUP_WORK_DIR:-/work}
PASSWORD_FILE=${RESTIC_PASSWORD_FILE:-/run/secrets/restic_password}
TEST_REPOSITORY=${NUSEND_BACKUP_TEST_ONLY_LOCAL_REPOSITORY:-}
TEST_MODE=${NUSEND_BACKUP_TEST_ONLY:-0}
TEST_SQLITE_MARKERS=${NUSEND_BACKUP_TEST_ONLY_SQLITE_MARKERS:-0}
RUN_DIR=
SQLITE_MARKER_PID=
SQLITE_STARTED_MARKER=
SQLITE_FINISHED_MARKER=

cleanup() {
  if [ -n "$SQLITE_MARKER_PID" ]; then
    kill "$SQLITE_MARKER_PID" >/dev/null 2>&1 || true
    wait "$SQLITE_MARKER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ]; then
    rm -rf -- "$RUN_DIR"
  fi
  if [ -n "$SQLITE_STARTED_MARKER" ]; then
    rm -f -- "$SQLITE_STARTED_MARKER" "$SQLITE_FINISHED_MARKER"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ -f "$SOURCE" ] && [ -r "$SOURCE" ] || fail "backup source is missing or unreadable"
[ -d "$WORK_DIR" ] && [ -w "$WORK_DIR" ] || fail "backup work directory is missing or unwritable"
case "$SOURCE$WORK_DIR" in
  *"'"* | *"
"*) fail "source and work paths may not contain quotes or newlines" ;;
esac

# Keep this descriptor open in this shell until cleanup and every repository
# operation have completed. No caller-controlled environment can bypass it.
LOCK_FILE=$WORK_DIR/.nusend-backup.lock
exec 9>"$LOCK_FILE"
flock -n -E 75 9

# Validate the password even in local test mode; restic reads it from this file.
read_secret "$PASSWORD_FILE" 'restic password' >/dev/null
export RESTIC_PASSWORD_FILE="$PASSWORD_FILE"

if [ -n "$TEST_REPOSITORY" ]; then
  [ "$TEST_MODE" = "1" ] || fail "test-only local repository requires NUSEND_BACKUP_TEST_ONLY=1"
  case "$TEST_REPOSITORY" in
    /*) ;;
    *) fail "test-only local repository must be an absolute local path" ;;
  esac
  [ -d "$TEST_REPOSITORY" ] || fail "test-only local repository is missing"
  RESTIC_REPOSITORY=$TEST_REPOSITORY
  export RESTIC_REPOSITORY
  repository_command() {
    restic "$@"
  }
else
  [ "$TEST_MODE" = "0" ] || fail "NUSEND_BACKUP_TEST_ONLY=1 requires a local repository"

  ACCOUNT_ID=${R2_ACCOUNT_ID:-}
  BUCKET=${R2_BUCKET:-}
  require_nonblank "$ACCOUNT_ID" 'R2 account ID'
  require_nonblank "$BUCKET" 'R2 bucket'
  case "$ACCOUNT_ID" in *[!0-9A-Fa-f]*) fail "R2 account ID has invalid characters" ;; esac
  [ "${#ACCOUNT_ID}" -eq 32 ] || fail "R2 account ID must contain 32 hexadecimal characters"
  case "$BUCKET" in
    *[!a-z0-9.-]* | .* | *. | -* | *- | *..*) fail "R2 bucket has invalid characters" ;;
  esac
  [ "${#BUCKET}" -ge 3 ] && [ "${#BUCKET}" -le 63 ] || fail "R2 bucket length is invalid"

  ACCESS_KEY_FILE=${AWS_ACCESS_KEY_ID_FILE:-/run/secrets/r2_access_key_id}
  SECRET_KEY_FILE=${AWS_SECRET_ACCESS_KEY_FILE:-/run/secrets/r2_secret_access_key}
  AWS_ACCESS_KEY_ID=$(read_secret "$ACCESS_KEY_FILE" 'R2 access key ID')
  AWS_SECRET_ACCESS_KEY=$(read_secret "$SECRET_KEY_FILE" 'R2 secret access key')
  AWS_DEFAULT_REGION=auto
  RESTIC_REPOSITORY="s3:https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/nusend"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION RESTIC_REPOSITORY

  restic_r2(){ restic -o s3.bucket-lookup=path "$@"; }
  repository_command() {
    restic_r2 "$@"
  }
fi

case "$TEST_SQLITE_MARKERS" in
  0) ;;
  1)
    [ "$TEST_MODE" = "1" ] && [ -n "$TEST_REPOSITORY" ] \
      || fail 'SQLite test markers require both local test settings'
    SQLITE_STARTED_MARKER=$WORK_DIR/.nusend-backup-test-sqlite-started
    SQLITE_FINISHED_MARKER=$WORK_DIR/.nusend-backup-test-sqlite-finished
    rm -f -- "$SQLITE_STARTED_MARKER" "$SQLITE_FINISHED_MARKER"
    ;;
  *) fail 'NUSEND_BACKUP_TEST_ONLY_SQLITE_MARKERS must be 0 or 1' ;;
esac

RUN_DIR=$(mktemp -d "$WORK_DIR/.nusend-backup.XXXXXX")
chmod 0700 "$RUN_DIR"
STAGING=$RUN_DIR/nusend.sqlite
VERIFY_DIR=$RUN_DIR/verified
BACKUP_JSON=$RUN_DIR/backup.jsonl
RESTIC_CACHE_DIR=$RUN_DIR/restic-cache
export RESTIC_CACHE_DIR
mkdir -m 0700 "$VERIFY_DIR" "$RESTIC_CACHE_DIR"

if [ -n "$SQLITE_STARTED_MARKER" ]; then
  # Test-only observability: report actual destination writes, not the broader
  # restic workflow. The source database is deliberately large in smoke tests.
  (
    while [ ! -s "$STAGING" ]; do
      sleep 0.01
    done
    : >"$SQLITE_STARTED_MARKER"
  ) &
  SQLITE_MARKER_PID=$!
fi

if ! sqlite3 -batch -readonly -cmd '.timeout 30000' "$SOURCE" ".backup '$STAGING'"; then
  fail 'SQLite online backup failed'
fi
if [ -n "$SQLITE_STARTED_MARKER" ]; then
  wait "$SQLITE_MARKER_PID"
  SQLITE_MARKER_PID=
  : >"$SQLITE_FINISHED_MARKER"
fi
[ -f "$STAGING" ] || fail 'SQLite online backup did not create a snapshot'
validate_sqlite "$STAGING"

if ! repository_command backup \
  --stdin \
  --stdin-filename nusend.sqlite \
  --host nusend \
  --tag nusend-db \
  --json <"$STAGING" >"$BACKUP_JSON"; then
  fail 'restic stdin backup failed'
fi

jq -e . "$BACKUP_JSON" >/dev/null || fail 'restic backup returned incomplete JSONL'
SUMMARY_COUNT=$(jq -s '[.[] | select(.message_type == "summary")] | length' "$BACKUP_JSON")
ID_COUNT=$(jq -s '[.[] | select(.message_type == "summary" and (.snapshot_id | type == "string") and (.snapshot_id | length > 0))] | length' "$BACKUP_JSON")
[ "$SUMMARY_COUNT" = "1" ] && [ "$ID_COUNT" = "1" ] || fail 'restic backup did not return exactly one nonempty snapshot_id'
SNAPSHOT_ID=$(jq -rs '[.[] | select(.message_type == "summary") | .snapshot_id][0]' "$BACKUP_JSON")
[ "${#SNAPSHOT_ID}" -eq 64 ] || fail 'restic returned an invalid snapshot_id length'
case "$SNAPSHOT_ID" in *[!0-9a-f]*) fail 'restic returned an invalid snapshot_id' ;; esac

rm -f -- "$STAGING"
[ ! -e "$STAGING" ] || fail 'local staging snapshot could not be deleted'

repository_command restore "$SNAPSHOT_ID" --target "$VERIFY_DIR"
RESTORED=$VERIFY_DIR/nusend.sqlite
[ -f "$RESTORED" ] || fail 'exact snapshot restore did not produce nusend.sqlite'
validate_sqlite "$RESTORED"

repository_command forget \
  --group-by host,paths,tags \
  --keep-within 30d \
  --keep-monthly 12
repository_command prune
repository_command check

printf 'backup: verified snapshot_id=%s\n' "$SNAPSHOT_ID"
