# Deploy and operate Nusend

Nusend is pre-launch, self-hosted software. Complete this procedure and the [pre-volume gates](#pre-volume-gates) before broad marketing use. Commands that provision providers may run from any trusted workstation; commands beginning with `docker compose` run from the tagged checkout on the deployment host.

## Deployment prerequisites

The host needs:

- Docker Engine and Docker Compose **5.3.0 or newer** (`docker compose version`)
- a public DNS name and provider firewall control
- Google OAuth, AWS SES/SNS/SQS/IAM, and private Cloudflare R2 access

The host needs neither Node nor pnpm. Install Node and pnpm 11 only on a machine where you intentionally [build the source CLI](#source-built-cli). AWS workstation requirements are documented only in the [AWS setup guide](./aws-setup.md).

## Choose a domain and ingress

Use one domain throughout this guide:

```sh
DOMAIN=mail.example.com
```

| `NUSEND_INGRESS_MODE` | DNS and firewall |
| --- | --- |
| `direct` | Point public `A`/`AAAA` records at the host and allow inbound TCP 80/443. Caddy obtains public TLS certificates. |
| `cloudflare` | Proxy the DNS record through Cloudflare, select SSL/TLS **Full (strict)**, and allow origin TCP 80/443 only from the current Cloudflare IP ranges. |

Compose publishes only ports 80 and 443. Direct mode trusts no forwarded client-IP headers; Cloudflare mode trusts only Cloudflare ranges with strict parsing. An invalid ingress mode fails Caddy startup.

## Check out a release

Clone anonymously and deploy a published release tag, not a moving branch:

```sh
git clone https://github.com/maxedapps/nusend.git
cd nusend
git checkout vX.Y.Z
cp .env.example .env
```

## Configure Google OAuth and the owner

Create a Google OAuth **Web application** client. Register these exact values; Google requires an exact redirect match:

```text
Authorized JavaScript origin: https://mail.example.com
Authorized redirect URI:      https://mail.example.com/api/auth/callback/google
```

Put its client ID and secret in `.env`. Set `NUSEND_OWNER_EMAIL` to the exact Google account that will own the instance and set the intended owner name. Compose reconciles this one owner on every API start; an existing different owner email blocks startup.

Reference: [Google OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server).

## Configure R2 backups

1. Create a **private** R2 bucket.
2. Create an R2 S3 API token with **Object Read & Write** and **Apply to specific buckets only** for that bucket.
3. Record the one-time Access Key ID and Secret Access Key separately from the AWS application credentials.
4. Generate a high-entropy restic password and escrow it independently. Losing it makes every backup unreadable.
5. Use this repository form in `.env`:

```text
s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/nusend
```

The R2 S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; the backup container supplies region `auto` and path-style bucket lookup. References: [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/) and [R2's S3 API](https://developers.cloudflare.com/r2/get-started/s3/).

## AWS setup

Follow [`aws-setup.md`](./aws-setup.md), the sole AWS procedure. Complete its **Provision before deployment** section, copy the generated runtime credentials and printed non-secret values into `.env`, then return here. Keep application AWS keys separate from R2 keys; the generated long-lived IAM key has no `AWS_SESSION_TOKEN`.

Do not subscribe the feedback webhook until the public deployment is healthy and already configured with the exact feedback topic ARN. After [Start and verify](#start-and-verify), return to the guide's **Finalize after deployment** section.

## Complete the environment

Edit `.env` and replace every placeholder in [`.env.example`](../.env.example). That file is the sole exhaustive production variable list. In particular, use the same region, sender, configuration-set names, and topic ARN provisioned above. Keep application AWS keys separate from R2 keys.

Use stable, independently stored secrets. Changing `NUSEND_API_KEY_HASH_SECRET` invalidates existing API keys. Use `NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET` only during controlled rotation. Keep `.env` private and never commit it.

## Start and verify

```sh
docker compose up -d --wait
docker compose ps
curl -fsS "https://${DOMAIN}/health"
test "$(curl -sS -o /dev/null -w '%{http_code}' "https://${DOMAIN}/health/db")" = 404
docker compose exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db');if(!r.ok)process.exit(1)"
```

Compose fixes volume ownership, migrates the database, reconciles the owner, starts the API and worker, and completes an initial off-site backup before the stack is healthy. Sign in through Google as the configured owner. Then build the CLI on any machine that can reach the public URL and complete its login/`whoami` check below.

## Source-built CLI

Build the private pnpm workspace from a tagged checkout on any workstation that can reach `https://${DOMAIN}`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
./apps/cli/dist/main.js login "https://${DOMAIN}"
./apps/cli/dist/main.js whoami
```

There is no published/global-install requirement and no assumption that `nusend` is on `PATH`. Built-in `--help` is the complete command catalog.

## Finish AWS setup

Complete [`aws-setup.md` from **Finalize after deployment** through its production gate](./aws-setup.md#finalize-after-deployment). That guide exclusively owns the webhook, DLQ, alarm, AWS-readiness, simulator, and suppression checks.

The application does not consume or replay DLQ messages. Investigate every visible message and replay it deliberately only after remediation.

## CLI automation and local state

Use `--json` for one success document on stdout and one compact error object on stderr. Exit codes are 0 success, 1 internal, 2 usage, 3 authentication/device authorization, and 4 API/HTTP.

Mailing creation and contact import accept a file or stdin:

```sh
./apps/cli/dist/main.js mailings create --file mailing.json
cat contacts.json | ./apps/cli/dist/main.js lists contacts import <list-id> --file -
```

Explicit `--base-url` overrides `NUSEND_BASE_URL`, which overrides the stored URL. `NUSEND_API_KEY` overrides stored credentials; providing it with an explicit or environment base URL bypasses disk state for automation.

On Unix, the config directory and `state.json` must be `0700` and `0600`. Broader permissions fail closed; repair them with:

```sh
./apps/cli/dist/main.js config repair-permissions
```

Login writes state atomically and alone may replace readable malformed state after authorization. Filesystem errors never authorize a write. Concurrent state mutation is unsupported; the last completed atomic writer wins.

## Operations and monitoring

Inspect persisted operations with the CLI:

```sh
./apps/cli/dist/main.js operations summary
./apps/cli/dist/main.js deliveries list --issue failed_or_ambiguous
./apps/cli/dist/main.js ses summary
./apps/cli/dist/main.js ses events list
```

`ambiguous` is terminal and means provider acceptance is unknown; do not treat it as a normal retryable failure. Monitor worker freshness, dead and ambiguous deliveries, webhook retries, SES feedback, SNS/DLQ alarms, host disk/capacity, and backup freshness.

Container logs use Docker's bounded `local` driver:

```sh
docker compose ps
docker compose logs --since 30m --timestamps api worker caddy backup
```

Never log or paste API keys, device/user codes, auth tokens, cookies, unsubscribe tokens, recipient variables, message bodies/HTML, OAuth query data, R2/restic secrets, raw SNS JSON, or full diagnostic payloads.

## Backup and restore

The mandatory backup service uses SQLite's online backup, validates the copy, initializes an absent restic repository only on restic exit 10, keeps 30 daily and 12 monthly snapshots, and runs about every 24 hours. Backup failure makes the service unhealthy and restart backoff retries it.

```sh
# Status
docker compose ps backup
docker compose logs --since 24h backup

# On demand
docker compose run --rm --no-deps backup run

# List full snapshot IDs
docker compose run --rm --no-deps --entrypoint sh backup -c \
  'export RESTIC_CACHE_DIR=/work/.restic-cache; restic -o s3.bucket-lookup=path snapshots --host nusend --tag nusend-db'
```

Restore only an explicit **64-character lowercase hexadecimal** snapshot ID; `latest` is rejected. Stop every service first:

```sh
docker compose stop api worker caddy backup
docker compose run --rm --no-deps backup restore <64-lowercase-hex-snapshot-id>
docker compose up -d --wait
curl -fsS "https://${DOMAIN}/health"
```

Restore validates the recovered SQLite database and preserves the former live database as `nusend.sqlite.pre-restore` before restart.

## Update to another release

```sh
git fetch --tags
git checkout vX.Y.Z
docker compose pull
docker compose up -d --wait
```

The checked-out tag's Compose file embeds matching immutable app and backup image tags. There is no mutable `latest`; only the three newest release image versions are retained, so do not assume an old image remains pullable.

## Pre-volume gates

Nusend is **not ready for broad production marketing volume** until all of these are evidenced:

- On a clean host with Compose 5.3+, prove the selected ingress mode, `docker compose up -d --wait`, mandatory backup health, restore of an explicit snapshot, and reboot recovery of API, worker, Caddy, and backup. This release-candidate proof replaces deleted local smoke scripts.
- Assess transport controls beyond the current production validation of HTTPS auth URL and trusted origins.
- Approve bounded SES notification/event retention, capacity planning, privacy handling, and host/SQLite disk monitoring.
- Complete the [AWS production gate](./aws-setup.md#production-gate), including live SES/SNS feedback, protected suppressions, readiness, DLQ/alarms, and Gmail DKIM-header inspection.
- Monitor worker freshness, dead/ambiguous deliveries, webhook retries, SNS DLQ messages, host health, and failed or missing backups.
- Verify delivery/SES retention remains long enough for unsubscribe links while conforming to the approved bounded policy.
- Prove a least-privilege API key reaches only permitted routes and becomes `401 unauthenticated` after revocation or expiry.

Repository checks and offline provider-policy validation do not prove live DNS, TLS, SES, SNS, SQS, R2, restore, reboot, or inbox behavior.

## Actionable failures

| Symptom | Action |
| --- | --- |
| Compose rejects `pre_start` | Upgrade Docker Compose to 5.3.0 or newer. |
| Compose names a missing variable | Complete every placeholder in `.env.example` and rerun config validation. |
| API never becomes healthy | Inspect API logs for migration, owner-email, secret, or volume-permission errors. |
| Public `/health/db` is not 404 | Stop rollout and inspect the selected Caddy configuration. |
| Caddy exits or public TLS fails | Check `NUSEND_INGRESS_MODE`, DNS, ports 80/443, Cloudflare Full (strict), and firewall rules. |
| Backup is unhealthy or restore fails | Inspect backup logs and verify separate R2 credentials, repository endpoint, restic password, and explicit snapshot ID. |
