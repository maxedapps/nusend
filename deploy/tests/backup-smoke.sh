#!/bin/sh
set -eu

BACKUP_IMAGE=${NUSEND_BACKUP_SMOKE_IMAGE:-nusend-backup:phase3}
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/nusend-backup-smoke.XXXXXX")
SUFFIX=$$
KEEPER="nusend-backup-keeper-$SUFFIX"
WRITER="nusend-backup-writer-$SUFFIX"
LOCKER="nusend-backup-locker-$SUFFIX"
RUNNER="nusend-backup-runner-$SUFFIX"
OVERLAP_VOLUME="nusend-backup-overlap-$SUFFIX"

cleanup() {
  docker rm -f "$RUNNER" "$LOCKER" "$WRITER" "$KEEPER" >/dev/null 2>&1 || true
  docker volume rm -f "$OVERLAP_VOLUME" >/dev/null 2>&1 || true
  if [ -d "$ROOT" ]; then
    docker run --rm --user 0:0 --entrypoint sh -v "$ROOT:/test" "$BACKUP_IMAGE" \
      -c 'chmod -R 0777 /test 2>/dev/null || true' >/dev/null 2>&1 || true
    rm -rf "$ROOT"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'backup smoke: %s\n' "$1" >&2
  exit 1
}

wait_for_file() {
  container=$1
  path=$2
  attempts=0
  while [ "$attempts" -lt 100 ]; do
    if docker exec "$container" test -f "$path" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  fail "timed out waiting for $path in $container"
}

run_sqlite() {
  source_dir=$1
  shift
  docker run --rm --user 10001:10001 --entrypoint sqlite3 \
    -v "$source_dir:/source" "$BACKUP_IMAGE" -cmd '.timeout 30000' "$@"
}

run_backup() {
  source_dir=$1
  work_dir=$2
  repository=$3
  password=$4
  docker run --rm --name "$RUNNER" --user 10001:10001 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
    -e NUSEND_BACKUP_SOURCE=/source/nusend.sqlite \
    -e NUSEND_BACKUP_WORK_DIR=/work \
    -e NUSEND_BACKUP_TEST_ONLY=1 \
    -e NUSEND_BACKUP_TEST_ONLY_LOCAL_REPOSITORY=/repo \
    -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -v "$source_dir:/source:ro" \
    -v "$work_dir:/work" \
    -v "$repository:/repo" \
    -v "$password:/run/restic-password:ro" \
    "$BACKUP_IMAGE"
}

start_marked_backup() {
  source_dir=$1
  work_dir=$2
  repository=$3
  password=$4
  docker run -d --name "$RUNNER" --user 10001:10001 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
    -e NUSEND_BACKUP_SOURCE=/source/nusend.sqlite \
    -e NUSEND_BACKUP_WORK_DIR=/work \
    -e NUSEND_BACKUP_TEST_ONLY=1 \
    -e NUSEND_BACKUP_TEST_ONLY_LOCAL_REPOSITORY=/repo \
    -e NUSEND_BACKUP_TEST_ONLY_SQLITE_MARKERS=1 \
    -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -v "$source_dir:/source:ro" \
    -v "$work_dir:/work" \
    -v "$repository:/repo" \
    -v "$password:/run/restic-password:ro" \
    "$BACKUP_IMAGE"
}

restic_local() {
  repository=$1
  password=$2
  shift 2
  docker run --rm --user 10001:10001 --entrypoint restic \
    -e RESTIC_REPOSITORY=/repo \
    -e RESTIC_PASSWORD_FILE=/run/restic-password \
    -e RESTIC_CACHE_DIR=/tmp/restic-cache \
    -v "$repository:/repo" \
    -v "$password:/run/restic-password:ro" \
    "$BACKUP_IMAGE" "$@"
}

mkdir -p \
  "$ROOT/source" "$ROOT/work" "$ROOT/repository" "$ROOT/restore" "$ROOT/cache" \
  "$ROOT/missing-source" "$ROOT/missing-source-work" "$ROOT/missing-password-work" \
  "$ROOT/corrupt-source" "$ROOT/corrupt-work" "$ROOT/fk-source" "$ROOT/fk-work" \
  "$ROOT/damaged-source" "$ROOT/damaged-work" "$ROOT/damaged-repository" \
  "$ROOT/overlap-work"
