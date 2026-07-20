# Deployment

This is the canonical ordered runbook for one Linux VPS, one API container, one send-worker container, local SQLite, Caddy with either direct DNS or Cloudflare-proxied ingress, journald, and encrypted restic backups in R2. Run commands as root unless shown otherwise. Replace every `example` value before use.

## 0. Choose and record one ingress mode

Choose before configuring DNS or the firewall. `NUSEND_CADDY_CONFIG_DIR` is the only selector; DNS/proxy state, this directory, and the firewall policy are one release transaction. Keep provider-console access and the prior three-part state available until selected-mode acceptance passes.

| Mode | Selector | DNS and firewall contract | Client address contract |
| --- | --- | --- | --- |
| Direct | `/opt/nusend/deploy/caddy/direct` | Public `A` and only a validated `AAAA`; TCP 80/443 reachable from the Internet for automatic HTTPS and normal traffic. | Caddy trusts no forwarding headers and overwrites Host, proto, and XFF from the direct peer. |
| Cloudflare | `/opt/nusend/deploy/caddy/cloudflare` | Bootstrap the public certificate with DNS direct and 80/443 reachable; then proxy DNS with Full (strict) and restrict origin 80/443 to current Cloudflare ranges. | Caddy trusts only current Cloudflare ranges with strict parsing and `CF-Connecting-IP`, then overwrites Host, proto, and one canonical XFF. |

Choose the path now. After step 3 creates `/etc/nusend/compose.env`, set it there. At the start of every later command session and every standalone transaction below, load and validate it before any Compose or Caddy validation:

```sh
set -a
. /etc/nusend/compose.env
set +a
: "${NUSEND_CADDY_CONFIG_DIR:?select the direct or cloudflare Caddy directory}"
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || {
  printf 'selected Caddyfile does not exist: %s\n' "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" >&2
  exit 1
}
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare) NUSEND_INGRESS_MODE=cloudflare ;;
  *) printf 'unsupported Caddy config directory: %s\n' "$NUSEND_CADDY_CONFIG_DIR" >&2; exit 1 ;;
esac
export NUSEND_INGRESS_MODE
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
```

Later snippets that call `dc` assume this exact preflight has run in the same shell. Re-run it after changing `/etc/nusend/compose.env`; never rely on a previous shell's selection.

> **Migration policy:** Before launch, `0001_initial_schema.sql` is the single editable forward baseline; delete and recreate disposable local databases after changing it. After launch, never edit an applied migration—add forward `0002+` files. For recovery, restore a matching exact backup or use a separately reviewed recreate/import procedure; no DOWN migrations exist.

> **Staging/operator gates:** Local validation exercises both exact Caddy modes offline. Real selected-mode ACME issuance, DNS, firewall, public/client-IP behavior, callbacks, recreation/reboot persistence, plus Cloudflare controls when selected, AWS, R2, backup, and restore require operator-owned infrastructure and credentials. Validate them on a clean staging VPS before production; local checks are not live evidence.

## 1. Install the host prerequisites

Use a Linux distribution supported by Docker Engine. Install Docker Engine from Docker's **official repository**, not a distribution's stale `docker.io` package or the convenience script. Follow Docker's distro-specific instructions at <https://docs.docker.com/engine/install/> through the repository setup, then install the official packages:

```sh
apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker version
docker compose version
systemctl enable --now docker
```

The package-manager command above is for an apt-based supported host after Docker's repository has been configured. Use the package command from the official page for another supported distribution. Keep Engine, Buildx, and the Compose plugin supported and patched together.

Install host tools used below (`git`, `curl`, `openssl`, `lsof`, and either the iptables or nftables persistence tooling for the selected firewall backend). Do not expose an application port; `compose.yaml` publishes only Caddy TCP 80 and 443.

### Create the fixed filesystem layout

The app and backup images run as UID/GID `10001`. Caddy currently runs as the stock image's root user with only `NET_BIND_SERVICE`; its private state directories therefore remain root-owned. Caddy's persistent `/data` holds automatic-HTTPS state. Backup-only secret files are group-readable only by GID `10001` so the non-root backup container can read file-backed Compose secrets.

```sh
install -d -o root  -g root  -m 0755 /opt/nusend
install -d -o root  -g root  -m 0700 /etc/nusend /etc/nusend/secrets
install -d -o 10001 -g 10001 -m 0700 /var/lib/nusend /var/lib/nusend-backup
install -d -o root  -g root  -m 0700 \
  /var/lib/nusend-caddy \
  /var/lib/nusend-caddy/data \
  /var/lib/nusend-caddy/config
```

Required ownership/modes:

| Path | Owner | Mode | Purpose |
| --- | --- | ---: | --- |
| `/opt/nusend` | `root:root` | `0755` | exact release checkout and Compose bundle |
| `/etc/nusend`, `/etc/nusend/secrets` | `root:root` | `0700` | protected configuration |
| `/etc/nusend/nusend.env`, `/etc/nusend/compose.env` | `root:root` | `0600` | runtime and Compose interpolation |
| `/etc/nusend/secrets/{r2-access-key-id,r2-secret-access-key,restic-password}` | `root:10001` | `0640` | backup-only secrets readable by backup GID |
| `/var/lib/nusend`, `/var/lib/nusend-backup` | `10001:10001` | `0700` | live DB and private backup work |
| `/var/lib/nusend-caddy/{data,config}` | `root:root` | `0700` | Caddy persistent state |
| `/var/lib/nusend/nusend.sqlite` | `10001:10001` | `0600` | live database after creation/restore |

Do not recursively change `/var/lib/nusend` while containers are running.

## 2. Check out and build one exact release

Use an exact reviewed tag and expected commit. A signed-tag check is mandatory when the project publishes signed tags; otherwise independently verify the expected commit through the release process.

Run release selection as one fail-closed transaction. For projects that do not publish signed tags, replace `git verify-tag` only with the release process's documented independent commit-verification command; never simply delete the gate.

```bash
set -Eeuo pipefail
die() { printf 'release verification failed: %s\n' "$*" >&2; exit 1; }
cd /opt/nusend
test -d .git || git clone https://github.com/maxedapps/nusend.git .
git fetch --tags --prune
RELEASE_TAG='vX.Y.Z'
EXPECTED_COMMIT='full-40-character-reviewed-commit'
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die 'invalid expected commit'
git verify-tag "$RELEASE_TAG" || die 'tag signature invalid'
git checkout --detach "$RELEASE_TAG"
[[ "$(git rev-parse HEAD)" == "$EXPECTED_COMMIT" ]] || die 'commit mismatch'
[[ -z "$(git status --porcelain)" ]] || die 'checkout is dirty'
SOURCE_REVISION=$(git rev-parse HEAD)
printf '%s\n' "$SOURCE_REVISION"
```

Never deploy `latest`, an unreviewed branch tip, or a mutable app tag. Before an image dependency update, query the named tag and compare its registry manifest digest with the reviewed `@sha256` pin in `Dockerfile`, `compose.yaml`, and `deploy/backup/Dockerfile`:

```sh
docker buildx imagetools inspect oven/bun:1.3.14-debian --format '{{json .Manifest}}'
docker buildx imagetools inspect caddy:2.11.4-alpine --format '{{json .Manifest}}'
docker buildx imagetools inspect restic/restic:0.19.0 --format '{{json .Manifest}}'
docker buildx imagetools inspect alpine:3.23 --format '{{json .Manifest}}'
```

A changed upstream tag digest is a review event, not an automatic update. Confirm the expected platform manifest, release notes, provenance, and local/staging tests before changing a pin.

Build the app with pulled base images, the exact revision label, and a commit-derived immutable tag. Push it to the operator's authenticated registry, then deploy the returned immutable digest:

```bash
set -Eeuo pipefail
die() { printf 'app image promotion failed: %s\n' "$*" >&2; exit 1; }
APP_REPOSITORY='registry.example/nusend'
[[ "${SOURCE_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] || die 'invalid source revision'
docker build --pull \
  --build-arg "SOURCE_REVISION=$SOURCE_REVISION" \
  --tag "$APP_REPOSITORY:$SOURCE_REVISION" \
  /opt/nusend
docker push "$APP_REPOSITORY:$SOURCE_REVISION"
APP_DIGEST=$(docker buildx imagetools inspect "$APP_REPOSITORY:$SOURCE_REVISION" \
  | sed -n 's/^Digest:[[:space:]]*//p' | head -n 1)
[[ "$APP_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'invalid registry digest'
docker pull "$APP_REPOSITORY@$APP_DIGEST"
APP_IMAGE="$APP_REPOSITORY@$APP_DIGEST"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$APP_IMAGE")" == "$SOURCE_REVISION" ]] || die 'revision label mismatch'
[[ "$(docker image inspect --format '{{.Config.User}}' "$APP_IMAGE")" == '10001:10001' ]] || \
  die 'app image user mismatch'
docker run --rm --workdir /app/apps/service --entrypoint bun "$APP_IMAGE" \
  -e "await import('@nusend/api-contract')"
docker run --rm --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --tmpfs /var/lib/nusend:rw,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700 \
  -e NUSEND_DB_PATH=/var/lib/nusend/probe.sqlite \
  --entrypoint bun "$APP_IMAGE" apps/service/src/db/migrate.ts status
printf 'NUSEND_APP_IMAGE=%s\n' "$APP_IMAGE"
```

Keep the registry tag immutable by policy. Record the source commit, app digest, platform, and the reviewed Bun/Caddy/restic/Alpine digests in the release record. If no registry exists, a local `sha256:<image-id>` can be used only with a documented host-local image retention procedure; a commit-looking local tag alone is not an immutable digest.

## 3. Install configuration and credentials

Create the protected files from the canonical examples, then edit them as root. Do not commit the populated files.

```bash
set -Eeuo pipefail
install -o root -g root -m 0600 .env.example /etc/nusend/nusend.env
install -o root -g root -m 0600 deploy/compose.env.example /etc/nusend/compose.env
for file in r2-access-key-id r2-secret-access-key restic-password; do
  install -o root -g 10001 -m 0640 /dev/null "/etc/nusend/secrets/$file"
done
```

In `/etc/nusend/compose.env`, set:

- `NUSEND_DOMAIN` to the dedicated hostname;
- `NUSEND_CADDY_CONFIG_DIR` to exactly one selector from step 0;
- `NUSEND_APP_IMAGE` to `repository@sha256:<reviewed-result-digest>` from step 2;
- fixed paths exactly as shown in `deploy/compose.env.example`;
- `NUSEND_BACKUP_IMAGE=registry.example/nusend-backup@sha256:<reviewed-result-digest>` produced for this exact release;
- the real non-secret R2 account ID and private bucket name;
- only paths—not secret values—for R2 and restic files.

In `/etc/nusend/nusend.env`, replace every placeholder and keep production URLs on the dedicated HTTPS origin. Generate independent random values for `BETTER_AUTH_SECRET`, `NUSEND_API_KEY_HASH_SECRET`, and `NUSEND_UNSUBSCRIBE_SECRET`; do not reuse the restic password or another app secret. Keep `NUSEND_API_KEY_HASH_SECRET` stable or existing API keys become invalid.

### Application variable ownership

The root `.env.example` is the canonical inventory. “Required” below means required for this production bundle, even where the code has a development default. The current Compose anchor gives the entire runtime file to both API and worker, so Docker administrators and both containers can inspect those values; “consumer” describes the intended code owner.

