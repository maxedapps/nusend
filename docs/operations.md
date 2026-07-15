# Operations

Run from `/opt/nusend` as an operator with Docker/root access. The canonical deploy/update/restore order is in [`deployment.md`](./deployment.md).

## Command helpers

Every Compose command must use the protected interpolation file and exact Compose file. Add `--profile ops` for `migrate` and `backup`:

```sh
cd /opt/nusend
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
```

For direct R2 inspection, use this wrapper. It reads backup-only secrets inside the backup container and supplies the required path-style option to **every** restic command:

```sh
r2_restic() {
  dc --profile ops run --rm --no-deps --entrypoint sh backup -ceu '
    export AWS_ACCESS_KEY_ID="$(cat "$AWS_ACCESS_KEY_ID_FILE")"
    export AWS_SECRET_ACCESS_KEY="$(cat "$AWS_SECRET_ACCESS_KEY_FILE")"
    export AWS_DEFAULT_REGION=auto
    export RESTIC_REPOSITORY="s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/nusend"
    exec restic -o s3.bucket-lookup=path "$@"
  ' sh "$@"
}
```

Do not replace the wrapper with bare `restic`, omit `-o s3.bucket-lookup=path`, initialize automatically, or unlock automatically.

## Service and health status

```sh
dc ps
dc --profile ops ps --all
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' \
  "$(dc ps -q api)"
dc exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db'); console.log(r.status,await r.text()); if(!r.ok)process.exit(1)"
curl --fail --show-error --silent https://mail.example.com/health
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  https://mail.example.com/health/db   # expected 404
dc --profile ops run --rm --no-deps migrate \
  bun apps/service/src/db/migrate.ts status
```

Migration status must show `applied  0001_initial_schema` and no `pending`, `changed`, or `missing`. There must be exactly one API and one worker; only Caddy may publish TCP 80/443, and port 3000 must not be published.

Useful authenticated inspection routes:

- `GET /api/operations/summary`
- `GET /api/operations/deliveries?issue=failed_or_ambiguous`
- `GET /api/operations/deliveries/:id`
- `GET /api/operations/ses/readiness`
- `GET /api/operations/ses/events`
- `GET /api/operations/ses/simulator-runs`

Use an owner session or a least-privilege API key with `operations:read`. `ambiguous` is terminal: provider acceptance is unknown and automatic retry is forbidden. Inspect the exact attempt; only authoritative SES MessageId evidence for that same latest attempt can reconcile it to sent. A dead job remains incident history.

## Compose and journal logs

Compose logs remain available with the journald logging driver:

```sh
dc logs --since 30m --timestamps api worker caddy
dc logs --since 30m --timestamps --tail 200 api
dc logs --since 30m --timestamps --tail 200 worker
dc logs --since 30m --timestamps --tail 200 caddy
```

Every service has a stable `CONTAINER_TAG`. One-shot `run --rm` migration/backup containers are removed, so use their persistent journal tags rather than relying on `compose logs` for past runs:

```sh
journalctl CONTAINER_TAG=nusend-api --since '30 minutes ago' --no-pager
journalctl CONTAINER_TAG=nusend-worker --since '30 minutes ago' --no-pager
journalctl CONTAINER_TAG=nusend-caddy --since '30 minutes ago' --no-pager
journalctl CONTAINER_TAG=nusend-migrate --since '24 hours ago' --no-pager
journalctl CONTAINER_TAG=nusend-backup --since '24 hours ago' --no-pager
journalctl -u nusend-backup.service --since '24 hours ago' --no-pager
```

For a bounded live view, use `journalctl ... -f` and stop it with Ctrl-C. Do not log or paste raw API keys, device/user codes, cookies, unsubscribe tokens, recipient vars, mailing HTML, OAuth query data, Origin/R2/restic secrets, or raw SES/SNS payloads.

The installed journal policy is server-wide. Old archived files are removed when records exceed 30 days **or** `SystemMaxUse=1G`/`SystemKeepFree=1G` pressure applies. The active file can temporarily exceed the bound until rotation; `SystemMaxFileSize=64M` and `MaxFileSec=1day` bound granularity.

```sh
systemd-analyze cat-config systemd/journald.conf
systemctl is-active systemd-journald
journalctl --disk-usage
journalctl --list-boots
```