printf '%s\n' 'local-smoke-restic-password' >"$ROOT/restic-password"
printf '%s\n' 'not a sqlite database' >"$ROOT/corrupt-source/nusend.sqlite"

docker run --rm --user 0:0 --entrypoint sh -v "$ROOT:/test" "$BACKUP_IMAGE" -c '
  chown -R 10001:10001 /test
  find /test -type d -exec chmod 0700 {} +
  chmod 0600 /test/restic-password /test/corrupt-source/nusend.sqlite
'

restic_local "$ROOT/repository" "$ROOT/restic-password" init >/dev/null

run_sqlite "$ROOT/source" /source/nusend.sqlite '
  PRAGMA page_size=4096;
  PRAGMA journal_mode=WAL;
  CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO events(value) VALUES(char(98,97,115,101));
  CREATE TABLE backup_padding(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
  WITH RECURSIVE rows(id) AS (
    VALUES(1) UNION ALL SELECT id + 1 FROM rows WHERE id < 65536
  )
  INSERT INTO backup_padding(id, payload) SELECT id, zeroblob(8192) FROM rows;
'

docker run -d --name "$KEEPER" --user 10001:10001 --entrypoint sh \
  -v "$ROOT/source:/source" "$BACKUP_IMAGE" -c '
    sqlite3 -batch -cmd ".timeout 30000" /source/nusend.sqlite <<"SQL"
PRAGMA journal_mode=WAL;
PRAGMA wal_autocheckpoint=0;
BEGIN IMMEDIATE;
INSERT INTO events(value) VALUES(char(119,97,108,45,111,110,108,121));
COMMIT;
.shell touch /source/keeper.ready
.shell sleep 180
SELECT count(*) FROM events WHERE value = char(119,97,108,45,111,110,108,121);
SQL
  ' >/dev/null
wait_for_file "$KEEPER" /source/keeper.ready

docker exec "$KEEPER" test -s /source/nusend.sqlite-wal || fail 'live WAL was not present'
LIVE_COUNT=$(run_sqlite "$ROOT/source" -batch -readonly /source/nusend.sqlite \
  'SELECT count(*) FROM events WHERE value = char(119,97,108,45,111,110,108,121);')
[ "$LIVE_COUNT" = "1" ] || fail 'committed WAL row was not visible through the live database'
MAIN_ONLY_COUNT=$(run_sqlite "$ROOT/source" -batch -readonly \
  'file:/source/nusend.sqlite?immutable=1' \
  'SELECT count(*) FROM events WHERE value = char(119,97,108,45,111,110,108,121);')
[ "$MAIN_ONLY_COUNT" = "0" ] || fail 'test row was not confined to the live WAL'

docker run -d --name "$WRITER" --user 10001:10001 --entrypoint sh \
  -v "$ROOT/source:/source" -v "$ROOT/work:/work:ro" "$BACKUP_IMAGE" -c '
    attempts=0
    while [ ! -f /work/.nusend-backup-test-sqlite-started ]; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 3000 ] || exit 90
      sleep 0.01
    done
    [ ! -e /work/.nusend-backup-test-sqlite-finished ] || exit 91
    sqlite3 -batch -cmd ".timeout 30000" /source/nusend.sqlite \
      "BEGIN IMMEDIATE; INSERT INTO events(value) VALUES(char(99,111,110,99,117,114,114,101,110,116,45,100,117,114,105,110,103,45,98,97,99,107,117,112)); COMMIT;"
    [ ! -e /work/.nusend-backup-test-sqlite-finished ] || exit 92
    touch /source/writer.committed
  ' >/dev/null
start_marked_backup "$ROOT/source" "$ROOT/work" "$ROOT/repository" \
  "$ROOT/restic-password" >/dev/null
WRITER_STATUS=$(docker wait "$WRITER")
if [ "$WRITER_STATUS" != "0" ]; then
  docker logs "$WRITER" >&2 || true
  fail "writer did not commit during SQLite .backup (status $WRITER_STATUS)"
fi
[ -f "$ROOT/source/writer.committed" ] \
  || fail 'writer did not record a commit during SQLite .backup'
