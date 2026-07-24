# Deploy and operate Nusend

Nusend is pre-launch, self-hosted software. Use the guided setup for a first installation, then use the direct Compose procedures here for runtime inspection, updates, and recovery. Complete the [pre-volume gates](#pre-volume-gates) before broad marketing use.

## Guided first-time setup

### Workstation and VPS requirements

Run setup from a trusted Unix or WSL workstation with Node 22+, pnpm 11, Git, AWS CLI v2, OpenSSH, and curl. Native Windows is unsupported; use WSL. The AWS profile must resolve to the expected account and region and should be a temporary provisioning principal using the policy described in the [AWS setup guide](./aws-setup.md).

The VPS needs only:

- an SSH server with normal host-key verification;
- Git for the exact-tag checkout and identity checks;
- Docker Engine and Docker Compose 5.3.0 or newer;
- a supported x86-64 or ARM64 architecture;
- a public DNS name and provider firewall control.

Node, pnpm, AWS CLI, and the Nusend CLI are not required on the VPS. Verify the SSH host key out of band before first connection. Setup accepts normal `StrictHostKeyChecking=yes` or `accept-new`; it never disables host-key verification.

### Protected state and environment

Each installation lives under:

```text
${NUSEND_SETUP_HOME:-~/.config/nusend/setup}/<installation-id>/
```

The installation directory is mode `0700`; `state.json` and `deployment.env` are atomically written mode `0600`. `state.json` contains resumable non-secret choices/evidence. `deployment.env` is the exhaustive Compose environment and contains generated/provider secrets. Sanitized plans contain no secrets. `NUSEND_SETUP_INSTALLATION` selects an installation; otherwise the protected `current` pointer is used.

Setup transfers `deployment.env` over SSH stdin to a mode-`0600` temporary file and atomically installs remote `.env`; secrets do not appear in command arguments or logs. Independently escrow the generated restic password in an off-server password manager. Losing it makes every backup unreadable. Keep AWS application keys separate from R2 keys, and never commit or paste either environment file.

### Run the workflow

From a trusted checkout:

```sh
pnpm nusend:setup init
pnpm nusend:setup doctor
pnpm nusend:setup continue
pnpm nusend:setup status
```

`init` records the exact release tag, domain/ingress, owner, provider choices, AWS context, SSH target, and absolute remote path; it collects provider secrets without echo and generates application/restic secrets. `doctor` is read-only. Each `continue` performs at most one eligible stage, checkpoints verified evidence, or prints one external action and stops. Rerun it after completing the reported gate. `status` reads local state only; request live provider/remote evidence explicitly:

```sh
pnpm nusend:setup status --refresh
```

The coordinator resolves the release tag to an exact commit. It either clones into an empty remote directory or accepts an existing clean checkout at that exact tag, commit, and repository origin. It refuses moved tags, dirty/mismatched checkouts, unexpected image revision labels, and unsafe paths. It runs Compose config, pull, startup, and health checks, but does not install Docker or alter external DNS/firewalls.

### External gates

The operator must still provide and verify:

- a Google OAuth **Web application** with origin `https://<domain>` and redirect `https://<domain>/api/auth/callback/google`;
- public DNS and inbound TCP 80/443 for direct ingress, or proxied Cloudflare DNS with Full (strict) and origin access restricted to current Cloudflare ranges;
- a private R2 bucket and an Object Read & Write token scoped only to that bucket;
- restic-password escrow, external DKIM records when Route 53 is not selected, SES approval, alarm-email confirmation, and an exercised alarm;
- backup restore, reboot recovery, DMARC/inbox checks, and quota/ramp review.

See [AWS setup and CloudFormation safety](./aws-setup.md) for the reviewed core/finalize change sets, honest SES application brief, validation, DLQ handling, and destroy retention boundary.

## Runtime health and direct Compose operations

The guided deploy runs these checks. They remain useful for runtime inspection and recovery from the tagged checkout on the VPS:

```sh
DOMAIN=mail.example.com
docker compose up -d --wait
docker compose ps
curl -fsS "https://${DOMAIN}/health"
test "$(curl -sS -o /dev/null -w '%{http_code}' "https://${DOMAIN}/health/db")" = 404
docker compose exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db');if(!r.ok)process.exit(1)"
```

Compose fixes volume ownership, migrates the database, reconciles the sole owner, and completes an initial off-site backup before becoming healthy. Public database health must remain hidden. Sign in through Google as the configured owner.

Inspect services and bounded local-driver logs with:

```sh
docker compose ps
docker compose logs --since 30m --timestamps api worker caddy backup
```

Never log or paste API keys, OAuth credentials/codes, cookies, recipient data, message bodies, unsubscribe tokens, R2/restic secrets, raw SNS JSON, or full diagnostic payloads. The application does not consume or replay DLQ messages; investigate and deliberately replay only after remediation.

## Source-built CLI

Build the private CLI on a trusted Node/pnpm workstation that can reach the deployed URL—not on the VPS:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
./apps/cli/dist/main.js login https://mail.example.com
./apps/cli/dist/main.js whoami
```

There is no global-install requirement. Built-in CLI help is its command catalog. Use `--json` for automation. CLI config directories/state also fail closed unless their Unix modes are `0700`/`0600`.

Common operational reads are:

```sh
./apps/cli/dist/main.js operations summary
./apps/cli/dist/main.js deliveries list --issue failed_or_ambiguous
./apps/cli/dist/main.js ses summary
./apps/cli/dist/main.js ses events list
```

An `ambiguous` delivery is terminal because provider acceptance is unknown; never treat it as normally retryable.

## Backup and restore

The mandatory backup service uses SQLite online backup, validates the copy, initializes an absent restic repository only for the expected absent-repository result, retains 30 daily and 12 monthly snapshots, and runs about every 24 hours. Backup failure makes the service unhealthy.

```sh
docker compose ps backup
docker compose logs --since 24h backup
docker compose run --rm --no-deps backup run
docker compose run --rm --no-deps --entrypoint sh backup -c \
  'export RESTIC_CACHE_DIR=/work/.restic-cache; restic -o s3.bucket-lookup=path snapshots --host nusend --tag nusend-db'
```

Restore only an explicit 64-character lowercase hexadecimal snapshot ID; `latest` is rejected. Stop every service first:

```sh
docker compose stop api worker caddy backup
docker compose run --rm --no-deps backup restore <64-lowercase-hex-snapshot-id>
docker compose up -d --wait
curl -fsS "https://${DOMAIN}/health"
```

Restore validates SQLite and preserves the former live database as `nusend.sqlite.pre-restore`. Prove restore and reboot recovery before production volume; a healthy backup job alone is not recovery evidence.

## Update or recover a release

For normal updates, first use the guided deploy plan/apply so the remote commit and image revision labels are reviewed:

```sh
pnpm nusend:setup deploy plan
pnpm nusend:setup deploy apply
```

Direct Compose remains the break-glass/runtime reference after independently verifying the clean checkout and exact release tag:

```sh
git fetch --tags
git checkout vX.Y.Z
docker compose pull
docker compose up -d --wait
```

There is no mutable `latest`. Only the three newest release image versions are retained, so do not assume an old image remains pullable. Never use `docker compose down -v` during setup, update, destroy, or ordinary recovery.

## Pre-volume gates

Nusend is not ready for broad production marketing volume until all of these are evidenced:

- Docker Compose 5.3+, selected ingress, mandatory backup health, restore of an explicit snapshot, and reboot recovery of API, worker, Caddy, and backup;
- live SES identity/DKIM, production approval, configuration-set bounce/complaint suppression, exact single webhook subscription, simulator feedback, confirmed/exercised alarms, and zero DLQ counters;
- gradual SES quota/ramp planning, DMARC monitoring, real-message SPF/DKIM/DMARC alignment, and Gmail **Show original** inspection of DKIM plus one-click unsubscribe headers;
- approved OPEN/CLICK privacy and bounded event retention when enabled;
- provider firewall verification, host/SQLite capacity monitoring, incident procedures, and proof that least-privilege API keys revoke/expire correctly.

Repository checks cannot prove live DNS, TLS, SES/SNS/SQS behavior, R2 durability, restore/reboot outcomes, or inbox placement.

## Actionable failures

| Symptom | Action |
| --- | --- |
| Compose rejects `pre_start` | Upgrade Docker Compose to 5.3.0 or newer. |
| Compose reports a missing value | Repair the protected deployment environment (or remote `.env` during direct recovery) and rerun config validation. |
| API never becomes healthy | Inspect migration, owner-email, secret, and volume-permission errors without dumping environment values. |
| Public `/health/db` is not 404 | Stop rollout and inspect the selected Caddy configuration. |
| Public TLS fails | Check ingress mode, DNS, ports 80/443, Cloudflare Full (strict), and firewall rules. |
| Backup/restore fails | Verify separate R2 credentials, repository endpoint, escrowed restic password, and explicit snapshot ID. |
| Webhook confirmation is pending | Do not duplicate it; inspect public TLS/health, exact topic allowlist, API/Caddy logs, and outbound SNS HTTPS. |
| DLQ is nonempty | Investigate the signed webhook failure and replay deliberately only after remediation. |