| Variable | Requirement | Consumer | Production meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | Required; Compose forces `production` | Both | Enables production validation, including HTTPS auth URLs. |
| `NUSEND_HOST` | Required invariant; Compose forces `0.0.0.0` | API | Internal container listener only. |
| `NUSEND_PORT` | Required invariant; Compose forces `3000` | API | Internal port; never publish it on the host. |
| `NUSEND_DB_PATH` | Required invariant; Compose forces `/var/lib/nusend/nusend.sqlite` | Both + operator commands | Shared SQLite path for API, worker, migration, and bootstrap. |
| `BETTER_AUTH_SECRET` | Required, independent, at least 32 characters | API; worker receives/validates shared file | Better Auth signing secret. |
| `BETTER_AUTH_URL` | Required | API; worker receives/validates shared file | Exact public HTTPS origin. |
| `GOOGLE_CLIENT_ID` | Required | API; worker receives/validates shared file | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Required secret | API; worker receives/validates shared file | Google OAuth client secret. |
| `NUSEND_AUTH_TRUSTED_ORIGINS` | Optional; set explicitly for production | API; worker receives/validates shared file | Comma-separated HTTPS origins; normally the dedicated origin only. |
| `NUSEND_API_KEY_HASH_SECRET` | Required, independent, at least 32 characters | API; worker receives shared file | HMAC secret for first-party API keys. |
| `AWS_ACCESS_KEY_ID` | Required for live SES/readiness | Both | AWS SDK credential; not the R2 key. |
| `AWS_SECRET_ACCESS_KEY` | Required secret for live SES/readiness | Both | Pair for the AWS access key. |
| `AWS_SESSION_TOKEN` | Optional; required only for temporary AWS credentials | Both | Standard AWS SDK session token. |
| `AWS_REGION` | Required | Both | SES region; worker fails closed without it. |
| `NUSEND_SES_FROM_EMAIL` | Required | Both | Worker sender; API readiness also inspects it. |
| `NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET` | Required | Both | Transactional SES configuration set; the send worker fails closed without it. |
| `NUSEND_SES_MARKETING_CONFIGURATION_SET` | Required before marketing sends; otherwise optional | Both | Marketing SES configuration set. |
| `NUSEND_SES_FEEDBACK_TOPIC_ARNS` | Required for SNS ingestion; otherwise webhook is disabled/404 | API | Comma-separated allowlist of accepted SNS topic ARNs. |
| `NUSEND_SES_TRACKING_EVENTS` | Optional | API | Empty or comma-separated `open,click`; readiness only requires selected events. |
| `NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN` | Optional | API | Branded SES tracking domain when configured. |
| `NUSEND_SES_REQUEST_TIMEOUT_MS` | Optional; default `30000` | Both | Worker timeout and API readiness budget input. |
| `NUSEND_SEND_WORKER_LEASE_SECONDS` | Optional; default `300` | Both | Worker lease and API readiness input; Compose grace assumes 300 seconds. |
| `NUSEND_SEND_WORKER_BATCH_SIZE` | Optional; default `1` | Both | Worker batch and API readiness input. |
| `NUSEND_SEND_WORKER_POLL_MS` | Optional; default `5000` | Both | Worker poll interval and API readiness input. |
| `NUSEND_WORKER_ID` | Optional | Worker | Stable identity; random when unset. |
| `NUSEND_PUBLIC_BASE_URL` | Required with unsubscribe secret for marketing sending | Both | Clean absolute HTTPS origin, without query, fragment, or HTML-escapable characters. |
| `NUSEND_UNSUBSCRIBE_SECRET` | Required with public base URL for marketing sending, at least 32 characters | Both | Signs and verifies unsubscribe links. |
| `NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET` | Optional rotation-only secret | Both | Previous distinct secret while old links remain valid. |

The worker requires `batchSize * requestTimeoutMs + 10000 < leaseSeconds * 1000`. If the lease is changed, update and test Compose's worker stop grace to at least lease + 60 seconds.

Use a dedicated least-privilege IAM identity. With the current shared env file, its policy is the smallest union needed by API readiness and worker sending: `ses:SendEmail`, `ses:GetAccount`, `ses:GetEmailIdentity`, `ses:GetConfigurationSet`, `ses:GetConfigurationSetEventDestinations`, `sns:GetTopicAttributes`, and `sns:ListSubscriptionsByTopic`. Restrict identity/configuration-set/topic resources and conditions where AWS supports them. Nusend does not need AWS provisioning, IAM, SNS publish, or broad `ses:*`/`sns:*` permissions. SES-to-SNS publish permission belongs in the topic/service policy, not the app credential. Stronger process-level separation requires a reviewed Compose/config change; do not improvise a second untracked env contract.

### Live credential provisioning

No TLS key or certificate file is provisioned. Both modes use stock Caddy automatic public HTTPS and persist certificate/account state in `/var/lib/nusend-caddy/data`. Verify the protected configuration and backup-secret permissions without printing contents:

```bash
set -Eeuo pipefail
chown root:root /etc/nusend/nusend.env /etc/nusend/compose.env
chmod 0600 /etc/nusend/nusend.env /etc/nusend/compose.env
chown root:10001 /etc/nusend/secrets/r2-access-key-id \
  /etc/nusend/secrets/r2-secret-access-key \
  /etc/nusend/secrets/restic-password
chmod 0640 /etc/nusend/secrets/r2-access-key-id \
  /etc/nusend/secrets/r2-secret-access-key \
  /etc/nusend/secrets/restic-password
stat -c '%U:%G %a %n' /etc/nusend/nusend.env /etc/nusend/compose.env \
  /etc/nusend/secrets/*
test "$(stat -c '%u:%g:%a' /etc/nusend/secrets/restic-password)" = 0:10001:640
```

Provision R2 only in step 8. R2 credentials never belong in `nusend.env`; the backup service alone receives their protected files through Compose secrets. Compose interpolation variables are not application runtime variables, but `/etc/nusend/compose.env` remains root-only because it reveals infrastructure identifiers and paths.

Docker `env_file` is not a secret boundary: anyone with Docker-admin/root access can inspect application process environments and mounted Compose secrets. Limit Docker group membership as equivalent to root.

### Off-server escrow before launch

Store an encrypted, access-controlled off-server copy of:

- `/etc/nusend/nusend.env` and `/etc/nusend/compose.env`;
- all app/OAuth/AWS secrets and the R2 token;
- the independent restic repository password;
- release commit, image digests, domain, selected Caddy directory, DNS/proxy state, firewall policy, R2 account/bucket/prefix, Cloudflare rules when selected, and recovery contacts.

A database backup alone cannot rebuild auth, API-key validation, unsubscribe links, OAuth, AWS access, ingress policy, or decrypt the restic repository. Test recovery of the escrow without exposing values in tickets or logs.

Build and push the backup image separately, promote the registry digest (never the build tag), and validate that exact image. The registry must enforce immutable tags; the timer will always resolve the recorded digest.

```bash
set -Eeuo pipefail
die() { printf 'backup image promotion failed: %s\n' "$*" >&2; exit 1; }
cd /opt/nusend
SOURCE_REVISION=$(git rev-parse HEAD)
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || die 'invalid source revision'
BACKUP_REPOSITORY='registry.example/nusend-backup'
BUILD_REF="$BACKUP_REPOSITORY:$SOURCE_REVISION"
docker buildx build --pull --platform linux/amd64,linux/arm64 \
  --label "org.opencontainers.image.revision=$SOURCE_REVISION" \
  --tag "$BUILD_REF" --push deploy/backup
INDEX_JSON=$(docker buildx imagetools inspect "$BUILD_REF" --format '{{json .Manifest}}')
grep -Eq '"mediaType":"application/vnd\.(oci\.image\.index\.v1\+json|docker\.distribution\.manifest\.list\.v2\+json)"' \
  <<<"$INDEX_JSON" || die 'backup result is not a multi-platform index'
grep -F '"architecture":"amd64"' <<<"$INDEX_JSON" >/dev/null || die 'amd64 manifest missing'
grep -F '"architecture":"arm64"' <<<"$INDEX_JSON" >/dev/null || die 'arm64 manifest missing'
[[ "$(grep -Fo '"os":"linux"' <<<"$INDEX_JSON" | wc -l)" -ge 2 ]] || \
  die 'Linux platform manifests missing'
BACKUP_DIGEST=$(docker buildx imagetools inspect "$BUILD_REF" \
  | sed -n 's/^Digest:[[:space:]]*//p' | head -n 1)
[[ "$BACKUP_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'invalid registry index digest'
BACKUP_IMAGE="$BACKUP_REPOSITORY@$BACKUP_DIGEST"
DEPLOYMENT_PLATFORM=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
[[ "$DEPLOYMENT_PLATFORM" == linux/amd64 || "$DEPLOYMENT_PLATFORM" == linux/arm64 ]] || \
  die "unsupported deployment platform: $DEPLOYMENT_PLATFORM"
docker pull --platform "$DEPLOYMENT_PLATFORM" "$BACKUP_IMAGE"
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$BACKUP_IMAGE")" == \
  "$DEPLOYMENT_PLATFORM" ]] || die 'pulled backup platform mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$BACKUP_IMAGE")" == "$SOURCE_REVISION" ]] || die 'revision label mismatch'
[[ "$(docker image inspect --format '{{.Config.User}}' "$BACKUP_IMAGE")" == '10001:10001' ]] || \
  die 'backup image user mismatch'
docker run --rm --platform "$DEPLOYMENT_PLATFORM" --entrypoint restic "$BACKUP_IMAGE" version
docker run --rm --platform "$DEPLOYMENT_PLATFORM" --entrypoint sqlite3 "$BACKUP_IMAGE" --version
cp -a /etc/nusend/compose.env "/etc/nusend/compose.env.pre-backup-$SOURCE_REVISION"
sed "s|^NUSEND_BACKUP_IMAGE=.*|NUSEND_BACKUP_IMAGE=$BACKUP_IMAGE|" \
  /etc/nusend/compose.env > /etc/nusend/compose.env.next
grep -Fx "NUSEND_BACKUP_IMAGE=$BACKUP_IMAGE" /etc/nusend/compose.env.next >/dev/null
install -o root -g root -m 0600 /etc/nusend/compose.env.next /etc/nusend/compose.env
rm -f /etc/nusend/compose.env.next

set -a
. /etc/nusend/compose.env
set +a
: "${NUSEND_CADDY_CONFIG_DIR:?select the direct or cloudflare Caddy directory}"
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || {
  printf 'selected Caddyfile does not exist: %s\n' "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" >&2
  exit 1
}
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare) NUSEND_INGRESS_MODE=cloudflare ;;
  *) printf 'unsupported Caddy config directory: %s\n' "$NUSEND_CADDY_CONFIG_DIR" >&2; exit 1 ;;
esac
export NUSEND_INGRESS_MODE
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
dc config --quiet
dc --profile ops config --quiet
[[ "$(dc --profile ops config --images | grep 'nusend-backup@sha256:')" == "$BACKUP_IMAGE" ]] || \
  die 'Compose did not render the promoted backup digest'
dc run --rm --no-deps --entrypoint caddy caddy fmt --diff /etc/caddy/Caddyfile
dc run --rm --no-deps --entrypoint caddy caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
printf 'record release=%s backup_image=%s\n' "$SOURCE_REVISION" "$BACKUP_IMAGE"
```

## 4. Configure DNS, automatic HTTPS, and optional Cloudflare controls

**[LIVE CONTROL-PLANE STEP]** Use a dedicated hostname, not a sub-path deployment. Keep TCP 80 and 443 reachable during first issuance. Caddy manages issuance and renewal; do not schedule manual renewal.

After publishing direct DNS for the selected mode, bootstrap TLS before any Cloudflare-only restriction. The selector preflight from step 0 must pass before Compose/Caddy validation:

```bash
set -Eeuo pipefail
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || exit 1
dc config --quiet
dc run --rm --no-deps --entrypoint caddy caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
dc up -d --no-deps caddy
CERT=''
for _ in {1..60}; do
  CERT=$(openssl s_client -connect "${NUSEND_DOMAIN}:443" -servername "$NUSEND_DOMAIN" \
    </dev/null 2>/dev/null | openssl x509 -noout -issuer -dates -ext subjectAltName 2>/dev/null) && break
  sleep 2
done
printf '%s\n' "$CERT"
grep -F "DNS:$NUSEND_DOMAIN" <<<"$CERT" >/dev/null
openssl s_client -connect "${NUSEND_DOMAIN}:443" -servername "$NUSEND_DOMAIN" \
  -verify_return_error </dev/null >/dev/null
CERT_SHA=$(openssl s_client -connect "${NUSEND_DOMAIN}:443" -servername "$NUSEND_DOMAIN" \
  </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256)
dc up -d --no-deps --force-recreate caddy
openssl s_client -connect "${NUSEND_DOMAIN}:443" -servername "$NUSEND_DOMAIN" \
  -verify_return_error </dev/null >/dev/null
CERT_SHA_AFTER=$(openssl s_client -connect "${NUSEND_DOMAIN}:443" -servername "$NUSEND_DOMAIN" \
  </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256)
[[ "$CERT_SHA_AFTER" == "$CERT_SHA" ]] || exit 1
```

Record issuer, not-before/not-after, SAN, and recreation result. A 502 is expected until API starts in step 7; TLS validation must still pass. If issuance fails, keep DNS direct and ports reachable, inspect Caddy logs, and do not tighten the firewall or enable Cloudflare proxying.

### Direct mode

1. Publish an `A` record to the origin. Publish `AAAA` only after the origin's IPv6 routing and firewall path pass the same tests as IPv4.
2. Keep public TCP 80/443 reachable and require the bootstrap above to produce a publicly trusted, hostname-matching certificate.
3. Persistent `/data`, not a manually copied certificate, is the continuity boundary; retain the recorded issuer/expiry and recreation proof.
4. From an external client, send forged `CF-Connecting-IP` and `X-Forwarded-For`; require Caddy's access log and the upstream-observed single XFF to identify the actual peer, not either forged value.