FIRST_STATUS=$(docker wait "$RUNNER")
FIRST_OUTPUT=$(docker logs "$RUNNER" 2>&1 || true)
docker rm "$WRITER" "$RUNNER" >/dev/null
[ "$FIRST_STATUS" = "0" ] || fail "first backup failed (status $FIRST_STATUS)"
printf '%s\n' "$FIRST_OUTPUT"
FIRST_ID=$(printf '%s\n' "$FIRST_OUTPUT" | sed -n 's/^backup: verified snapshot_id=\([0-9a-f][0-9a-f]*\)$/\1/p')
[ "${#FIRST_ID}" -eq 64 ] || fail 'first backup did not report one full snapshot ID'

run_sqlite "$ROOT/source" /source/nusend.sqlite \
  'INSERT INTO events(value) VALUES(char(115,101,99,111,110,100,45,111,110,108,121));'
SECOND_OUTPUT=$(run_backup "$ROOT/source" "$ROOT/work" "$ROOT/repository" "$ROOT/restic-password")
printf '%s\n' "$SECOND_OUTPUT"
SECOND_ID=$(printf '%s\n' "$SECOND_OUTPUT" | sed -n 's/^backup: verified snapshot_id=\([0-9a-f][0-9a-f]*\)$/\1/p')
[ "${#SECOND_ID}" -eq 64 ] || fail 'second backup did not report one full snapshot ID'
[ "$FIRST_ID" != "$SECOND_ID" ] || fail 'multiple backups unexpectedly produced one snapshot ID'

docker run --rm --user 10001:10001 --entrypoint restic \
  -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD_FILE=/run/restic-password \
  -v "$ROOT/repository:/repo" -v "$ROOT/restic-password:/run/restic-password:ro" \
  -v "$ROOT/restore:/restore" -v "$ROOT/cache:/cache" \
  "$BACKUP_IMAGE" --cache-dir /cache restore "$FIRST_ID" --target /restore >/dev/null
RESTORED_WAL_COUNT=$(run_sqlite "$ROOT/restore" -batch -readonly /source/nusend.sqlite \
  'SELECT count(*) FROM events WHERE value = char(119,97,108,45,111,110,108,121);')
[ "$RESTORED_WAL_COUNT" = "1" ] || fail 'non-latest exact-ID restore lost the WAL-only row'
RESTORED_BASE_COUNT=$(run_sqlite "$ROOT/restore" -batch -readonly /source/nusend.sqlite \
  'SELECT count(*) FROM events WHERE value = char(98,97,115,101);')
[ "$RESTORED_BASE_COUNT" = "1" ] || fail 'non-latest exact-ID restore lost first-state data'
RESTORED_SECOND_COUNT=$(run_sqlite "$ROOT/restore" -batch -readonly /source/nusend.sqlite \
  'SELECT count(*) FROM events WHERE value = char(115,101,99,111,110,100,45,111,110,108,121);')
[ "$RESTORED_SECOND_COUNT" = "0" ] \
  || fail 'non-latest exact-ID restore substituted the newer snapshot'

STALE_RUNS=$(docker run --rm --user 10001:10001 --entrypoint sh \
  -v "$ROOT/work:/work:ro" "$BACKUP_IMAGE" -c \
  'find /work -mindepth 1 -maxdepth 1 -type d -name ".nusend-backup.*" | wc -l')
[ "$STALE_RUNS" = "0" ] || fail 'a staging or verification run path survived cleanup'

restic_local "$ROOT/repository" "$ROOT/restic-password" snapshots --json >"$ROOT/snapshots.json"
docker run --rm --entrypoint jq -v "$ROOT:/test:ro" "$BACKUP_IMAGE" \
  -e --arg newest "$SECOND_ID" '
    length >= 2
    and ([.[] | {hostname, paths, tags}] | unique | length == 1)
    and (all(.[]; .hostname == "nusend" and .paths == ["/nusend.sqlite"] and .tags == ["nusend-db"]))
    and (any(.[]; .id == $newest))
    and ((max_by(.time)).id == $newest)
  ' /test/snapshots.json >/dev/null || fail 'retention group or newest-snapshot invariant failed'
