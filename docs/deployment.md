# Deploy and operate Nusend

Nusend is pre-launch, self-hosted software. Complete this procedure and the [pre-volume gates](#pre-volume-gates) before broad marketing use. Commands that provision providers may run from any trusted workstation; commands beginning with `docker compose` run from the tagged checkout on the deployment host.

## Deployment prerequisites

The host needs:

- Docker Engine and Docker Compose **5.3.0 or newer** (`docker compose version`)
- a public DNS name and provider firewall control
- Google OAuth, AWS SES/SNS/SQS/IAM, and private Cloudflare R2 access

The host needs neither Node nor pnpm. Install Node and pnpm 11 only on a machine where you intentionally [build the source CLI](#source-built-cli). The provider commands below require a configured AWS CLI; `jq` is used to create and validate policy JSON.

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

## AWS SES and SNS setup

Provision these resources **before** deployment. Use temporary provisioning credentials with the necessary administrative rights; do not put them in `.env`. Keep all resources in one AWS account and region.

Set reusable shell placeholders:

```sh
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012
SES_IDENTITY=example.com
SES_FROM_EMAIL=sender@example.com
SES_TRANSACTIONAL_SET=nusend-transactional-prod
SES_MARKETING_SET=nusend-marketing-prod
SNS_TOPIC_NAME=nusend-ses-events-prod
```

### Provision SES and SNS

1. In SES, request production access for non-simulator recipients.
2. Create or select the sending identity, publish its Easy DKIM DNS records, and wait for verified sending and successful DKIM:

   ```sh
   # Run create only for a new identity.
   aws sesv2 create-email-identity --region "$AWS_REGION" --email-identity "$SES_IDENTITY"
   aws sesv2 get-email-identity --region "$AWS_REGION" --email-identity "$SES_IDENTITY"
   ```

3. Enable account-level bounce and complaint suppression as defense in depth:

   ```sh
   aws sesv2 put-account-suppression-attributes --region "$AWS_REGION" \
     --suppressed-reasons BOUNCE COMPLAINT
   ```

4. Create both configuration sets and a Standard SNS topic, then require SNS SignatureVersion 2:

   ```sh
   aws sesv2 create-configuration-set --region "$AWS_REGION" \
     --configuration-set-name "$SES_TRANSACTIONAL_SET"
   aws sesv2 create-configuration-set --region "$AWS_REGION" \
     --configuration-set-name "$SES_MARKETING_SET"
   SNS_TOPIC_ARN=$(aws sns create-topic --region "$AWS_REGION" \
     --name "$SNS_TOPIC_NAME" --query TopicArn --output text)
   aws sns set-topic-attributes --region "$AWS_REGION" \
     --topic-arn "$SNS_TOPIC_ARN" \
     --attribute-name SignatureVersion --attribute-value 2
   ```

### Restrict the SNS topic policy

Allow SES to publish only from the two configuration sets. Save this expanded policy as `sns-topic-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSesConfigurationSets",
      "Effect": "Allow",
      "Principal": { "Service": "ses.amazonaws.com" },
      "Action": "sns:Publish",
      "Resource": "arn:aws:sns:us-east-1:123456789012:nusend-ses-events-prod",
      "Condition": {
        "StringEquals": {
          "AWS:SourceAccount": "123456789012",
          "AWS:SourceArn": [
            "arn:aws:ses:us-east-1:123456789012:configuration-set/nusend-transactional-prod",
            "arn:aws:ses:us-east-1:123456789012:configuration-set/nusend-marketing-prod"
          ]
        }
      }
    }
  ]
}
```

Validate and apply it:

```sh
jq empty sns-topic-policy.json
aws sns set-topic-attributes --region "$AWS_REGION" \
  --topic-arn "$SNS_TOPIC_ARN" \
  --attribute-name Policy --attribute-value file://sns-topic-policy.json
```

### Create SES event destinations

Both configuration sets require `BOUNCE`, `COMPLAINT`, `REJECT`, and `DELIVERY_DELAY`. `DELIVERY` is optional. Add `OPEN` and/or `CLICK` only to marketing when [engagement tracking](#engagement-tracking) is explicitly enabled.

```sh
TRACKING_EVENTS='[]' # or '["OPEN"]', '["CLICK"]', or '["OPEN","CLICK"]'

jq -n --arg topic "$SNS_TOPIC_ARN" '{
  Enabled: true,
  MatchingEventTypes: ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"],
  SnsDestination: { TopicArn: $topic }
}' > transactional-events.json

jq -n --arg topic "$SNS_TOPIC_ARN" --argjson tracking "$TRACKING_EVENTS" '{
  Enabled: true,
  MatchingEventTypes: (["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"] + $tracking),
  SnsDestination: { TopicArn: $topic }
}' > marketing-events.json

jq empty transactional-events.json marketing-events.json
aws sesv2 create-configuration-set-event-destination --region "$AWS_REGION" \
  --configuration-set-name "$SES_TRANSACTIONAL_SET" \
  --event-destination-name nusend-sns \
  --event-destination file://transactional-events.json
aws sesv2 create-configuration-set-event-destination --region "$AWS_REGION" \
  --configuration-set-name "$SES_MARKETING_SET" \
  --event-destination-name nusend-sns \
  --event-destination file://marketing-events.json
```

Do not create the HTTPS subscription yet; its public endpoint must be live first.

### Engagement tracking

Tracking is opt-in. If marketing event destinations include `OPEN` and/or `CLICK`, set the matching lower-case values in `NUSEND_SES_TRACKING_EVENTS`; optionally set a configured SES custom redirect domain. Transactional readiness remains base-event only.

Open tracking is affected by image blocking, proxying, and prefetching; click tracking rewrites links through SES. Tracking metadata can contain personal data such as IP addresses and user agents. Approve retention and privacy handling before enabling it.

## Runtime IAM policy

Create separate application credentials with only the runtime read/send actions used by Nusend. Replace every example value, retain both the exact sender and domain identity because readiness can fall back to the domain, and save as `nusend-runtime-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSesAccount",
      "Effect": "Allow",
      "Action": "ses:GetAccount",
      "Resource": "*"
    },
    {
      "Sid": "ReadSesIdentities",
      "Effect": "Allow",
      "Action": "ses:GetEmailIdentity",
      "Resource": [
        "arn:aws:ses:us-east-1:123456789012:identity/sender@example.com",
        "arn:aws:ses:us-east-1:123456789012:identity/example.com"
      ]
    },
    {
      "Sid": "ReadSesConfigurationSets",
      "Effect": "Allow",
      "Action": [
        "ses:GetConfigurationSet",
        "ses:GetConfigurationSetEventDestinations"
      ],
      "Resource": [
        "arn:aws:ses:us-east-1:123456789012:configuration-set/nusend-transactional-prod",
        "arn:aws:ses:us-east-1:123456789012:configuration-set/nusend-marketing-prod"
      ]
    },
    {
      "Sid": "SendOnlyFromNusend",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:us-east-1:123456789012:identity/sender@example.com",
        "arn:aws:ses:us-east-1:123456789012:identity/example.com",
        "arn:aws:ses:us-east-1:123456789012:configuration-set/nusend-transactional-prod",
        "arn:aws:ses:us-east-1:123456789012:configuration-set/nusend-marketing-prod"
      ],
      "Condition": {
        "StringEquals": { "ses:FromAddress": "sender@example.com" }
      }
    },
    {
      "Sid": "ReadFeedbackTopic",
      "Effect": "Allow",
      "Action": [
        "sns:GetTopicAttributes",
        "sns:ListSubscriptionsByTopic"
      ],
      "Resource": "arn:aws:sns:us-east-1:123456789012:nusend-ses-events-prod"
    }
  ]
}
```

Run `jq empty nusend-runtime-policy.json`, attach the policy to a dedicated IAM user or role, and place only those runtime credentials in `.env`. Readiness and setup-guide endpoints inspect AWS but never mutate it.

References: [SES v2 IAM actions and resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html) and [SES v2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html).

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

## Confirm SNS delivery and configure its DLQ

After the public webhook is live, subscribe the Standard topic:

```sh
aws sns subscribe --region "$AWS_REGION" \
  --topic-arn "$SNS_TOPIC_ARN" --protocol https \
  --notification-endpoint "https://${DOMAIN}/api/webhooks/aws/sns/ses" \
  --return-subscription-arn
```

Nusend validates the signed `SubscriptionConfirmation` and calls the region-matched SNS confirmation URL automatically. Wait until `ses readiness` reports a confirmed HTTPS subscription, then record its real ARN as `SNS_SUBSCRIPTION_ARN`.

Create a **Standard** SQS queue in the same account and region and record its URL and ARN:

```sh
SNS_DLQ_URL=$(aws sqs create-queue --region "$AWS_REGION" \
  --queue-name nusend-ses-webhook-dlq --query QueueUrl --output text)
SNS_DLQ_ARN=$(aws sqs get-queue-attributes --region "$AWS_REGION" \
  --queue-url "$SNS_DLQ_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)
```

Allow only this SNS topic to send to the queue. Save as `sns-dlq-policy.json`, replace values, and apply it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSnsSubscriptionRedrive",
      "Effect": "Allow",
      "Principal": { "Service": "sns.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:us-east-1:123456789012:nusend-ses-webhook-dlq",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "123456789012" },
        "ArnEquals": {
          "aws:SourceArn": "arn:aws:sns:us-east-1:123456789012:nusend-ses-events-prod"
        }
      }
    }
  ]
}
```

```sh
jq empty sns-dlq-policy.json
aws sqs set-queue-attributes --region "$AWS_REGION" \
  --queue-url "$SNS_DLQ_URL" \
  --attributes "$(jq -cn --rawfile policy sns-dlq-policy.json '{Policy:$policy}')"