Set Google's authorized redirect URI to `https://mail.example.com/api/auth/callback/google` and the SNS HTTPS subscription endpoint to `https://mail.example.com/api/webhooks/aws/sns/ses`. Cloudflare cache/WAF controls do not apply in direct mode; provide equivalent callback reachability without weakening Nusend signature/auth validation.

### Cloudflare mode

Bootstrap before proxying or restricting the origin:

1. Publish the hostname as **DNS only** to the origin (`A`, and `AAAA` only after validated IPv6); keep public TCP 80/443 reachable.
2. Run the bootstrap above. Verify public HTTPS, a publicly trusted hostname-matching issuer/expiry, and `/data` persistence across Caddy recreation. Do not proceed on issuance or recreation failure.
3. Preserve unauthenticated access to `/.well-known/acme-challenge/*`: do not redirect it elsewhere or place a Cloudflare challenge/WAF block in front of it.
4. Change the records to **Proxied**, set SSL/TLS to **Full (strict)** (never Flexible/plain Full), and enable **Always Use HTTPS**. Reverify the TLS connection and certificate validity through Cloudflare; public application health follows after API starts in step 7.
5. Create a Cache Rule for only `http.host eq "mail.example.com"` with cache eligibility **Bypass**. The whole application hostname—including auth, callbacks, API, health, ACME challenge, and unsubscribe paths—must not be edge-cached.
6. Keep ordinary managed WAF, blocking, bot, and safe rate-limit controls enabled. Add Skip exceptions only for the exact challenge-producing products and callback methods/paths below:

| Callback | Exact expression fragment | Method/path |
| --- | --- | --- |
| SES/SNS webhook | `http.request.method eq "POST" and http.request.uri.path eq "/api/webhooks/aws/sns/ses"` | POST exact path |
| Unsubscribe | `http.request.method in {"GET" "POST"} and starts_with(http.request.uri.path, "/unsubscribe/")` | GET or POST below prefix |
| OAuth callback | `http.request.method eq "GET" and starts_with(http.request.uri.path, "/api/auth/callback/")` | GET below prefix |

Prefix each expression with `http.host eq "mail.example.com" and (...)`. A skip is not an allow: do not skip every security product, allow extra methods/hosts, or bypass Nusend validation. Exercise OAuth, SNS, and unsubscribe callbacks after API starts in step 7.

Only after these checks pass, apply the Cloudflare-only firewall restriction in step 5 and prove every direct-origin path is rejected. Set the same Google redirect and SNS endpoint URLs listed in direct mode.

## 5. Apply and prove the selected firewall policy

**Direct mode:** allow public TCP 80/443 on every published IPv4 and validated IPv6 path. From external networks, prove HTTP redirects/challenges can reach Caddy, HTTPS succeeds with normal and forged forwarding headers, and the canonical logged/upstream client IP is the real peer. Do not leave a Cloudflare-only source restriction installed. Re-run after address, interface, Docker backend, or firewall changes.

**Cloudflare mode:** Cloudflare proxying is not an origin firewall. After step 4's direct certificate bootstrap and proxied Full (strict) checks, allow TCP 80/443 from current official Cloudflare IPv4 **and** IPv6 ranges and reject all other public-interface traffic to those Docker-published ports. Re-fetch <https://www.cloudflare.com/ips-v4/> and <https://www.cloudflare.com/ips-v6/> immediately before applying rules and compare them with `deploy/caddy/cloudflare/Caddyfile`. Preserve the ACME challenge path through Cloudflare. The remainder of this section is Cloudflare-mode-only.

Docker-published ports normally traverse Docker forwarding rules, so an INPUT/UFW-only rule is insufficient; userland proxy paths can instead traverse INPUT. Before mutation, record Docker's configured firewall backend, `docker info`, `docker inspect nusend-caddy-1`, `ss -ltnp '( sport = :80 or sport = :443 )'`, and current forwarding/INPUT counters. The examples cover both forward and INPUT paths. During external probes, prove which chain counters increment; if neither does, stop Caddy and resolve the unvalidated packet path. Choose the rule set matching Docker's backend; do not install both examples. Apply from a provider console with an out-of-band recovery path, retain the prior ruleset, persist through the distribution's supported mechanism, and verify after reboot.

### iptables backend: `DOCKER-USER`

Docker must already be running so `DOCKER-USER` exists. Replace `eth0` with the real public interface. Apply initially while Caddy is stopped:

```bash
set -Eeuo pipefail
die() { printf 'firewall transaction failed: %s\n' "$*" >&2; exit 1; }
PUBLIC_IF='eth0'
ip link show dev "$PUBLIC_IF" >/dev/null || die 'public interface missing'
docker info >/root/nusend-docker-info.txt
iptables -S DOCKER-USER >/dev/null || die 'DOCKER-USER unavailable'
ip6tables -S DOCKER-USER >/dev/null || die 'IPv6 DOCKER-USER unavailable'
iptables-save >"/root/iptables.pre-nusend.$(date -u +%Y%m%dT%H%M%SZ)"
ip6tables-save >"/root/ip6tables.pre-nusend.$(date -u +%Y%m%dT%H%M%SZ)"
curl --fail --silent --show-error --proto '=https' \
  https://www.cloudflare.com/ips-v4/ -o /root/cloudflare-ips-v4.txt
curl --fail --silent --show-error --proto '=https' \
  https://www.cloudflare.com/ips-v6/ -o /root/cloudflare-ips-v6.txt
[[ -s /root/cloudflare-ips-v4.txt ]] || die 'empty IPv4 list'
[[ -s /root/cloudflare-ips-v6.txt ]] || die 'empty IPv6 list'
if grep -Ev '^[0-9]+(\.[0-9]+){3}/[0-9]+$' /root/cloudflare-ips-v4.txt; then
  die 'malformed IPv4 list'
fi
if grep -Ev '^[0-9A-Fa-f:]+/[0-9]+$' /root/cloudflare-ips-v6.txt; then
  die 'malformed IPv6 list'
fi

iptables -N NUSEND-CF4 2>/dev/null || iptables -F NUSEND-CF4
while IFS= read -r cidr; do
  iptables -A NUSEND-CF4 -s "$cidr" -p tcp -m multiport --dports 80,443 -j ACCEPT
done </root/cloudflare-ips-v4.txt
iptables -A NUSEND-CF4 -p tcp -m multiport --dports 80,443 -j REJECT --reject-with tcp-reset
iptables -A NUSEND-CF4 -j RETURN
iptables -C DOCKER-USER -i "$PUBLIC_IF" -j NUSEND-CF4 2>/dev/null || \
  iptables -I DOCKER-USER 1 -i "$PUBLIC_IF" -j NUSEND-CF4
iptables -C INPUT -i "$PUBLIC_IF" -j NUSEND-CF4 2>/dev/null || \
  iptables -I INPUT 1 -i "$PUBLIC_IF" -j NUSEND-CF4

ip6tables -N NUSEND-CF6 2>/dev/null || ip6tables -F NUSEND-CF6
while IFS= read -r cidr; do
  ip6tables -A NUSEND-CF6 -s "$cidr" -p tcp -m multiport --dports 80,443 -j ACCEPT
done </root/cloudflare-ips-v6.txt
ip6tables -A NUSEND-CF6 -p tcp -m multiport --dports 80,443 -j REJECT --reject-with tcp-reset
ip6tables -A NUSEND-CF6 -j RETURN
ip6tables -C DOCKER-USER -i "$PUBLIC_IF" -j NUSEND-CF6 2>/dev/null || \
  ip6tables -I DOCKER-USER 1 -i "$PUBLIC_IF" -j NUSEND-CF6
ip6tables -C INPUT -i "$PUBLIC_IF" -j NUSEND-CF6 2>/dev/null || \
  ip6tables -I INPUT 1 -i "$PUBLIC_IF" -j NUSEND-CF6
iptables -C NUSEND-CF4 -p tcp -m multiport --dports 80,443 -j REJECT --reject-with tcp-reset
ip6tables -C NUSEND-CF6 -p tcp -m multiport --dports 80,443 -j REJECT --reject-with tcp-reset
```

For an IP-range update while live, build new `NUSEND-CF4-NEXT`/`NUSEND-CF6-NEXT` chains completely, insert their jumps ahead of the old jumps, test proxied and direct traffic, then remove the old jumps/chains. Flushing a live referenced chain can briefly fail open. Never paste unvalidated network input directly into persistent firewall configuration.

### Docker nftables backend

Docker's nftables backend does not provide `DOCKER-USER`. Install a separate table with a forward base chain ordered before Docker's chains. Replace `eth0`, refresh the elements from Cloudflare's official endpoints, and validate with `nft --check -f` before loading:

```nft
# /etc/nftables.d/nusend-cloudflare.nft — ranges reviewed 2026-07-14;
# re-fetch the official endpoints before deployment.
table inet nusend_cloudflare {
  set cloudflare4 {
    type ipv4_addr
    flags interval
    elements = {
      173.245.48.0/20, 103.21.244.0/22, 103.22.200.0/22,
      103.31.4.0/22, 141.101.64.0/18, 108.162.192.0/18,
      190.93.240.0/20, 188.114.96.0/20, 197.234.240.0/22,
      198.41.128.0/17, 162.158.0.0/15, 104.16.0.0/13,
      104.24.0.0/14, 172.64.0.0/13, 131.0.72.0/22
    }
  }
  set cloudflare6 {
    type ipv6_addr
    flags interval
    elements = {
      2400:cb00::/32, 2606:4700::/32, 2803:f800::/32,
      2405:b500::/32, 2405:8100::/32, 2a06:98c0::/29,
      2c0f:f248::/32
    }
  }
  chain forward {
    type filter hook forward priority -1; policy accept;
    iifname "eth0" tcp dport { 80, 443 } ip saddr @cloudflare4 counter accept
    iifname "eth0" tcp dport { 80, 443 } ip6 saddr @cloudflare6 counter accept
    iifname "eth0" tcp dport { 80, 443 } counter reject with tcp reset
  }
  # Covers a Docker userland-proxy/local-socket path; forward remains required.
  chain input {
    type filter hook input priority -1; policy accept;
    iifname "eth0" tcp dport { 80, 443 } ip saddr @cloudflare4 counter accept
    iifname "eth0" tcp dport { 80, 443 } ip6 saddr @cloudflare6 counter accept
    iifname "eth0" tcp dport { 80, 443 } counter reject with tcp reset
  }
}
```

```bash
set -Eeuo pipefail
die() { printf 'nftables transaction failed: %s\n' "$*" >&2; exit 1; }
PUBLIC_IF='eth0'
ip link show dev "$PUBLIC_IF" >/dev/null || die 'public interface missing'
docker info >/root/nusend-docker-info.txt
nft list ruleset >"/root/nftables.pre-nusend.$(date -u +%Y%m%dT%H%M%SZ).nft"
nft --check -f /etc/nftables.d/nusend-cloudflare.nft || die 'ruleset validation failed'
nft -f /etc/nftables.d/nusend-cloudflare.nft
nft list table inet nusend_cloudflare | grep -F 'hook forward priority -1' >/dev/null
nft list table inet nusend_cloudflare | grep -F 'hook input priority -1' >/dev/null
```

Integrate the file with the host's persistent nftables configuration. The public-interface match is required so the rule does not reject container egress to remote HTTPS services.

### Required firewall tests

From a network that is not Cloudflare, enumerate **every routable host IPv4 and IPv6 address from the provider/host, regardless of DNS `A`/`AAAA` records**, and make each direct-origin attempt fail at the TCP/application layer. Populate both arrays; use an empty IPv6 array only after recording provider evidence that the host has no routable IPv6.

```bash
set -Eeuo pipefail
die() { printf 'firewall test failed: %s\n' "$*" >&2; exit 1; }
DOMAIN='mail.example.com'
ORIGIN_IPV4=( '203.0.113.10' )
ORIGIN_IPV6=( '2001:db8::10' ) # use () only when no routable IPv6 exists
((${#ORIGIN_IPV4[@]} + ${#ORIGIN_IPV6[@]} > 0)) || die 'no origin addresses inventoried'
for ip in "${ORIGIN_IPV4[@]}"; do
  if curl --fail --insecure --connect-timeout 5 --resolve "$DOMAIN:443:$ip" "https://$DOMAIN/health"; then
    die "direct IPv4 HTTPS reached origin: $ip"
  fi
  if curl --fail --connect-timeout 5 --resolve "$DOMAIN:80:$ip" "http://$DOMAIN/health"; then
    die "direct IPv4 HTTP reached origin: $ip"
  fi
done
for ip in "${ORIGIN_IPV6[@]}"; do
  if curl --fail --insecure --connect-timeout 5 --resolve "$DOMAIN:443:[$ip]" "https://$DOMAIN/health"; then
    die "direct IPv6 HTTPS reached origin: $ip"
  fi
  if curl --fail --connect-timeout 5 --resolve "$DOMAIN:80:[$ip]" "http://$DOMAIN/health"; then
    die "direct IPv6 HTTP reached origin: $ip"
  fi
done
curl --fail --show-error --silent "https://$DOMAIN/health" >/dev/null
```

