# Troubleshooting

Use the exact Compose and `r2_restic` helpers from [`operations.md`](./operations.md#command-helpers). Do not print protected env files or secret contents while diagnosing.

## Caddy TLS or Full (strict) fails

```sh
dc ps api caddy
dc logs --since 30m --tail 200 caddy
journalctl CONTAINER_TAG=nusend-caddy --since '30 minutes ago' --no-pager
dc exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Check that:

- the proxied DNS hostname equals `NUSEND_DOMAIN` and the Origin CA certificate SAN;
- Cloudflare is set to **Full (strict)**, not Flexible/Full;
- `/etc/nusend/secrets/cloudflare-origin.pem` and `cloudflare-origin-key.pem` are non-empty, root-owned `0600`, and match;
- the certificate is unexpired and covers only the intended hostname;
- Caddy can read its Compose secret mounts and persistent data/config directories;
- both IPv4 and enabled IPv6 firewall lists contain current official Cloudflare ranges.

Do not switch to a public/insecure TLS mode to hide a certificate failure. Origin CA certificates are intentionally not browser-trusted when connecting directly; test through Cloudflare.

## Caddy returns 502

A 502 normally means Caddy cannot reach a healthy `api:3000` container, not an edge TLS failure.

```sh
dc ps api caddy
docker inspect --format '{{json .State.Health}}' "$(dc ps -q api)"
dc exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db'); console.log(r.status,await r.text()); if(!r.ok)process.exit(1)"
dc logs --since 30m --tail 200 api caddy
dc --profile ops run --rm --no-deps migrate \
  bun apps/service/src/db/migrate.ts status
```

Confirm both services share the `nusend` Compose network and Caddy proxies `api:3000`. Do not publish port 3000 as a workaround. External `/health/db` is intentionally 404; use the internal command above.

## Wrong client IP or direct origin is reachable

Caddy trusts forwarding headers only from the versioned Cloudflare CIDRs, gives `CF-Connecting-IP` precedence, and overwrites upstream `X-Forwarded-For` with one canonical address. If logs/rate limits show a proxy address or forged value:

1. compare <https://www.cloudflare.com/ips-v4/> and <https://www.cloudflare.com/ips-v6/> with both `deploy/caddy/Caddyfile` and the host firewall;
2. confirm DNS is proxied and traffic is not bypassing Cloudflare;
3. confirm `trusted_proxies_strict` and `client_ip_headers CF-Connecting-IP X-Forwarded-For` remain configured;
4. test forged forwarding headers from an untrusted source and a valid request through Cloudflare;
5. use the Docker-aware `DOCKER-USER` or nftables forward rules in the deployment runbook—not INPUT/UFW-only assumptions.

From a non-Cloudflare external network, this must fail even with certificate verification disabled:

```sh
curl --fail --insecure --connect-timeout 5 \
  --resolve 'mail.example.com:443:ORIGIN_IPV4' https://mail.example.com/health
```

If it succeeds, treat the origin as exposed. Recheck the public interface match, IPv4 and IPv6 rules, persistence after reboot, and whether Docker's firewall backend changed. Keep an out-of-band console available while repairing rules.

## Migration refuses to start

```sh
dc --profile ops run --rm --no-deps migrate \
  bun apps/service/src/db/migrate.ts status
```

- `pending`: stop API/worker and run the deliberate migration for a reviewed release.
- `changed`: the applied migration checksum differs from the image; stop and restore the matching reviewed image/migration or database. Do not edit the recorded checksum.
- `missing`: the database records a migration absent from the image.

Before launch, `0001_initial_schema.sql` is the editable fresh-database baseline: delete and recreate only disposable local databases after changing it. After launch, applied files are immutable and schema changes use forward `0002+` migrations. For a non-disposable database, preserve the complete stopped DB/WAL/SHM set and use a reviewed exact restore or recreate/import procedure.

A mistyped DB path can create an empty SQLite file. Verify `/etc/nusend/compose.env`, the forced container path `/var/lib/nusend/nusend.sqlite`, host ownership `10001:10001`, directory `0700`, and file `0600` before migrating anything.

## Backup process lock or restic repository lock

The backup's `/var/lib/nusend-backup/.nusend-backup.lock` serializes the complete SQLite/restic process. Exit status 75 means another process owns the non-blocking flock.

```sh
systemctl status --no-pager nusend-backup.service nusend-backup.timer
docker ps --filter label=com.docker.compose.service=backup \
  --format '{{.ID}} {{.Names}} {{.Status}}'
journalctl -u nusend-backup.service --since '24 hours ago' --no-pager
journalctl CONTAINER_TAG=nusend-backup --since '24 hours ago' --no-pager
lsof /var/lib/nusend-backup/.nusend-backup.lock
```

Let a live backup finish. If a process is hung, capture logs/state and stop it deliberately before retrying. Do not delete the flock file to bypass a live lock; ownership is on the open file descriptor.

Inspect restic lock records only through the R2 wrapper:

```sh
r2_restic list locks
r2_restic snapshots --host nusend --tag nusend-db
```

Never run `unlock` blindly and never automate it. First prove no backup, restore, prune, check, or other restic client is running on any host; identify why the lock is stale; preserve diagnostics; then follow restic's version-matched documented stale-lock procedure with explicit operator approval. Removing a live lock can permit concurrent repository mutation and corruption.

## Backup reports missing source, password, or repository

The backup intentionally fails closed and never initializes a missing repository.

- **Source missing/unreadable:** verify `/var/lib/nusend/nusend.sqlite`, owner `10001:10001`, file `0600`, directory `0700`, `NUSEND_DB_DIR=/var/lib/nusend`, and the read-only `/source` mount. Do not point it at a raw copied main file.
- **Password missing/unreadable:** verify the configured `NUSEND_RESTIC_PASSWORD_FILE` exists, is non-empty, owned by `root:10001`, mode `0640`, and matches the off-server escrow. Do not initialize a replacement repository with a new password.
- **Repository/account/bucket missing or placeholder:** verify real `NUSEND_R2_ACCOUNT_ID` and `NUSEND_R2_BUCKET` values in `/etc/nusend/compose.env`; the account ID must be 32 hexadecimal characters and the bucket must already exist and remain private.
- **R2 key missing:** verify both key files are owned by `root:10001`, mode `0640`. R2 keys belong only to backup secrets, never `nusend.env`.

After permission repairs, run the no-content backup-secret readability probe in [deployment step 8](./deployment.md#8-initialize-and-prove-r2-backup-before-enabling-the-timer); never print the values.

After correction, run one on-demand backup and require a full verified snapshot ID plus `r2_restic check` before considering the incident resolved.

## R2 403, region, endpoint, or path-style errors

Confirm the production contract exactly:

```text
RESTIC_REPOSITORY=s3:https://<32-hex-account-id>.r2.cloudflarestorage.com/<private-bucket>/nusend
AWS_DEFAULT_REGION=auto
restic -o s3.bucket-lookup=path <command>
```

Use the `r2_restic` helper for every command. Check that the token belongs to the correct R2 account and is scoped to **Object Read & Write for that bucket only**, the bucket name/endpoint are exact, the host clock is synchronized, and the secret files do not contain accidental whitespace. Jurisdiction-specific R2 buckets require their documented endpoint rather than silently reusing the global endpoint; review the wrapper/config before changing it.

A 403 during prune/delete can mean the token is read-only. Do not broaden it account-wide; grant the selected bucket's required Object Read & Write scope. Do not add an object lifecycle rule or bucket lock—the restic prefix is a mutable multi-object repository.

## SQLite integrity or foreign-key validation fails

The backup/restore gate requires `PRAGMA quick_check` to return exactly `ok` and `PRAGMA foreign_key_check` to return no rows, both before upload and after exact-ID retrieval.

- Do not upload, promote, or cut over to the failed snapshot.
- Preserve the source, staging output, exact snapshot ID, logs, and existing known-good snapshots.
- Keep API/worker stopped for a restore failure; do not delete DB/WAL/SHM sidecars or run repair commands against the only copy.
- Determine whether the live source, restored object, storage, or schema is damaged. Validate a different selected exact ID at a separate path.
- Escalate to a reviewed SQLite recovery/export procedure; `quick_check` success alone does not override foreign-key rows.

Never substitute a raw live DB copy or “latest” snapshot for the failed exact ID.

## systemd service or timer does not run

```sh
systemd-analyze verify /etc/systemd/system/nusend-backup.service \
  /etc/systemd/system/nusend-backup.timer
systemctl daemon-reload
systemctl status --no-pager docker.service nusend-backup.service nusend-backup.timer
systemctl list-timers --all nusend-backup.timer
systemctl show nusend-backup.timer \
  -p ActiveState -p LastTriggerUSec -p NextElapseUSecRealtime
systemctl show nusend-backup.service \
  -p Result -p ExecMainStatus -p InactiveExitTimestamp
journalctl -u nusend-backup.service -u nusend-backup.timer --since '7 days ago' --no-pager
```

Verify `/opt/nusend/compose.yaml`, `/etc/nusend/compose.env`, Docker, backup image, secrets, and fixed `ExecStart` path. `Persistent=true` catches a missed schedule after boot but does not retry a failed backup indefinitely or alert an operator. Test `systemctl start nusend-backup.service` on staging/live only after the R2 repository has been intentionally initialized.

## Journal pressure, missing old logs, or temporary overshoot

```sh
systemd-analyze cat-config systemd/journald.conf
systemctl status --no-pager systemd-journald
journalctl --disk-usage
df -h /var/log/journal
journalctl CONTAINER_TAG=nusend-api --since '1 hour ago' --no-pager
journalctl CONTAINER_TAG=nusend-worker --since '1 hour ago' --no-pager
journalctl CONTAINER_TAG=nusend-caddy --since '1 hour ago' --no-pager
```

The policy is server-wide. Archived logs are eligible for removal when older than 30 days **or** when `SystemMaxUse=1G`/`SystemKeepFree=1G` pressure requires it. High-volume non-Nusend services share the cap. Only archived files are removed, so the active journal may temporarily exceed the target until the configured 64 MiB/one-day rotation boundary.

Do not repeatedly vacuum/rotate away incident evidence. First identify noisy units and free-space pressure. If an approved emergency rotation is required, capture evidence and understand that `journalctl --rotate` changes which files are eligible for cleanup. Changes to retention require a reviewed server-wide capacity decision and `systemctl restart systemd-journald`, followed by status/disk checks.

## Auth config fails

Ensure all required Better Auth variables are set together and `NUSEND_API_KEY_HASH_SECRET` is at least 32 characters. In production, `BETTER_AUTH_URL` and every `NUSEND_AUTH_TRUSTED_ORIGINS` entry must be HTTPS. The current shared env file is also parsed by the worker, so partial auth config can stop either service.

## API key rejected

- `401 unauthenticated`: the key is invalid, revoked, expired, or hashed with a different `NUSEND_API_KEY_HASH_SECRET`.
- `403 forbidden`: the key is valid but lacks the route permission.

## CLI state permissions rejected

On Unix, Nusend refuses broad state-directory/file permissions. Run `nusend config repair-permissions` (directory `0700`; `state.json` `0600`).

## CLI state file corrupt or unreadable

`state.json` holds one service URL and credential. Login may replace readable malformed JSON/schema after authorization, but filesystem failures and broad Unix permissions fail closed without changing bytes. Other stored-state commands require a valid file; delete a malformed disposable file and log in again. With both `NUSEND_API_KEY` and a base URL from `--base-url` or `NUSEND_BASE_URL`, the CLI bypasses disk entirely.

Concurrent CLI mutation is unsupported. Each write is still atomic, so the last completed writer wins without exposing partial JSON.

## Device login stuck

Check the activation URL, expiry, approval status, and `429 Retry-After` responses. The CLI obeys server pacing with a 1000 ms minimum and sends no token request at or after local expiry. Early server polls return `slow_down` without consuming durable poll state.

Outstanding grants are unexpired, non-denied, and non-consumed; approved-but-unconsumed grants still count toward the durable 30-global/5-per-fingerprint limits. Process-local token ceilings are 120 requests/minute per source and 600/minute globally with at most 1024 active source keys per process. Start and token limiter state resets on service restart and is independent per service process.

## Ambiguous delivery

`ambiguous` means SES acceptance is unknown and automatic processing is finished; it is not a known failure and must not be retried automatically. Inspect the delivery and exact attempt through operations endpoints. Only authoritative SES MessageId proof for that same latest attempt can reconcile it to sent; there is no operator reconciliation API yet.

## SES issues

Use SES readiness and operations HTTP routes to inspect configuration-set, SNS, delivery, bounce, complaint, and ambiguity state. CLI wrappers are planned for a follow-up.

Generic SES internal/server/service-unavailable errors and HTTP `500`–`599` outcomes are terminal `ambiguous`: SES acceptance may be unknown, so they must not be automatically retried. Inspect the delivery and exact attempt instead. Explicit pre-connect DNS/connect failures and throttle/quota refusals remain retryable; named permanent SES rejections remain permanent.

For SNS callback failures, verify the exact POST endpoint, proxied DNS, cache bypass, method/path-limited challenge skip, topic ARN allowlist, SignatureVersion 2, DLQ/alarms, and egress to SNS signing-certificate/confirmation URLs. Do not disable signature validation or broadly bypass WAF protections.