aws sns set-subscription-attributes --region "$AWS_REGION" \
  --subscription-arn "$SNS_SUBSCRIPTION_ARN" \
  --attribute-name RedrivePolicy \
  --attribute-value "{\"deadLetterTargetArn\":\"${SNS_DLQ_ARN}\"}"
```

Create CloudWatch alarms at a greater-than-zero threshold for:

| Scope | Metric | Meaning |
| --- | --- | --- |
| SNS topic | `NumberOfNotificationsFailed` | HTTPS delivery attempts are failing |
| SNS topic | `NumberOfNotificationsRedrivenToDlq` and `NumberOfNotificationsFailedToRedriveToDlq` | messages reached the DLQ or could not be moved there |
| SQS DLQ | `ApproximateNumberOfMessagesVisible` | messages require operator investigation |

Do not use SQS `NumberOfMessagesSent` for DLQ activity; automatic redrive is not represented reliably. Reference: [SNS dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html).

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

### SES readiness

```sh
./apps/cli/dist/main.js ses readiness --no-aws
./apps/cli/dist/main.js ses readiness
./apps/cli/dist/main.js ses setup-guide
```

Readiness reports local config/schema, SES account and identity/DKIM, configuration sets and event destinations, SNS SignatureVersion 2 and confirmed webhook, and observed feedback. Missing setup remains actionable rather than becoming an internal error. Resolve every required error before sending; OPEN/CLICK are checked only when configured for marketing.

### SES simulator validation

Run the simulator in the deployed API container so end-to-end mode polls the same database that receives SNS callbacks:

```sh
docker compose exec -T api bun apps/service/src/ses/simulator-main.ts \
  success --purpose transactional --mode send-acceptance