For nftables, capture exact counters immediately before the external probe batch and again immediately after it—without other port 80/443 probes between captures:

```bash
set -Eeuo pipefail
COUNTER_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
COUNTER_DIR="/root/nusend-nft-counter-proof-$COUNTER_STAMP"
install -d -o root -g root -m 0700 "$COUNTER_DIR"
for chain in forward input; do
  nft -a list chain inet nusend_cloudflare "$chain" >"$COUNTER_DIR/$chain.before"
done
printf 'Run one proxied IPv4 request, one proxied IPv6 request when published, and every direct-origin negative now.\n'
read -r -p 'Press Enter only after the external probes finish: '
for chain in forward input; do
  nft -a list chain inet nusend_cloudflare "$chain" >"$COUNTER_DIR/$chain.after"
  diff -u "$COUNTER_DIR/$chain.before" "$COUNTER_DIR/$chain.after" || true
done
```

The recorded before/after files—not only the displayed diff—are the evidence. For each proxied family, the matching `cloudflare4`/`cloudflare6` `counter packets` value must increase in either `forward` or `input`. For every direct-origin family tested, the final reject rule's counter must increase in the same actual path. Record which chain moved and the exact packet deltas. If no relevant counter increases, or only an unexpected chain/rule increases, stop Caddy and resolve the path before acceptance. For iptables, make the equivalent before/after captures with `iptables -nvxL NUSEND-CF4`, `ip6tables -nvxL NUSEND-CF6`, and the INPUT/`DOCKER-USER` jump counters.

If IPv6 is unvalidated, do not publish it: remove the host's public IPv6 assignment or explicitly bind Compose ports to the validated IPv4 address until both the packet path and negative tests pass. Re-run after firewall, Docker, Cloudflare-range, address, or interface changes. A certificate error is not proof of blocking; the HTTPS negatives deliberately use `--insecure`.

## 6. Install journald policy

The supplied policy is server-wide, not Nusend-only. It retains persistent compressed journal data until entries exceed 30 days **or** storage pressure reaches the effective size/free-space bound (`SystemMaxUse=1G` or `SystemKeepFree=1G`, whichever constrains usage first). Only archived files are removed; the active journal file can temporarily overshoot until rotation. `SystemMaxFileSize=64M` and `MaxFileSec=1day` bound rotation granularity.

```sh
install -D -o root -g root -m 0644 \
  /opt/nusend/deploy/systemd/10-nusend-journal.conf \
  /etc/systemd/journald.conf.d/10-nusend-journal.conf
systemd-analyze cat-config systemd/journald.conf
systemctl restart systemd-journald
systemctl is-active systemd-journald
journalctl --disk-usage
```

Restarting journald affects server-wide logging. Perform and verify it on staging first. Do not promise an exact one-day deletion time: age and size enforcement occurs on rotation, and active-file overshoot is expected.

## 7. Create and start a fresh database in order

This section is only for a new database directory. If `/var/lib/nusend/nusend.sqlite` or sidecars already exist, stop and follow the warning at the top or the restore procedure—do not delete them.

Render, migrate, and validate as one fail-closed transaction. Migration is never automatic startup work; the service start commands below are not entered unless status and integrity assertions pass.

```bash
set -Eeuo pipefail
die() { printf 'fresh migration failed: %s\n' "$*" >&2; exit 1; }
cd /opt/nusend
set -a
. /etc/nusend/compose.env
set +a
: "${NUSEND_CADDY_CONFIG_DIR:?select the direct or cloudflare Caddy directory}"
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || {
  printf 'selected Caddyfile does not exist: %s\n' "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" >&2
  exit 1
}
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare) NUSEND_INGRESS_MODE=cloudflare ;;
  *) printf 'unsupported Caddy config directory: %s\n' "$NUSEND_CADDY_CONFIG_DIR" >&2; exit 1 ;;
esac
export NUSEND_INGRESS_MODE
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
[[ ! -e /var/lib/nusend/nusend.sqlite ]] || die 'database already exists'
[[ ! -e /var/lib/nusend/nusend.sqlite-wal ]] || die 'WAL already exists'
[[ ! -e /var/lib/nusend/nusend.sqlite-shm ]] || die 'SHM already exists'
dc config --quiet
dc --profile ops config --quiet
[[ "$(dc config --services | grep -Ec '^(api|worker|caddy)$')" -eq 3 ]] || die 'unexpected default services'
dc --profile ops run --rm --no-deps migrate
MIGRATION_STATUS=$(dc --profile ops run --rm --no-deps migrate \
  bun apps/service/src/db/migrate.ts status)
grep -F 'applied  0001_initial_schema' <<<"$MIGRATION_STATUS" >/dev/null || die 'baseline not applied'
[[ "$(grep -Fc 'applied  ' <<<"$MIGRATION_STATUS")" -eq 1 ]] || die 'unexpected applied migrations'
if grep -Eiq 'pending|changed|missing' <<<"$MIGRATION_STATUS"; then
  die 'migration status is not clean'
fi
QUICK_CHECK=$(dc --profile ops run --rm --no-deps --entrypoint sqlite3 backup \
  -batch -readonly /source/nusend.sqlite 'PRAGMA quick_check;')
[[ "$QUICK_CHECK" == 'ok' ]] || die 'quick_check failed'
FK_CHECK=$(dc --profile ops run --rm --no-deps --entrypoint sqlite3 backup \
  -batch -readonly /source/nusend.sqlite 'PRAGMA foreign_key_check;')
[[ -z "$FK_CHECK" ]] || die 'foreign_key_check failed'
chown 10001:10001 /var/lib/nusend/nusend.sqlite
chmod 0600 /var/lib/nusend/nusend.sqlite
[[ "$(stat -c '%u:%g:%a' /var/lib/nusend/nusend.sqlite)" == 10001:10001:600 ]] || \
  die 'database ownership/mode mismatch'
```

Start API first, require internal DB health, then start Caddy and require public health. Public `/health/db` intentionally returns 404.

```sh
dc up -d --no-deps api
dc ps api
dc exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db'); console.log(r.status,await r.text()); if(!r.ok)process.exit(1)"
dc up -d --no-deps caddy
dc ps api caddy
curl --fail --show-error --silent https://mail.example.com/health
curl --output /dev/null --silent --write-out '%{http_code}\n' \
  https://mail.example.com/health/db   # expected 404
```

Complete the selected-mode live acceptance now. Direct mode repeats public IPv4/validated-IPv6 HTTP/HTTPS plus forged-header/canonical-client-IP probes. Cloudflare mode repeats proxied health/client-IP, Full (strict), current-range counters, and every direct-origin negative. After owner/AWS setup below, exercise OAuth, SNS, and unsubscribe callbacks; Cloudflare mode also proves cache bypass and only the narrow challenge skips. Keep the worker stopped until these ingress and readiness checks pass.

Bootstrap the one owner with the same image/env/database while the worker remains stopped:

```sh
dc --profile ops run --rm --no-deps migrate \
  bun apps/service/src/auth/bootstrap.ts \
  --email 'owner@example.com' --name 'Owner'
```

Do not use `--force` unless deliberately updating/adding an owner after inspecting existing users. Sign in through Google as that exact owner and verify `GET /api/operations/ses/readiness`. Complete the SES/SNS checklist in [`ses-setup.md`](./ses-setup.md): verified sender/DKIM, production access, account suppression, configuration sets/event destinations, Standard SNS topic with SignatureVersion 2, confirmed HTTPS subscription, DLQ/alarms, and the exact topic ARN allowlist. The app credential needs only the least-privilege actions listed above.

**[LIVE AWS STEP]** Run server-local SES simulator checks only after the deployed callback receives SNS; `end-to-end` mode otherwise times out. Simulator sending can be billed/rate-limited. Do not infer readiness from local config alone.

Only after required readiness checks pass, start exactly one worker and inspect a cycle:

```sh
dc up -d --no-deps worker
dc ps api worker caddy
dc logs --since 10m api worker caddy
docker ps --filter label=com.docker.compose.project=nusend \
  --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

There must be one API, one worker, no host mapping for port 3000, and only Caddy TCP 80/443. See [`operations.md`](./operations.md) for routine status commands.

## 8. Initialize and prove R2 backup before enabling the timer

**[LIVE CREDENTIAL STEP]** Create one private R2 bucket dedicated to this repository/prefix and one token scoped to **Object Read & Write for that bucket only**. Do not configure an R2 lifecycle deletion rule or bucket lock on the restic prefix: restic owns mutable, interdependent repository objects and performs retention/prune itself.

Generate an independent high-entropy restic password, place the three values in their `root:10001` mode `0640` files, and escrow the password off-server **before** initialization. Losing it makes the R2 data unrecoverable. Before any network call, run this real Compose probe. It emits no secret content and fails unless every mounted file is readable and non-empty as UID/GID `10001`:

```bash
set -Eeuo pipefail
set -a
. /etc/nusend/compose.env
set +a
: "${NUSEND_CADDY_CONFIG_DIR:?select the direct or cloudflare Caddy directory}"
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || {
  printf 'selected Caddyfile does not exist: %s\n' "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" >&2
  exit 1
}
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare) NUSEND_INGRESS_MODE=cloudflare ;;
  *) printf 'unsupported Caddy config directory: %s\n' "$NUSEND_CADDY_CONFIG_DIR" >&2; exit 1 ;;
esac
export NUSEND_INGRESS_MODE
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
dc --profile ops run --rm --no-deps --entrypoint sh backup -ceu '
  test "$(id -u):$(id -g)" = 10001:10001
  for path in "$AWS_ACCESS_KEY_ID_FILE" "$AWS_SECRET_ACCESS_KEY_FILE" "$RESTIC_PASSWORD_FILE"; do
    test -r "$path"
    test -s "$path"
  done
'
```

Define the exact R2 restic wrapper. It loads backup-only secret files inside the backup container and applies path-style lookup to every command:

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

Initialize exactly once; the scheduled backup intentionally never initializes a missing repository and never unlocks it:

```bash
set -Eeuo pipefail
r2_restic init
r2_restic snapshots --host nusend --tag nusend-db
```

Run one on-demand production backup. It uses SQLite `.backup`, validates quick/FK checks locally, uploads, captures one exact snapshot ID, deletes staging, restores that exact ID, validates it again, applies retention, prunes, and runs `restic check`:

```bash
set -Eeuo pipefail
dc --profile ops run --rm --no-deps backup
r2_restic snapshots --host nusend --tag nusend-db
r2_restic check
```

Capture the full 64-character `backup: verified snapshot_id=...` from the command/journal. Before enabling scheduling, perform the initial restore drill from that exact ID to a unique separate path/server without replacing the live database, run SQLite checks and migration status, and query known data. Use the validation portion of step 11, but do not replace the live database. This is separate from the backup script's internal exact-ID verification and proves operator recovery access.

Install the units only after init, on-demand snapshot, and independent exact restore all succeed:

```bash
set -Eeuo pipefail
install -D -o root -g root -m 0644 deploy/systemd/nusend-backup.service \
  /etc/systemd/system/nusend-backup.service
install -D -o root -g root -m 0644 deploy/systemd/nusend-backup.timer \
  /etc/systemd/system/nusend-backup.timer
systemd-analyze verify /etc/systemd/system/nusend-backup.service \
  /etc/systemd/system/nusend-backup.timer