BASELINE_COUNT=$(docker run --rm --entrypoint jq -v "$ROOT:/test:ro" "$BACKUP_IMAGE" \
  -r 'length' /test/snapshots.json)

if docker run --rm --user 10001:10001 --read-only --tmpfs /tmp \
  -e NUSEND_BACKUP_SOURCE=/source/nusend.sqlite \
  -e NUSEND_BACKUP_WORK_DIR=/work \
  -e NUSEND_BACKUP_TEST_ONLY=1 \
  -e NUSEND_BACKUP_TEST_ONLY_LOCAL_REPOSITORY=/repo \
  -e RESTIC_PASSWORD_FILE=/run/restic-password \
  -v "$ROOT/missing-source:/source:ro" -v "$ROOT/missing-source-work:/work" \
  -v "$ROOT/repository:/repo" -v "$ROOT/restic-password:/run/restic-password:ro" \
  "$BACKUP_IMAGE" >"$ROOT/missing-source.log" 2>&1; then
  fail 'missing source did not fail closed'
fi

if docker run --rm --user 10001:10001 --read-only --tmpfs /tmp \
  -e NUSEND_BACKUP_SOURCE=/source/nusend.sqlite \
  -e NUSEND_BACKUP_WORK_DIR=/work \
  -e RESTIC_PASSWORD_FILE=/run/restic-password \
  -v "$ROOT/source:/source:ro" -v "$ROOT/missing-source-work:/work" \
  -v "$ROOT/restic-password:/run/restic-password:ro" \
  "$BACKUP_IMAGE" >"$ROOT/missing-repository.log" 2>&1; then
  fail 'missing production repository identifiers did not fail closed'
fi

if docker run --rm --user 10001:10001 --read-only --tmpfs /tmp \
  -e NUSEND_BACKUP_SOURCE=/source/nusend.sqlite \
  -e NUSEND_BACKUP_WORK_DIR=/work \
  -e NUSEND_BACKUP_TEST_ONLY=1 \
  -e NUSEND_BACKUP_TEST_ONLY_LOCAL_REPOSITORY=/repo \
  -e RESTIC_PASSWORD_FILE=/run/missing-password \
  -v "$ROOT/source:/source:ro" -v "$ROOT/missing-password-work:/work" \
  -v "$ROOT/repository:/repo" \
  "$BACKUP_IMAGE" >"$ROOT/missing-password.log" 2>&1; then
  fail 'missing restic password did not fail closed'
fi

if run_backup "$ROOT/corrupt-source" "$ROOT/corrupt-work" "$ROOT/repository" \
  "$ROOT/restic-password" >"$ROOT/corrupt-source.log" 2>&1; then
  fail 'corrupt SQLite source did not fail closed'
fi

run_sqlite "$ROOT/fk-source" /source/nusend.sqlite '
  PRAGMA foreign_keys=OFF;
  CREATE TABLE parents(id INTEGER PRIMARY KEY);
  CREATE TABLE children(
    id INTEGER PRIMARY KEY,
    parent_id INTEGER NOT NULL REFERENCES parents(id)
  );
  INSERT INTO children(id, parent_id) VALUES(1, 999);
'
if run_backup "$ROOT/fk-source" "$ROOT/fk-work" "$ROOT/repository" \
  "$ROOT/restic-password" >"$ROOT/fk-violation.log" 2>&1; then
  fail 'staged SQLite foreign-key violation did not fail closed'
fi
grep -F 'SQLite foreign_key_check returned rows' "$ROOT/fk-violation.log" >/dev/null \
  || fail 'foreign-key violation did not reach staged snapshot validation'