## Backup status, age, and repository checks

Check both timer scheduling and the last unit result:

```sh
systemctl status --no-pager nusend-backup.timer nusend-backup.service
systemctl show nusend-backup.timer \
  -p ActiveState -p LastTriggerUSec -p NextElapseUSecRealtime
systemctl show nusend-backup.service \
  -p ActiveState -p Result -p ExecMainStatus -p InactiveExitTimestamp
systemctl list-timers --all nusend-backup.timer
journalctl -u nusend-backup.service --since '7 days ago' --no-pager
```

The timer is daily at 03:00 UTC, persistent across downtime, with up to 15 minutes randomized delay. Alert when the latest successful unit/snapshot is older than the approved interval; a merely active timer is not evidence of a successful backup.

Inspect exact remote snapshots and repository integrity. Every command below goes through `r2_restic`, so the R2 option is never omitted:

```sh
r2_restic snapshots --host nusend --tag nusend-db
r2_restic snapshots --json --host nusend --tag nusend-db
r2_restic check
r2_restic stats --mode raw-data --host nusend --tag nusend-db
```

A normal backup journal ends with one full `backup: verified snapshot_id=<64 hex characters>`. It must also complete exact-ID remote restore/SQLite verification, retention, prune, and `restic check`; do not count a partial upload as success.

### On-demand verified backup

Run before every update or other risky operation and record the new exact snapshot ID:

```sh
dc --profile ops run --rm --no-deps backup
r2_restic snapshots --host nusend --tag nusend-db
```

The direct Compose run appears under the `nusend-backup` container tag rather than necessarily as a new systemd service invocation:

```sh
journalctl CONTAINER_TAG=nusend-backup --since '1 hour ago' --no-pager
```

Never copy a live SQLite file as a backup. Nusend's backup service uses SQLite's online `.backup`, validates locally, uploads to encrypted restic, restores the captured exact ID, revalidates, then applies retention.

## Disk and SQLite capacity

```sh
df -h /var/lib/nusend /var/lib/nusend-backup /var/lib/nusend-caddy /var/log/journal
du -sh /var/lib/nusend /var/lib/nusend-backup /var/lib/nusend-caddy /var/log/journal
find /var/lib/nusend -maxdepth 1 -type f \
  -name 'nusend.sqlite*' -printf '%f %s bytes\n' | sort
stat -c '%U:%G %a %s %n' /var/lib/nusend/nusend.sqlite
journalctl --disk-usage
```

Track `nusend.sqlite`, `nusend.sqlite-wal`, and `nusend.sqlite-shm` separately. WAL size can fluctuate and is not itself corruption. Do not delete/checkpoint/copy sidecars while any API, worker, migration, backup, bootstrap, or SQLite handle may be open. Capacity monitoring must also include SES event/notification growth and enough free space for SQLite activity and an in-directory restore staging file.

## Restore drills

- Complete an initial exact-ID drill to a separate path/server before enabling the backup timer.
- Repeat quarterly and after material backup/restic/R2 changes.
- Select and record a full snapshot ID; never use `latest` as the restore selector.
- Restore inside a separate target filesystem/path, run `PRAGMA quick_check`, require no `PRAGMA foreign_key_check` rows, run migration status, and query known data.
- Record snapshot time/ID, operator, recovery duration, queried evidence, and cleanup. A drill must not replace live DB names.

Use the exact commands and cautions in [`deployment.md`](./deployment.md#11-exact-database-restore). If a drill cannot decrypt, restore, validate, or query the snapshot, treat backup readiness as failed and leave the timer/release gate unresolved.

## Routine update cues

Before an app, Caddy, restic, base-image, Cloudflare-IP, Docker, or host update:

1. run and verify an on-demand backup;
2. retain the current app and dependency digests;
3. stage/test the new pins and both firewall/Caddy IP lists;
4. follow the stop-worker, stop-API, deliberate-migration, API/Caddy-health, start-worker order;
5. recheck logs, direct-origin rejection, client IP, timer, and a worker cycle.

Rollback must use the retained full-bundle transaction in [`deployment.md`](./deployment.md#10-production-update-and-rollback-transaction): prior checkout, Compose/Caddy files, immutable app and backup digests, systemd units, and changed firewall state. Proceed only when the current schema is compatible; never assume a destructive DB rollback is safe.