systemctl daemon-reload
systemctl enable --now nusend-backup.timer
systemctl cat nusend-backup.service nusend-backup.timer
# The installed service must show this exact command:
# ExecStart=/usr/bin/docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml --profile ops run --rm --no-deps backup
systemctl status --no-pager nusend-backup.timer
systemctl list-timers --all nusend-backup.timer
journalctl -u nusend-backup.service --since '24 hours ago' --no-pager
```

The timer is daily at 03:00 UTC with `Persistent=true` and up to 15 minutes randomized delay. A missed run executes after the host returns. Configure external alerting for failed/missing runs; systemd journaling alone does not notify an operator.

## 9. Promote dependency, bundle, unit, and ingress-policy updates

Treat every dependency, Caddy mode, DNS/proxy, firewall, or Cloudflare-range change as one release. Review upstream release notes and registry manifests; a moved tag is a review event. Build app and backup images with `--pull`, promote immutable digests, and run the exact-image probes from steps 2–3. When Cloudflare mode is selected, update and review both Caddy and host Cloudflare CIDRs together. Never deploy a mutable scheduled-backup tag.

Before production, stage the complete release: source commit, `compose.yaml`, selected Caddy directory, immutable image digests, systemd units, DNS/proxy state, and matching firewall policy. Validate common health, certificate persistence, callbacks, logs, live R2 snapshot, and exact restore. For direct mode prove public 80/443 and forged-header/client-IP behavior; for Cloudflare mode prove bootstrap certificate, Full (strict), callback/cache/WAF rules, current CIDRs, and every direct-origin IPv4/IPv6 negative. Record the selected directory and live evidence with all digests and restore timestamp.

Firewall rollback artifacts are a **pre-promotion prerequisite**, not something the update transaction may reconstruct afterward. Run this complete capture from the provider console before mutation. Replace only the backend and its real persistent destinations. It captures and validates the full runtime ruleset, records the selected mode, captures exact persistent state, and hashes every artifact. For nftables, the selected Nusend Cloudflare file must exist in Cloudflare mode and be absent in direct mode.

```bash
set -Eeuo pipefail
die() { printf 'pre-promotion firewall capture failed: %s\n' "$*" >&2; exit 1; }
FIREWALL_BACKEND='iptables' # or nftables
PERSISTENT_V4='/etc/iptables/rules.v4' # replace for the selected persistence tool
PERSISTENT_V6='/etc/iptables/rules.v6'
PERSISTENT_NFT='/etc/nftables.d/nusend-cloudflare.nft' # selected Nusend include
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PRE_FIREWALL_STATE_DIR="/root/nusend-firewall-pre-promotion-$STAMP"
install -d -o root -g root -m 0700 "$PRE_FIREWALL_STATE_DIR"
printf '%s\n' "$FIREWALL_BACKEND" >"$PRE_FIREWALL_STATE_DIR/backend"
printf '%s\n' "$NUSEND_INGRESS_MODE" >"$PRE_FIREWALL_STATE_DIR/ingress-mode"
case "$FIREWALL_BACKEND" in
  iptables)
    [[ "$PERSISTENT_V4" == /etc/* && "$PERSISTENT_V6" == /etc/* ]] || \
      die 'invalid iptables persistence destination'
    [[ -s "$PERSISTENT_V4" && -s "$PERSISTENT_V6" ]] || \
      die 'persistent iptables files missing'
    iptables-save >"$PRE_FIREWALL_STATE_DIR/runtime.v4"
    ip6tables-save >"$PRE_FIREWALL_STATE_DIR/runtime.v6"
    iptables-restore --test <"$PRE_FIREWALL_STATE_DIR/runtime.v4"
    ip6tables-restore --test <"$PRE_FIREWALL_STATE_DIR/runtime.v6"
    iptables-restore --test <"$PERSISTENT_V4"
    ip6tables-restore --test <"$PERSISTENT_V6"
    cp -a "$PERSISTENT_V4" "$PRE_FIREWALL_STATE_DIR/persistent.v4"
    cp -a "$PERSISTENT_V6" "$PRE_FIREWALL_STATE_DIR/persistent.v6"
    printf '%s\n' "$PERSISTENT_V4" >"$PRE_FIREWALL_STATE_DIR/persistent-v4-destination"
    printf '%s\n' "$PERSISTENT_V6" >"$PRE_FIREWALL_STATE_DIR/persistent-v6-destination"
    ;;
  nftables)
    [[ "$PERSISTENT_NFT" == /etc/* ]] || die 'invalid nftables persistence destination'
    nft list ruleset >"$PRE_FIREWALL_STATE_DIR/runtime.nft"
    { printf 'flush ruleset\n'; cat "$PRE_FIREWALL_STATE_DIR/runtime.nft"; } \
      >"$PRE_FIREWALL_STATE_DIR/runtime.check.nft"
    nft --check -f "$PRE_FIREWALL_STATE_DIR/runtime.check.nft"
    rm -f "$PRE_FIREWALL_STATE_DIR/runtime.check.nft"
    printf '%s\n' "$PERSISTENT_NFT" >"$PRE_FIREWALL_STATE_DIR/persistent-nft-destination"
    case "$NUSEND_INGRESS_MODE" in
      direct)
        [[ ! -e "$PERSISTENT_NFT" ]] || die 'direct mode has persistent Cloudflare rules'
        printf '%s\n' absent >"$PRE_FIREWALL_STATE_DIR/persistent-nft-presence"
        ;;
      cloudflare)
        [[ -s "$PERSISTENT_NFT" ]] || die 'Cloudflare persistent rules missing'
        printf '%s\n' present >"$PRE_FIREWALL_STATE_DIR/persistent-nft-presence"
        cp -a "$PERSISTENT_NFT" "$PRE_FIREWALL_STATE_DIR/persistent.nft"
        { printf 'flush ruleset\n'; cat "$PERSISTENT_NFT"; } \
          >"$PRE_FIREWALL_STATE_DIR/persistent.check.nft"
        nft --check -f "$PRE_FIREWALL_STATE_DIR/persistent.check.nft"
        rm -f "$PRE_FIREWALL_STATE_DIR/persistent.check.nft"
        ;;
      *) die 'unknown selected ingress mode' ;;
    esac
    ;;
  *) die 'unknown firewall backend' ;;
esac
(
  cd "$PRE_FIREWALL_STATE_DIR"
  find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 | sort -z | \
    xargs -0 sha256sum >SHA256SUMS
  sha256sum -c SHA256SUMS
)
PRE_FIREWALL_MANIFEST_SHA256=$(sha256sum "$PRE_FIREWALL_STATE_DIR/SHA256SUMS" | awk '{print $1}')
[[ "$PRE_FIREWALL_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || die 'manifest hash invalid'
printf 'PRE_FIREWALL_STATE_DIR=%q\nPRE_FIREWALL_MANIFEST_SHA256=%q\n' \
  "$PRE_FIREWALL_STATE_DIR" "$PRE_FIREWALL_MANIFEST_SHA256"
```

For target promotion, build complete replacement chains/table without flushing live references, validate first, then atomically switch as described in step 5. Capture/hash the promoted full ruleset and persistence separately, run the selected-mode external probes, and keep both artifacts off-server. A direct target must prove no Cloudflare-only reject or persistent Nusend nftables file remains; a Cloudflare target must prove current-range accepts and every direct-origin reject. Rollback below restores only the verified pre-promotion artifact from the provider console.

Stock Caddy remains intentional; do not add a Cloudflare DNS plugin or UDP 443. Restic retention remains `--keep-within 30d --keep-monthly 12` grouped by host/path/tag, and R2 lifecycle deletion remains disabled.

## 10. Production update and rollback transaction

The update promotes the **entire** reviewed release, not only an app image. Fill every input and run the fence as one Bash process. Pre-stage the target DNS/proxy and firewall changes plus provider-console recovery, but do not acknowledge promotion until the fence has installed/recreated the selected Caddy config and pauses for the matching control-plane cutover. Keep/open direct 80/443 for first public issuance; only after that proof may Cloudflare enable proxying/Full (strict)/callback rules and current-CIDR restriction. `EXPECTED_CLIENT_IP` is the controlled external probe's public address. The fence retains prior source/config/units/rules/digests and ingress selection and restarts scheduling only after selected-mode acceptance. `verify_worker_success` requires queue-cycle counters; exercise a real SES operation when sending behavior changes.

```bash
set -Eeuo pipefail
die() { printf 'update aborted: %s\n' "$*" >&2; exit 1; }
set -a
. /etc/nusend/compose.env
set +a
: "${NUSEND_CADDY_CONFIG_DIR:?select the current Caddy directory}"
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || {
  printf 'selected Caddyfile does not exist: %s\n' "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" >&2
  exit 1
}
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare) NUSEND_INGRESS_MODE=cloudflare ;;
  /opt/nusend/deploy/caddy) NUSEND_INGRESS_MODE=cloudflare ;; # legacy pre-split release only
  *) printf 'unsupported current Caddy config directory: %s\n' "$NUSEND_CADDY_CONFIG_DIR" >&2; exit 1 ;;
esac
export NUSEND_INGRESS_MODE
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
verify_worker_success() {
  local logs
  for _ in {1..60}; do
    logs=$(dc logs --no-color --no-log-prefix --since "$WORKER_STARTED_AT" worker 2>&1 || true)
    if grep -F '"claimed":' <<<"$logs" >/dev/null && \
       grep -F '"succeeded":' <<<"$logs" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
verify_caddy_acceptance() {
  local config marker secret status logs probe_log caddy_id
  caddy_id=$(dc ps -q caddy)
  [[ -n "$caddy_id" && "$(docker inspect --format '{{.State.Running}}' "$caddy_id")" == true ]] || \
    die 'Caddy not running after recreation'
  config=$(dc exec -T caddy wget -qO- http://127.0.0.1:2019/config/)
  [[ -n "$config" ]] || die 'running Caddy config unavailable'
  grep -F "\"$DOMAIN\"" <<<"$config" >/dev/null || die 'running Caddy domain mismatch'
  case "$NUSEND_INGRESS_MODE" in
    direct)
      ! grep -F '"trusted_proxies_strict":true' <<<"$config" >/dev/null || \
        die 'direct mode unexpectedly trusts proxies'
      ! grep -F 'CF-Connecting-IP' <<<"$config" >/dev/null || \
        die 'direct mode unexpectedly accepts Cloudflare client headers'
      ;;
    cloudflare)
      grep -F '"trusted_proxies_strict":true' <<<"$config" >/dev/null || \
        die 'Cloudflare strict proxy config missing'
      grep -F '"client_ip_headers":["CF-Connecting-IP","X-Forwarded-For"]' <<<"$config" >/dev/null || \
        die 'Cloudflare client-IP headers mismatch'
      ;;
    *) die 'unknown ingress mode' ;;
  esac
  curl --fail --show-error --silent "https://$DOMAIN/health" | grep -F '"ok":true' >/dev/null || \
    die 'public health failed'
  openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" -verify_return_error \
    </dev/null >/dev/null 2>&1 || die 'public certificate validation failed'
  status=$(curl --output /dev/null --silent --show-error --write-out '%{http_code}' \
    "https://$DOMAIN/health/db")
  [[ "$status" == 404 ]] || die 'private health is publicly reachable'
  marker="deployment-probe-$(date -u +%s)-$RANDOM"
  status=$(curl --output /dev/null --silent --show-error --write-out '%{http_code}' \
    --header 'CF-Connecting-IP: 198.51.100.77' \
    --header 'X-Forwarded-For: 198.51.100.88' "https://$DOMAIN/$marker")
  [[ "$status" == 404 ]] || die 'Caddy access-log probe returned unexpected status'
  secret=$(openssl rand -hex 16)
  status=$(curl --output /dev/null --silent --show-error --write-out '%{http_code}' \
    --referer "https://$DOMAIN/$secret" "https://$DOMAIN/deployment-log-probe?token=$secret")
  [[ "$status" == 404 ]] || die 'Caddy redaction probe returned unexpected status'
  for _ in {1..30}; do
    logs=$(journalctl CONTAINER_TAG=nusend-caddy --since "$CADDY_STARTED_AT" --no-pager)
    if grep -F "$marker" <<<"$logs" >/dev/null && grep -F '[REDACTED]' <<<"$logs" >/dev/null; then
      break
    fi
    sleep 1
  done
  probe_log=$(grep -F "$marker" <<<"${logs:-}" | tail -n 1)
  [[ -n "$probe_log" ]] || die 'Caddy access-log probe missing'
  grep -F "\"client_ip\":\"$EXPECTED_CLIENT_IP\"" <<<"$probe_log" >/dev/null || \
    die 'Caddy did not record the canonical client IP'
  ! grep -F "$secret" <<<"${logs:-}" >/dev/null || die 'Caddy leaked query/referrer probe secret'
  grep -F '[REDACTED]' <<<"${logs:-}" >/dev/null || die 'Caddy redaction marker missing'
}
NEW_TAG='vX.Y.Z'
NEW_COMMIT='full-40-character-reviewed-commit'
NEW_APP_IMAGE='registry.example/nusend@sha256:64-hex-digest'
NEW_BACKUP_IMAGE='registry.example/nusend-backup@sha256:64-hex-digest'
NEW_CADDY_CONFIG_DIR='/opt/nusend/deploy/caddy/direct' # or /cloudflare
DOMAIN='mail.example.com'
EXPECTED_CLIENT_IP='REPLACE_WITH_PROBE_EGRESS_IP'
INGRESS_CHANGE_READY='no' # set yes only after target state and recovery are staged
ACME_BOOTSTRAP_REQUIRED='no' # set yes for first public certificate, including Origin-CA migration
FIREWALL_CHANGED='no'
PRE_FIREWALL_STATE_DIR='/root/nusend-firewall-pre-promotion-REPLACE'
PRE_FIREWALL_MANIFEST_SHA256='64-hex-sha256-of-SHA256SUMS'
[[ "$NEW_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die 'invalid commit'
[[ "$NEW_APP_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || die 'app image is not a digest'
[[ "$NEW_BACKUP_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || die 'backup image is not a digest'
case "$NEW_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct|/opt/nusend/deploy/caddy/cloudflare) ;;
  *) die 'invalid target Caddy config directory' ;;
esac
[[ "$EXPECTED_CLIENT_IP" != REPLACE_WITH_PROBE_EGRESS_IP ]] || die 'probe client IP not set'
[[ "$INGRESS_CHANGE_READY" == yes ]] || die 'DNS/proxy/firewall change and recovery not staged'
[[ "$ACME_BOOTSTRAP_REQUIRED" == yes || "$ACME_BOOTSTRAP_REQUIRED" == no ]] || \
  die 'invalid ACME bootstrap gate'
[[ "$FIREWALL_CHANGED" == yes || "$FIREWALL_CHANGED" == no ]] || die 'invalid firewall-change gate'
if [[ "$FIREWALL_CHANGED" == yes ]]; then
  [[ "$PRE_FIREWALL_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || \
    die 'pre-promotion firewall manifest hash missing'
fi
cd /opt/nusend
[[ -z "$(git status --porcelain)" ]] || die 'release checkout is dirty'
PRIOR_COMMIT=$(git rev-parse HEAD)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STATE_DIR="/root/nusend-release-$STAMP"
install -d -o root -g root -m 0700 "$STATE_DIR"
printf '%s\n' "$PRIOR_COMMIT" >"$STATE_DIR/prior-commit"
printf '%s\n' "$NUSEND_CADDY_CONFIG_DIR" >"$STATE_DIR/prior-caddy-config-dir"
cp -a /etc/nusend/compose.env "$STATE_DIR/compose.env"
tar -cpf "$STATE_DIR/release-bundle.tar" compose.yaml deploy/caddy deploy/systemd
cp -a /etc/systemd/system/nusend-backup.service \
  /etc/systemd/system/nusend-backup.timer "$STATE_DIR/"
printf '%s\n' "$FIREWALL_CHANGED" >"$STATE_DIR/firewall-changed"
if [[ "$FIREWALL_CHANGED" == yes ]]; then
  [[ -d "$PRE_FIREWALL_STATE_DIR" && -f "$PRE_FIREWALL_STATE_DIR/SHA256SUMS" ]] || \
    die 'pre-promotion firewall artifact missing'
  [[ "$(sha256sum "$PRE_FIREWALL_STATE_DIR/SHA256SUMS" | awk '{print $1}')" == \
    "$PRE_FIREWALL_MANIFEST_SHA256" ]] || die 'source firewall manifest hash mismatch'
  (cd "$PRE_FIREWALL_STATE_DIR" && sha256sum -c SHA256SUMS) || \
    die 'source pre-promotion firewall artifact corrupt'
  install -d -o root -g root -m 0700 "$STATE_DIR/firewall/pre-promotion"
  cp -a "$PRE_FIREWALL_STATE_DIR/." "$STATE_DIR/firewall/pre-promotion/"
  (cd "$STATE_DIR/firewall/pre-promotion" && sha256sum -c SHA256SUMS) || \
    die 'copied pre-promotion firewall artifact corrupt'
  printf '%s\n' "$PRE_FIREWALL_MANIFEST_SHA256" \
    >"$STATE_DIR/firewall/pre-promotion-manifest.sha256"
fi
sed -n '/^NUSEND_\(APP\|BACKUP\)_IMAGE=/p' /etc/nusend/compose.env >"$STATE_DIR/image-digests"

systemctl disable --now nusend-backup.timer
systemctl stop nusend-backup.service
systemctl is-active --quiet nusend-backup.service && die 'backup service still active'
for _ in {1..60}; do
  BACKUP_IDS=$(docker ps -q --filter label=com.docker.compose.project=nusend \
    --filter label=com.docker.compose.service=backup)
  [[ -z "$BACKUP_IDS" ]] && break
  sleep 1
done
[[ -z "${BACKUP_IDS:-}" ]] || die 'one-off backup container still running'
BACKUP_OUTPUT=$(dc --profile ops run --rm --no-deps backup 2>&1) || die 'on-demand backup failed'
SNAPSHOT_ID=$(grep -Eo 'verified snapshot_id=[0-9a-f]{64}' <<<"$BACKUP_OUTPUT" \
  | tail -n 1 | cut -d= -f2)
[[ "$SNAPSHOT_ID" =~ ^[0-9a-f]{64}$ ]] || die 'verified snapshot ID missing'
printf '%s\n' "$SNAPSHOT_ID" >"$STATE_DIR/pre-update-snapshot-id"

for image in "$NEW_APP_IMAGE" "$NEW_BACKUP_IMAGE"; do docker pull "$image"; done
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$NEW_APP_IMAGE")" == "$NEW_COMMIT" ]] || die 'app revision mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  "$NEW_BACKUP_IMAGE")" == "$NEW_COMMIT" ]] || die 'backup revision mismatch'
git fetch --tags --prune
git verify-tag "$NEW_TAG"
git checkout --detach "$NEW_TAG"
[[ "$(git rev-parse HEAD)" == "$NEW_COMMIT" ]] || die 'release commit mismatch'
[[ -z "$(git status --porcelain)" ]] || die 'promoted checkout is dirty'
[[ -f "$NEW_CADDY_CONFIG_DIR/Caddyfile" ]] || die 'target Caddyfile missing from promoted release'

sed -e "s|^NUSEND_APP_IMAGE=.*|NUSEND_APP_IMAGE=$NEW_APP_IMAGE|" \
  -e "s|^NUSEND_BACKUP_IMAGE=.*|NUSEND_BACKUP_IMAGE=$NEW_BACKUP_IMAGE|" \
  -e "s|^NUSEND_CADDY_CONFIG_DIR=.*|NUSEND_CADDY_CONFIG_DIR=$NEW_CADDY_CONFIG_DIR|" \
  /etc/nusend/compose.env >"$STATE_DIR/compose.env.next"
grep -Fx "NUSEND_APP_IMAGE=$NEW_APP_IMAGE" "$STATE_DIR/compose.env.next" >/dev/null
grep -Fx "NUSEND_BACKUP_IMAGE=$NEW_BACKUP_IMAGE" "$STATE_DIR/compose.env.next" >/dev/null
grep -Fx "NUSEND_CADDY_CONFIG_DIR=$NEW_CADDY_CONFIG_DIR" \
  "$STATE_DIR/compose.env.next" >/dev/null
install -o root -g root -m 0600 "$STATE_DIR/compose.env.next" /etc/nusend/compose.env
set -a
. /etc/nusend/compose.env
set +a
[[ "$NUSEND_CADDY_CONFIG_DIR" == "$NEW_CADDY_CONFIG_DIR" ]] || die 'selector reload failed'
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || die 'selected Caddyfile missing after promotion'
NUSEND_INGRESS_MODE=${NUSEND_CADDY_CONFIG_DIR##*/}
export NUSEND_INGRESS_MODE
dc config --quiet
dc --profile ops config --quiet
dc run --rm --no-deps --entrypoint caddy caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
install -D -o root -g root -m 0644 deploy/systemd/nusend-backup.service \
  /etc/systemd/system/nusend-backup.service
install -D -o root -g root -m 0644 deploy/systemd/nusend-backup.timer \
  /etc/systemd/system/nusend-backup.timer
systemd-analyze verify /etc/systemd/system/nusend-backup.service \
  /etc/systemd/system/nusend-backup.timer
systemctl daemon-reload

# Deliberate stopped-service migration; never invoke a down migration here.
dc stop worker api
for service in api worker; do
  DB_USERS=$(docker ps -q --filter label=com.docker.compose.project=nusend \
    --filter "label=com.docker.compose.service=$service")
  [[ -z "$DB_USERS" ]] || die "$service did not stop"
done
dc --profile ops run --rm --no-deps migrate
MIGRATION_STATUS=$(dc --profile ops run --rm --no-deps migrate \
  bun apps/service/src/db/migrate.ts status)
grep -F 'applied  0001_initial_schema' <<<"$MIGRATION_STATUS" >/dev/null || die 'baseline not applied'
[[ "$(grep -Fc 'applied  ' <<<"$MIGRATION_STATUS")" -eq 1 ]] || die 'unexpected applied migrations'
if grep -Eiq 'pending|changed|missing' <<<"$MIGRATION_STATUS"; then die 'migration status invalid'; fi
QUICK=$(dc --profile ops run --rm --no-deps --entrypoint sqlite3 backup \
  -batch -readonly /source/nusend.sqlite 'PRAGMA quick_check;')
[[ "$QUICK" == ok ]] || die 'post-migration quick_check failed'
FK=$(dc --profile ops run --rm --no-deps --entrypoint sqlite3 backup \
  -batch -readonly /source/nusend.sqlite 'PRAGMA foreign_key_check;')
[[ -z "$FK" ]] || die 'post-migration foreign_key_check failed'

dc up -d --no-deps api
dc exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db');if(!r.ok)process.exit(1)"
if [[ "$ACME_BOOTSTRAP_REQUIRED" == yes ]]; then
  printf 'Set DNS to direct and make public TCP 80/443 reachable before Caddy starts.\n'
  read -r -p 'Type acme-bootstrap-ready only after that temporary state is externally proven: ' \
    ACME_ACK
  [[ "$ACME_ACK" == acme-bootstrap-ready ]] || die 'ACME bootstrap state not accepted'
fi
CADDY_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc up -d --no-deps --force-recreate caddy
if [[ "$ACME_BOOTSTRAP_REQUIRED" == yes ]]; then
  CERT=''
  for _ in {1..60}; do
    CERT=$(openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" \
      </dev/null 2>/dev/null | \
      openssl x509 -noout -issuer -dates -ext subjectAltName 2>/dev/null) && break
    sleep 2
  done
  printf '%s\n' "$CERT"
  grep -F "DNS:$DOMAIN" <<<"$CERT" >/dev/null || die 'public certificate bootstrap failed'
  openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" -verify_return_error \
    </dev/null >/dev/null 2>&1 || die 'bootstrapped certificate is not publicly trusted'
fi
printf 'Apply final DNS/proxy and firewall state matching %s from the provider console now.\n' \
  "$NUSEND_INGRESS_MODE"
read -r -p 'Type ingress-promoted only after selected-mode live probes pass: ' INGRESS_ACK
[[ "$INGRESS_ACK" == ingress-promoted ]] || die 'ingress transaction not accepted'
verify_caddy_acceptance
WORKER_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc up -d --no-deps worker
sleep 10
WORKER_ID=$(dc ps -q worker)
[[ -n "$WORKER_ID" && "$(docker inspect --format '{{.State.Running}}' "$WORKER_ID")" == true ]] || \
  die 'worker not running'
verify_worker_success || die 'worker/SES acceptance failed'
systemctl enable --now nusend-backup.timer
systemctl is-active --quiet nusend-backup.timer || die 'backup timer inactive'
printf 'release=%s app=%s backup=%s ingress=%s snapshot=%s state=%s\n' \
  "$NEW_COMMIT" "$NEW_APP_IMAGE" "$NEW_BACKUP_IMAGE" "$NUSEND_INGRESS_MODE" \
  "$SNAPSHOT_ID" "$STATE_DIR"
```

Retain `STATE_DIR` off-server. After promotion, direct mode must re-run public 80/443 and forged-header/client-IP tests; Cloudflare mode must re-run proxied health/client-IP and every direct-origin negative/counter test. Run a verified backup in either mode. Record changed Caddy, Compose, DNS/proxy, firewall, and unit artifacts/results.

Rollback only after a reviewed compatibility decision. Set the gate to `yes` only when the **current** schema is proven compatible with the prior release. Run from the provider console. Restore the retained config selector, matching DNS/proxy state, and matching firewall policy as one transaction before restarting Caddy; for Cloudflare restore Full (strict), callback/cache/WAF rules, and CIDR restriction, while direct mode restores public 80/443 and DNS-only records. The fence restores the prior checkout/bundle, Compose interpolation (both immutable images), installed units, and retained firewall state; it never runs a down migration.

```bash
set -Eeuo pipefail
die() { printf 'rollback aborted: %s\n' "$*" >&2; exit 1; }
set -a
. /etc/nusend/compose.env
set +a
: "${NUSEND_CADDY_CONFIG_DIR:?select the direct or cloudflare Caddy directory}"
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || {
  printf 'selected Caddyfile does not exist: %s\n' "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" >&2
  exit 1
}
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare) NUSEND_INGRESS_MODE=cloudflare ;;
  *) printf 'unsupported Caddy config directory: %s\n' "$NUSEND_CADDY_CONFIG_DIR" >&2; exit 1 ;;