run_sqlite "$ROOT/damaged-source" /source/nusend.sqlite '
  CREATE TABLE isolated_data(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO isolated_data(value) VALUES(char(105,115,111,108,97,116,101,100));
'
restic_local "$ROOT/damaged-repository" "$ROOT/restic-password" init >/dev/null
DAMAGED_INITIAL_OUTPUT=$(run_backup "$ROOT/damaged-source" "$ROOT/damaged-work" \
  "$ROOT/damaged-repository" "$ROOT/restic-password")
DAMAGED_INITIAL_ID=$(printf '%s\n' "$DAMAGED_INITIAL_OUTPUT" \
  | sed -n 's/^backup: verified snapshot_id=\([0-9a-f][0-9a-f]*\)$/\1/p')
[ "${#DAMAGED_INITIAL_ID}" -eq 64 ] \
  || fail 'isolated repository did not receive a verified snapshot before damage'
DAMAGED_SNAPSHOT_COUNT=$(restic_local "$ROOT/damaged-repository" \
  "$ROOT/restic-password" snapshots --json | docker run --rm -i --entrypoint jq \
  "$BACKUP_IMAGE" -r 'length')
[ "$DAMAGED_SNAPSHOT_COUNT" = "1" ] \
  || fail 'isolated repository did not contain exactly one successful snapshot'
DAMAGED_PACK_COUNT=$(docker run --rm --user 10001:10001 --entrypoint sh \
  -v "$ROOT/damaged-repository:/repo" "$BACKUP_IMAGE" -c '
    count=0
    for pack in /repo/data/*/*; do
      [ -f "$pack" ] || continue
      : >"$pack"
      count=$((count + 1))
    done
    printf "%s\n" "$count"
  ')
[ "$DAMAGED_PACK_COUNT" -gt 0 ] \
  || fail 'isolated repository snapshot had no data packs to damage'
if run_backup "$ROOT/damaged-source" "$ROOT/damaged-work" \
  "$ROOT/damaged-repository" "$ROOT/restic-password" \
  >"$ROOT/damaged-repository.log" 2>&1; then
  fail 'damaged pack data in initialized isolated repository did not fail closed'
fi

docker volume create "$OVERLAP_VOLUME" >/dev/null
docker run --rm --user 0:0 --entrypoint chown -v "$OVERLAP_VOLUME:/work" \
  "$BACKUP_IMAGE" 10001:10001 /work
docker run -d --name "$LOCKER" --user 10001:10001 --entrypoint flock \
  -v "$OVERLAP_VOLUME:/work" "$BACKUP_IMAGE" -n /work/.nusend-backup.lock \
  sh -c 'touch /work/lock.ready; sleep 180' >/dev/null
wait_for_file "$LOCKER" /work/lock.ready
set +e
docker run --rm --name "$RUNNER" --user 10001:10001 --read-only --tmpfs /tmp \
  -e NUSEND_BACKUP_SOURCE=/source/nusend.sqlite \
  -e NUSEND_BACKUP_WORK_DIR=/work \
  -e NUSEND_BACKUP_TEST_ONLY=1 \
  -e NUSEND_BACKUP_TEST_ONLY_LOCAL_REPOSITORY=/repo \
  -e NUSEND_BACKUP_INTERNAL_LOCKED=1 \
  -e RESTIC_PASSWORD_FILE=/run/restic-password \
  -v "$ROOT/source:/source:ro" -v "$OVERLAP_VOLUME:/work" \
  -v "$ROOT/repository:/repo" -v "$ROOT/restic-password:/run/restic-password:ro" \
  "$BACKUP_IMAGE" >"$ROOT/overlap.log" 2>&1
OVERLAP_STATUS=$?
set -e
[ "$OVERLAP_STATUS" = "75" ] \
  || fail "caller lock-bypass environment did not return lock status 75 (got $OVERLAP_STATUS)"
docker rm -f "$LOCKER" >/dev/null
docker volume rm "$OVERLAP_VOLUME" >/dev/null

restic_local "$ROOT/repository" "$ROOT/restic-password" snapshots --json >"$ROOT/final-snapshots.json"
FINAL_COUNT=$(docker run --rm --entrypoint jq -v "$ROOT:/test:ro" "$BACKUP_IMAGE" \
  -r 'length' /test/final-snapshots.json)
[ "$FINAL_COUNT" = "$BASELINE_COUNT" ] || fail 'failure-path tests changed the main repository'
docker run --rm --entrypoint jq -v "$ROOT:/test:ro" "$BACKUP_IMAGE" \
  -e --arg newest "$SECOND_ID" 'any(.[]; .id == $newest)' /test/final-snapshots.json >/dev/null \
  || fail 'newest verified snapshot did not survive failure-path tests'

printf 'backup smoke: PASS (%s, %s)\n' "$FIRST_ID" "$SECOND_ID"