docker compose exec -T api bun apps/service/src/ses/simulator-main.ts \
  bounce --purpose transactional --mode end-to-end
docker compose exec -T api bun apps/service/src/ses/simulator-main.ts \
  complaint --purpose transactional --mode end-to-end
./apps/cli/dist/main.js ses simulator-runs list
./apps/cli/dist/main.js ses simulator-runs get <id>
```

Other scenarios are `ooto`, `suppressionlist`, and `all`. `send-acceptance` proves SES accepted or rejected the send but not SNS delivery; `end-to-end` waits for the matching local event. Remote `--target-url` validation is not implemented. Simulator mail does not affect SES reputation metrics, but AWS can rate-limit or bill it.

### CLI automation and local state

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
- Prove live SES/SNS feedback with deployed success, bounce, and complaint simulator runs; bounce/complaint must create protected local suppressions.
- In Gmail **Show original**, verify DKIM covers `List-Unsubscribe` and `List-Unsubscribe-Post` before marketing volume.
- Verify readiness has no required errors, account suppression covers bounce/complaint, and the confirmed SNS subscription has its DLQ and alarms.
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
| SES readiness reports errors | Use `ses setup-guide`; correct IAM, identity/DKIM, configuration sets, events, topic signature/policy, or subscription state. |
| Simulator end-to-end times out | Confirm it ran in the deployed API container and that SNS targets this instance. |
| SNS DLQ has visible messages | Inspect the signed webhook failure and retained SES event, remediate, then replay deliberately. |
| Backup is unhealthy or restore fails | Inspect backup logs and verify separate R2 credentials, repository endpoint, restic password, and explicit snapshot ID. |