esac
export NUSEND_INGRESS_MODE
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
verify_worker_success() {
  local logs
  for _ in {1..60}; do
    logs=$(dc logs --no-color --no-log-prefix --since "$WORKER_STARTED_AT" worker 2>&1 || true)
    if grep -F '"claimed":' <<<"$logs" >/dev/null && \
       grep -F '"succeeded":' <<<"$logs" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
verify_caddy_acceptance() {
  local config marker secret status logs probe_log caddy_id
  caddy_id=$(dc ps -q caddy)
  [[ -n "$caddy_id" && "$(docker inspect --format '{{.State.Running}}' "$caddy_id")" == true ]] || \
    die 'Caddy not running after recreation'
  config=$(dc exec -T caddy wget -qO- http://127.0.0.1:2019/config/)
  [[ -n "$config" ]] || die 'running Caddy config unavailable'
  grep -F "\"$DOMAIN\"" <<<"$config" >/dev/null || die 'running Caddy domain mismatch'
  case "$NUSEND_INGRESS_MODE" in
    direct)
      ! grep -F '"trusted_proxies_strict":true' <<<"$config" >/dev/null || \
        die 'direct mode unexpectedly trusts proxies'
      ! grep -F 'CF-Connecting-IP' <<<"$config" >/dev/null || \
        die 'direct mode unexpectedly accepts Cloudflare client headers'
      ;;
    cloudflare)
      grep -F '"trusted_proxies_strict":true' <<<"$config" >/dev/null || \
        die 'Cloudflare strict proxy config missing'
      grep -F '"client_ip_headers":["CF-Connecting-IP","X-Forwarded-For"]' <<<"$config" >/dev/null || \
        die 'Cloudflare client-IP headers mismatch'
      ;;
    *) die 'unknown ingress mode' ;;
  esac
  curl --fail --show-error --silent "https://$DOMAIN/health" | grep -F '"ok":true' >/dev/null || \
    die 'public health failed'
  openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" -verify_return_error \
    </dev/null >/dev/null 2>&1 || die 'public certificate validation failed'
  status=$(curl --output /dev/null --silent --show-error --write-out '%{http_code}' \
    "https://$DOMAIN/health/db")
  [[ "$status" == 404 ]] || die 'private health is publicly reachable'
  marker="deployment-probe-$(date -u +%s)-$RANDOM"
  status=$(curl --output /dev/null --silent --show-error --write-out '%{http_code}' \
    --header 'CF-Connecting-IP: 198.51.100.77' \
    --header 'X-Forwarded-For: 198.51.100.88' "https://$DOMAIN/$marker")
  [[ "$status" == 404 ]] || die 'Caddy access-log probe returned unexpected status'
  secret=$(openssl rand -hex 16)
  status=$(curl --output /dev/null --silent --show-error --write-out '%{http_code}' \
    --referer "https://$DOMAIN/$secret" "https://$DOMAIN/deployment-log-probe?token=$secret")
  [[ "$status" == 404 ]] || die 'Caddy redaction probe returned unexpected status'
  for _ in {1..30}; do
    logs=$(journalctl CONTAINER_TAG=nusend-caddy --since "$CADDY_STARTED_AT" --no-pager)
    if grep -F "$marker" <<<"$logs" >/dev/null && grep -F '[REDACTED]' <<<"$logs" >/dev/null; then
      break
    fi
    sleep 1
  done
  probe_log=$(grep -F "$marker" <<<"${logs:-}" | tail -n 1)
  [[ -n "$probe_log" ]] || die 'Caddy access-log probe missing'
  grep -F "\"client_ip\":\"$EXPECTED_CLIENT_IP\"" <<<"$probe_log" >/dev/null || \
    die 'Caddy did not record the canonical client IP'
  ! grep -F "$secret" <<<"${logs:-}" >/dev/null || die 'Caddy leaked query/referrer probe secret'
  grep -F '[REDACTED]' <<<"${logs:-}" >/dev/null || die 'Caddy redaction marker missing'
}
STATE_DIR='/root/nusend-release-REPLACE'
DOMAIN='mail.example.com'
EXPECTED_CLIENT_IP='REPLACE_WITH_PROBE_EGRESS_IP'
SCHEMA_COMPATIBLE='no'
[[ "$SCHEMA_COMPATIBLE" == yes ]] || die 'prior schema compatibility not approved'
[[ "$EXPECTED_CLIENT_IP" != REPLACE_WITH_PROBE_EGRESS_IP ]] || die 'probe client IP not set'
[[ -s "$STATE_DIR/prior-commit" && -s "$STATE_DIR/release-bundle.tar" ]] || die 'retained release missing'
FIREWALL_CHANGED=$(cat "$STATE_DIR/firewall-changed")
[[ "$FIREWALL_CHANGED" == yes || "$FIREWALL_CHANGED" == no ]] || die 'invalid retained firewall state'
systemctl disable --now nusend-backup.timer
systemctl stop nusend-backup.service
dc --profile ops stop backup worker api caddy
for service in backup worker api caddy; do
  IDS=$(docker ps -q --filter label=com.docker.compose.project=nusend \
    --filter "label=com.docker.compose.service=$service")
  [[ -z "$IDS" ]] || die "$service still running"
done
cd /opt/nusend
PRIOR_COMMIT=$(cat "$STATE_DIR/prior-commit")
[[ "$PRIOR_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die 'invalid prior commit'
git checkout --detach "$PRIOR_COMMIT"
tar -xpf "$STATE_DIR/release-bundle.tar" -C /opt/nusend
install -o root -g root -m 0600 "$STATE_DIR/compose.env" /etc/nusend/compose.env
set -a
. /etc/nusend/compose.env
set +a
[[ "$NUSEND_CADDY_CONFIG_DIR" == "$(cat "$STATE_DIR/prior-caddy-config-dir")" ]] || \
  die 'retained selector mismatch'
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || die 'retained Caddyfile missing'
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare|/opt/nusend/deploy/caddy)
    NUSEND_INGRESS_MODE=cloudflare ;;
  *) die 'retained Caddy selector is unsupported' ;;
esac
export NUSEND_INGRESS_MODE
install -o root -g root -m 0644 "$STATE_DIR/nusend-backup.service" \
  /etc/systemd/system/nusend-backup.service
install -o root -g root -m 0644 "$STATE_DIR/nusend-backup.timer" \
  /etc/systemd/system/nusend-backup.timer
systemctl daemon-reload
if [[ "$FIREWALL_CHANGED" == yes ]]; then
  # Out-of-band provider console only: this restores the complete host firewall.
  OLD_FIREWALL="$STATE_DIR/firewall/pre-promotion"
  EXPECTED_MANIFEST=$(cat "$STATE_DIR/firewall/pre-promotion-manifest.sha256")
  [[ "$EXPECTED_MANIFEST" =~ ^[0-9a-f]{64}$ ]] || die 'retained firewall manifest hash invalid'
  [[ "$(sha256sum "$OLD_FIREWALL/SHA256SUMS" | awk '{print $1}')" == \
    "$EXPECTED_MANIFEST" ]] || die 'retained firewall manifest hash mismatch'
  (cd "$OLD_FIREWALL" && sha256sum -c SHA256SUMS) || \
    die 'retained pre-promotion firewall artifact corrupt'
  FIREWALL_BACKEND=$(cat "$OLD_FIREWALL/backend")
  case "$FIREWALL_BACKEND" in
    iptables)
      for file in runtime.v4 runtime.v6 persistent.v4 persistent.v6 \
        persistent-v4-destination persistent-v6-destination; do
        [[ -s "$OLD_FIREWALL/$file" ]] || die "retained firewall file missing: $file"
      done
      PERSISTENT_V4=$(cat "$OLD_FIREWALL/persistent-v4-destination")
      PERSISTENT_V6=$(cat "$OLD_FIREWALL/persistent-v6-destination")
      [[ "$PERSISTENT_V4" == /etc/* && "$PERSISTENT_V6" == /etc/* ]] || \
        die 'invalid retained iptables destination'
      iptables-restore --test <"$OLD_FIREWALL/runtime.v4"
      ip6tables-restore --test <"$OLD_FIREWALL/runtime.v6"
      iptables-restore --test <"$OLD_FIREWALL/persistent.v4"
      ip6tables-restore --test <"$OLD_FIREWALL/persistent.v6"
      cp -a "$OLD_FIREWALL/persistent.v4" "$PERSISTENT_V4"
      cp -a "$OLD_FIREWALL/persistent.v6" "$PERSISTENT_V6"
      iptables-restore <"$OLD_FIREWALL/runtime.v4"
      ip6tables-restore <"$OLD_FIREWALL/runtime.v6"
      ;;
    nftables)
      for file in runtime.nft persistent-nft-destination persistent-nft-presence; do
        [[ -s "$OLD_FIREWALL/$file" ]] || die "retained firewall file missing: $file"
      done
      PERSISTENT_NFT=$(cat "$OLD_FIREWALL/persistent-nft-destination")
      PERSISTENT_NFT_PRESENCE=$(cat "$OLD_FIREWALL/persistent-nft-presence")
      [[ "$PERSISTENT_NFT" == /etc/* ]] || die 'invalid retained nftables destination'
      { printf 'flush ruleset\n'; cat "$OLD_FIREWALL/runtime.nft"; } \
        >"$STATE_DIR/nftables.runtime.rollback.nft"
      nft --check -f "$STATE_DIR/nftables.runtime.rollback.nft"
      case "$PERSISTENT_NFT_PRESENCE" in
        present)
          [[ -s "$OLD_FIREWALL/persistent.nft" ]] || die 'retained nftables file missing'
          { printf 'flush ruleset\n'; cat "$OLD_FIREWALL/persistent.nft"; } \
            >"$STATE_DIR/nftables.persistent.check.nft"
          nft --check -f "$STATE_DIR/nftables.persistent.check.nft"
          rm -f "$STATE_DIR/nftables.persistent.check.nft"
          cp -a "$OLD_FIREWALL/persistent.nft" "$PERSISTENT_NFT"
          ;;
        absent)
          [[ ! -e "$OLD_FIREWALL/persistent.nft" ]] || \
            die 'unexpected retained nftables file for absent state'
          rm -f -- "$PERSISTENT_NFT"
          ;;
        *) die 'invalid retained nftables presence state' ;;
      esac
      nft -f "$STATE_DIR/nftables.runtime.rollback.nft"
      ;;
    *) die 'unknown retained firewall backend' ;;
  esac
  printf 'Firewall runtime and persistence restored; run selected-mode external probes now.\n'
fi
printf 'Restore DNS/proxy controls matching %s, then test its firewall/client-IP contract.\n' \
  "$NUSEND_INGRESS_MODE"
read -r -p 'Type ingress-restored only after the complete three-part state passes: ' INGRESS_ACK
[[ "$INGRESS_ACK" == ingress-restored ]] || die 'restored ingress state not accepted'
dc config --quiet
dc --profile ops config --quiet
dc pull api worker backup caddy
MIGRATION_STATUS=$(dc --profile ops run --rm --no-deps migrate \
  bun apps/service/src/db/migrate.ts status)
grep -F 'applied  0001_initial_schema' <<<"$MIGRATION_STATUS" >/dev/null || die 'baseline not applied'
[[ "$(grep -Fc 'applied  ' <<<"$MIGRATION_STATUS")" -eq 1 ]] || die 'unexpected applied migrations'
if grep -Eiq 'pending|changed|missing' <<<"$MIGRATION_STATUS"; then die 'prior image rejects schema'; fi
QUICK=$(dc --profile ops run --rm --no-deps --entrypoint sqlite3 backup \
  -batch -readonly /source/nusend.sqlite 'PRAGMA quick_check;')
[[ "$QUICK" == ok ]] || die 'rollback quick_check failed'
FK=$(dc --profile ops run --rm --no-deps --entrypoint sqlite3 backup \
  -batch -readonly /source/nusend.sqlite 'PRAGMA foreign_key_check;')
[[ -z "$FK" ]] || die 'rollback foreign_key_check failed'
dc up -d --no-deps api
dc exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db');if(!r.ok)process.exit(1)"
CADDY_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc up -d --no-deps --force-recreate caddy
verify_caddy_acceptance
WORKER_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc up -d --no-deps worker
sleep 10
WORKER_ID=$(dc ps -q worker)
[[ -n "$WORKER_ID" && "$(docker inspect --format '{{.State.Running}}' "$WORKER_ID")" == true ]] || \
  die 'worker not running'
verify_worker_success || die 'worker/SES acceptance failed'
systemctl enable --now nusend-backup.timer
```

If compatibility is not proven, keep all handles stopped and use a reviewed forward fix or restore the selected pre-update snapshot **with its matching release/config** through step 11. Keep the failed DB/WAL/SHM set. Reverting an image does not reverse data; migration files only move forward.

## 11. Exact database restore

> **Live database replacement:** rehearse first. Select a full exact snapshot ID—never `latest`. The transaction below mechanically proves all DB-user containers and host handles are absent, restores inside `/var/lib/nusend`, captures migration/integrity results, preserves the complete current DB/WAL/SHM set, and only then performs a same-filesystem atomic rename. The `lsof` assertion accepts its documented no-match status `1` only when the tool and directory are accessible, stdout is empty, and separately captured stderr has zero diagnostics; an operational error cannot count as “no handles.” On any failure, the timer remains disabled and the script exits before the next step.

Replace the snapshot and known-data query, then run this entire fence as one Bash process. The query must return known owner/mailing/operations data appropriate to the selected recovery point; the placeholder intentionally fails closed.

```bash
set -Eeuo pipefail
die() { printf 'restore aborted: %s\n' "$*" >&2; exit 1; }
set -a
. /etc/nusend/compose.env
set +a
: "${NUSEND_CADDY_CONFIG_DIR:?select the direct or cloudflare Caddy directory}"
[ -f "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" ] || {
  printf 'selected Caddyfile does not exist: %s\n' "$NUSEND_CADDY_CONFIG_DIR/Caddyfile" >&2
  exit 1
}
case "$NUSEND_CADDY_CONFIG_DIR" in
  /opt/nusend/deploy/caddy/direct) NUSEND_INGRESS_MODE=direct ;;
  /opt/nusend/deploy/caddy/cloudflare) NUSEND_INGRESS_MODE=cloudflare ;;
  *) printf 'unsupported Caddy config directory: %s\n' "$NUSEND_CADDY_CONFIG_DIR" >&2; exit 1 ;;
esac
export NUSEND_INGRESS_MODE
dc() { docker compose --env-file /etc/nusend/compose.env -f /opt/nusend/compose.yaml "$@"; }
verify_worker_success() {
  local logs
  for _ in {1..60}; do
    logs=$(dc logs --no-color --no-log-prefix --since "$WORKER_STARTED_AT" worker 2>&1 || true)
    if grep -F '"claimed":' <<<"$logs" >/dev/null && \
       grep -F '"succeeded":' <<<"$logs" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
assert_no_db_users() {
  local service ids rc check_dir diagnostics
  for service in api worker migrate backup; do
    ids=$(docker ps -q --filter label=com.docker.compose.project=nusend \
      --filter "label=com.docker.compose.service=$service")
    [[ -z "$ids" ]] || die "running DB-user container: $service"
  done
  command -v lsof >/dev/null || die 'lsof is unavailable'
  [[ -d /var/lib/nusend && -r /var/lib/nusend && -x /var/lib/nusend ]] || \
    die 'database directory is not accessible'
  check_dir=$(mktemp -d /tmp/nusend-lsof.XXXXXX)
  if lsof +D /var/lib/nusend >"$check_dir/stdout" 2>"$check_dir/stderr"; then
    rc=0
  else
    rc=$?
  fi
  diagnostics=$(cat "$check_dir/stderr")
  if [[ -n "$diagnostics" ]]; then
    rm -rf -- "$check_dir"
    die "lsof emitted diagnostics; no-handle result is unproven: $diagnostics"
  fi
  if [[ $rc -eq 0 || -s "$check_dir/stdout" ]]; then
    rm -rf -- "$check_dir"
    die 'open handle remains under /var/lib/nusend'
  fi
  [[ $rc -eq 1 ]] || {
    rm -rf -- "$check_dir"
    die "lsof failed with operational status $rc"
  }
  rm -rf -- "$check_dir"
}
validate_sqlite() {
  local file=$1 quick fk
  quick=$(dc --profile ops run --rm --no-deps \
    --volume "$file:/restore/nusend.sqlite:ro" --entrypoint sqlite3 backup \
    -batch -readonly -cmd '.timeout 30000' /restore/nusend.sqlite 'PRAGMA quick_check;')
  [[ "$quick" == ok ]] || die 'quick_check failed'
  fk=$(dc --profile ops run --rm --no-deps \
    --volume "$file:/restore/nusend.sqlite:ro" --entrypoint sqlite3 backup \
    -batch -readonly -cmd '.timeout 30000' /restore/nusend.sqlite 'PRAGMA foreign_key_check;')
  [[ -z "$fk" ]] || die 'foreign_key_check failed'
}
cd /opt/nusend
SNAPSHOT_ID='full-64-character-reviewed-snapshot-id'
KNOWN_DATA_SQL='REPLACE WITH A REVIEWED READ-ONLY SELECT'
[[ "$SNAPSHOT_ID" =~ ^[0-9a-f]{64}$ ]] || die 'snapshot ID must be 64 lowercase hex characters'
[[ "$KNOWN_DATA_SQL" != 'REPLACE WITH A REVIEWED READ-ONLY SELECT' ]] || die 'known-data query not set'
RESTORE_DIR="/var/lib/nusend/.restore-$SNAPSHOT_ID"
RESTORE_FILE="$RESTORE_DIR/nusend.sqlite"
[[ ! -e "$RESTORE_DIR" ]] || die 'restore directory already exists'

systemctl disable --now nusend-backup.timer
systemctl stop nusend-backup.service
systemctl is-active --quiet nusend-backup.service && die 'backup service still active'
dc --profile ops stop worker api migrate backup
for service in api worker migrate backup; do
  IDS=$(docker ps -q --filter label=com.docker.compose.project=nusend \
    --filter "label=com.docker.compose.service=$service")
  [[ -z "$IDS" ]] || docker stop $IDS
done
assert_no_db_users

dc --profile ops run --rm --no-deps --volume /var/lib/nusend:/restore \
  --entrypoint sh backup -ceu '
    export AWS_ACCESS_KEY_ID="$(cat "$AWS_ACCESS_KEY_ID_FILE")"
    export AWS_SECRET_ACCESS_KEY="$(cat "$AWS_SECRET_ACCESS_KEY_FILE")"
    export AWS_DEFAULT_REGION=auto
    export RESTIC_REPOSITORY="s3:https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/nusend"
    exec restic -o s3.bucket-lookup=path restore "$1" --target "/restore/.restore-$1"
  ' sh "$SNAPSHOT_ID"
[[ -f "$RESTORE_FILE" ]] || die 'restored database missing'
chown -R 10001:10001 "$RESTORE_DIR"
chmod 0700 "$RESTORE_DIR"
chmod 0600 "$RESTORE_FILE"
[[ "$(stat -c %d "$RESTORE_FILE")" == "$(stat -c %d /var/lib/nusend)" ]] || die 'not same filesystem'
validate_sqlite "$RESTORE_FILE"
MIGRATION_STATUS=$(dc --profile ops run --rm --no-deps \
  -e "NUSEND_DB_PATH=$RESTORE_FILE" migrate bun apps/service/src/db/migrate.ts status)
grep -F 'applied  0001_initial_schema' <<<"$MIGRATION_STATUS" >/dev/null || die 'baseline not applied'
[[ "$(grep -Fc 'applied  ' <<<"$MIGRATION_STATUS")" -eq 1 ]] || die 'unexpected applied migrations'
if grep -Eiq 'pending|changed|missing' <<<"$MIGRATION_STATUS"; then die 'migration status invalid'; fi
KNOWN_DATA=$(dc --profile ops run --rm --no-deps \
  --volume "$RESTORE_FILE:/restore/nusend.sqlite:ro" --entrypoint sqlite3 backup \
  -batch -readonly /restore/nusend.sqlite "$KNOWN_DATA_SQL")
[[ -n "$KNOWN_DATA" ]] || die 'known recovery data absent'
assert_no_db_users

# A status read can create staged sidecars. Checkpoint only with every handle stopped,
# revalidate, then remove only those now-stale staged sidecars.
if [[ -e "$RESTORE_FILE-wal" || -e "$RESTORE_FILE-shm" ]]; then
  dc --profile ops run --rm --no-deps --volume "$RESTORE_DIR:/restore" \
    --entrypoint sqlite3 backup -batch -cmd '.timeout 30000' \
    /restore/nusend.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);'
  assert_no_db_users
  validate_sqlite "$RESTORE_FILE"
  rm -f -- "$RESTORE_FILE-wal" "$RESTORE_FILE-shm"
fi
assert_no_db_users
validate_sqlite "$RESTORE_FILE"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PRESERVE_DIR="/var/lib/nusend/pre-restore-$STAMP"
install -d -o 10001 -g 10001 -m 0700 "$PRESERVE_DIR"
for file in nusend.sqlite nusend.sqlite-wal nusend.sqlite-shm; do
  [[ ! -e "/var/lib/nusend/$file" ]] || mv -- "/var/lib/nusend/$file" "$PRESERVE_DIR/$file"
done
[[ ! -e /var/lib/nusend/nusend.sqlite-wal ]] || die 'destination WAL remains'
[[ ! -e /var/lib/nusend/nusend.sqlite-shm ]] || die 'destination SHM remains'
assert_no_db_users
chown 10001:10001 "$RESTORE_FILE"
chmod 0600 "$RESTORE_FILE"
mv -- "$RESTORE_FILE" /var/lib/nusend/nusend.sqlite
rmdir "$RESTORE_DIR"
[[ "$(stat -c '%u:%g:%a' /var/lib/nusend/nusend.sqlite)" == 10001:10001:600 ]] || \
  die 'restored database ownership/mode mismatch'

dc up -d --no-deps api
dc exec -T api bun -e \
  "const r=await fetch('http://127.0.0.1:3000/health/db');if(!r.ok)process.exit(1)"
curl --fail --show-error --silent https://mail.example.com/health >/dev/null
WORKER_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc up -d --no-deps worker
sleep 10
WORKER_ID=$(dc ps -q worker)
[[ -n "$WORKER_ID" && "$(docker inspect --format '{{.State.Running}}' "$WORKER_ID")" == true ]] || \
  die 'worker not running'
verify_worker_success || die 'worker/SES acceptance failed'
systemctl enable --now nusend-backup.timer
systemctl is-active --quiet nusend-backup.timer || die 'backup timer inactive'
printf 'restored_snapshot=%s preserved=%s\n' "$SNAPSHOT_ID" "$PRESERVE_DIR"
```

Never remove a WAL without the stopped-handle checkpoint and revalidation above; it may contain committed frames. Never copy only a live `nusend.sqlite`, merge sidecar sets, use a cross-filesystem copy, or restart a DB user after a failed assertion. If cutover fails before the final rename, keep all handles stopped and move the **complete** preserved set back to its original three names. Keep the preserved pre-restore set until application, owner, mailings, SES operations, the selected ingress/firewall policy, and a subsequent verified backup are confirmed.

Perform the initial drill before enabling the timer and a recurring **quarterly** drill to a separate path or server. Each drill selects an exact ID, runs SQLite and captured migration-status assertions, queries known data, records recovery time/snapshot ID, and never touches live DB names. A backup without an independently exercised restore is not a completed recovery gate.

## Retained runtime constraints

For file-backed production use, both the Bun application handle and the dedicated Better Auth handle use WAL with `synchronous=FULL`. Setup reads back `PRAGMA synchronous` and fails unless each handle reports mode `2`. FULL synchronizes the WAL at each commit to strengthen dispatch-ledger durability, with higher commit latency than NORMAL. This is not a backup or disaster-recovery mechanism.

Auth URL/trusted-origin HTTPS validation is conditional on `NODE_ENV=production`; Caddy automatic HTTPS and the selected DNS/firewall policy remain operator responsibilities. Direct mode trusts no proxy headers; Cloudflare mode trusts one Cloudflare edge boundary. Device throttling expects Caddy to supply the canonical final client address. Token ceilings are process-local (120/minute/source, 600/minute globally, 1024 active source keys), so each API process would have independent state; this bundle permits exactly one API.

CLI state uses atomic private-file replacement, but concurrent mutation is unsupported and the last completed writer wins. Deploy at a domain root/dedicated subdomain, not a sub-path, and keep `NUSEND_API_KEY_HASH_SECRET` stable.

## 12. Final staging gates

Before production, use only this runbook on a clean staging VPS and record evidence for:

- exact source/image digests and clean Compose render;
- reboot recovery of API, Caddy, worker, journal, and backup timer;
- selected-mode public ACME issuer/expiry, persistence after Caddy recreation/reboot, DNS/proxy state, and canonical client IP despite forged forwarding headers;
- direct mode: public 80/443 on `A` and only validated `AAAA`; Cloudflare mode: Full (strict), preserved ACME challenge, cache bypass, narrow callback skips, current CIDRs, and direct-origin rejection for every routable host IPv4/IPv6 with proven Docker forward/INPUT packet paths;
- internal/public health behavior, request body boundary, and sanitized bounded logs;
- owner bootstrap and SES/SNS readiness/simulator callback behavior;
- live private R2 initialization, on-demand verified snapshot, exact-ID independent restore/query, and quarterly-drill scheduling.

These are remaining operator/staging gates until actually executed and recorded; do not claim production readiness from documentation or local Docker checks alone.
