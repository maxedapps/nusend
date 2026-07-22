# Provision Nusend AWS resources with the AWS CLI

This guide is the canonical AWS setup sequence for Nusend. The executable AWS CLI logic lives in [`deploy/aws/`](../deploy/aws/); this document explains when to run each script, which choices and human approvals remain, and what must be true before continuing.

The scripts provision and validate:

- SES identity, Easy DKIM, account suppression, production access, and configuration sets;
- a restricted SNS feedback topic and SES event destinations;
- an encrypted SQS dead-letter queue with 14-day retention;
- a dedicated runtime IAM user and least-privilege policy;
- the confirmed HTTPS webhook subscription and redrive policy;
- CloudWatch alarms and a separate operator-notification topic;
- AWS state, Nusend readiness, live simulator feedback, and local suppressions.

Google OAuth, host deployment, ingress, and R2/restic remain in [`deployment.md`](./deployment.md).

> [!CAUTION]
> These scripts mutate AWS and may incur charges. Use a temporary trusted provisioning profile, never the Nusend runtime credentials. They do not print secret keys, but one script can create a secret access key in a protected local file after explicit confirmation.

## Command sequence

Run these commands individually from the repository root. External waits and human gates intentionally interrupt the sequence; there is no automatic `all` mode.

| When | Command | Outcome |
| --- | --- | --- |
| Before deployment | `deploy/aws/provision-aws.sh preflight` | Validate tools, configuration, caller, region, and names |
| Before deployment | `deploy/aws/provision-aws.sh ses` | SES identity, DKIM, suppression, production request, and configuration sets |
| Before deployment | `deploy/aws/provision-aws.sh feedback` | SNS feedback, SES event destinations, and SQS DLQ |
| Before deployment | `deploy/aws/provision-aws.sh iam` | Runtime IAM user, policy, and optional one-time key |
| Deployment boundary | Follow [`deployment.md`](./deployment.md) | Configure and start the public service |
| After deployment | `deploy/aws/finalize-aws.sh subscribe` | Confirm the HTTPS webhook and attach its DLQ |
| After deployment | `deploy/aws/finalize-aws.sh alarms` | Operator topic/email and four CloudWatch alarms |
| After deployment | `deploy/aws/finalize-aws.sh validate` | Read-only AWS validation |
| CLI workstation | `deploy/aws/validate-nusend.sh --pre-simulator` | API-backed readiness before live sends |
| Deployment host | `deploy/aws/run-simulator.sh` | Success, bounce, and complaint simulator mail |
| CLI workstation | `deploy/aws/validate-nusend.sh` | Final feedback and suppression validation |

All four public scripts support `--help`. The two AWS scripts load the setup file and resolve the provisioning caller with STS. `validate-nusend.sh` uses the deployed API; `run-simulator.sh` uses Docker on the deployment host. No script provides teardown.

## Re-execution behavior

| Resource or operation | Rerun behavior |
| --- | --- |
| SES identity and configuration sets | Create only when absent |
| SES event destinations | Create when absent, otherwise update |
| Account suppression | Reapply `BOUNCE` and `COMPLAINT` |
| Production-access request | Disabled by default; never submitted while review is pending |
| SNS topics | Reuse by exact name |
| SNS/SQS resource policies | Compare first; replace only after an explicit phrase when different |
| SQS DLQ | Reuse by exact name; converge retention and SQS-managed encryption |
| Runtime IAM policy | Compare first; replace only after an explicit phrase when different |
| Runtime access key | Offer creation only when the user has zero total keys; never recreate automatically |
| HTTPS subscription | Reuse the exact endpoint; refuse duplicates |
| Subscription attributes and alarms | Converge desired state |

Use dedicated Nusend resource names. The scripts intentionally replace policies and converge settings on those resources; do not point them at shared topics, queues, users, policies, event destinations, or alarms.

## Provision before deployment

### Prerequisites and configuration

#### Tools

Install:

- AWS CLI v2;
- `jq`;
- `curl`;
- `dig`;
- Docker Compose and the built Nusend CLI before full validation.

The two AWS scripts verify AWS CLI v2, `jq`, `curl`, and `dig`. `validate-nusend.sh` requires `jq`, `mktemp`, and the built/authenticated CLI; `run-simulator.sh` requires Docker Compose.

#### Provisioning permissions

Policy examples live beside the scripts:

| Policy | Applied to |
| --- | --- |
| [`provisioning-policy.example.json`](../deploy/aws/policies/provisioning-policy.example.json) | Temporary provisioning principal |
| [`runtime-policy.example.json`](../deploy/aws/policies/runtime-policy.example.json) | Dedicated runtime IAM user for stock Compose |
| [`sns-topic-policy.example.json`](../deploy/aws/policies/sns-topic-policy.example.json) | Dedicated feedback SNS topic |
| [`sns-dlq-policy.example.json`](../deploy/aws/policies/sns-dlq-policy.example.json) | Dedicated feedback DLQ |

Before running the scripts, replace the provisioning policy's sample account ID and runtime-user name, attach it to the temporary provisioner, and verify any organization SCP or permission boundary also allows the actions. Most statements use `Resource: "*"` because several account/list/create actions cannot be narrowed and the remaining resource names are operator-selected. Detach this policy after setup.

The three non-provisioning policy files are readable examples. The scripts generate account-, partition-, region-, and name-specific copies in a mode-0700 temporary work directory before applying them.

#### Create the setup file

```sh
cp deploy/aws/setup.conf.example .env.aws-setup
chmod 600 .env.aws-setup
```

`.env.aws-setup` is ignored by Git. It is trusted shell configuration and must be edited only by the operator. It must not contain AWS access keys.

Review every value, especially:

- `AWS_PROFILE`, `AWS_REGION`, and all dedicated resource names;
- `SES_IDENTITY` and the exact `SES_FROM_EMAIL` on that domain;
- `NUSEND_DOMAIN`, the public application hostname without a scheme;
- `ENABLE_MARKETING` and the marketing configuration-set name;
- `ENABLE_DELIVERY_EVENTS`; keep it `true` for end-to-end success validation;
- `TRACKING_EVENTS_JSON`; leave `[]` unless OPEN/CLICK privacy handling is approved;
- `ROUTE53_HOSTED_ZONE_ID`; leave empty for manual DNS;
- alarm topic/email settings or an existing same-account, same-region SNS topic ARN;
- SES production-access details; keep submission disabled until reviewed.

To keep the setup file elsewhere, prefix the AWS and Nusend-validation commands:

```sh
NUSEND_AWS_SETUP_CONFIG=/secure/path/setup.conf deploy/aws/provision-aws.sh preflight
```

### Verify the provisioning context

```sh
deploy/aws/provision-aws.sh preflight
```

**Expected outcome:** the script prints the setup path, caller ARN, 12-digit account, partition, region, deterministic AWS ARNs, runtime user name, and webhook URL.

> [!IMPORTANT]
> **Human gate:** stop if any caller, account, region, name, identity, or URL is unexpected. All SES resources are regional; an otherwise-correct setup in the wrong region is unusable.

### Provision SES and DKIM

```sh
deploy/aws/provision-aws.sh ses
```

The script:

1. creates or reuses the domain identity;
2. writes all Easy DKIM records to the printed work-directory path;
3. optionally asks for `APPLY-DKIM` before Route 53 UPSERTs;
4. enables account suppression for bounce and complaint;
5. inspects SES production access and optionally submits one reviewed request;
6. creates or reuses the enabled transactional and optional marketing configuration sets;
7. prints identity/DKIM status and an authoritative DNS lookup.

#### DNS choice

- **Route 53:** set the exact hosted-zone ID. The script refuses a zone whose name does not exactly match `SES_IDENTITY`, prints the change batch, and requires confirmation.
- **Another provider:** leave the ID empty and publish every CNAME from `dkim-records.tsv` manually. Account for providers that append the zone name automatically.

**Identity gate:** rerun this script after propagation until all four values are ready:

- `VerificationStatus=SUCCESS`;
- `VerifiedForSendingStatus=true`;
- `DkimSigningEnabled=true`;
- `DkimStatus=SUCCESS`.

SES may take up to 72 hours. Do not recreate the identity while waiting.

#### Production-access choice

Mailbox simulator addresses and verified recipients work in the sandbox. Real unverified recipients require production access in this region.

1. Review the website, contact email, mail type, consent model, unsubscribe behavior, frequency controls, and bounce/complaint handling.
2. Set `SUBMIT_PRODUCTION_ACCESS_REQUEST=true` only for the reviewed one-time submission.
3. Run the script and type `REQUEST-PRODUCTION-ACCESS`.
4. Immediately reset the switch to `false`.
5. Respond to AWS questions and rerun until `ProductionAccessEnabled=true`.

AWS—not the CLI—approves the request. Do not repeatedly resubmit pending or denied requests.

### Provision feedback infrastructure

```sh
deploy/aws/provision-aws.sh feedback
```

This command requires the SES configuration sets, then:

- creates or reuses a **Standard** SNS topic;
- sets SNS `SignatureVersion=2`, required by Nusend's RSA-SHA256 verifier;
- generates a topic policy restricted to SES, the account, and exact configuration-set ARNs;
- creates or updates the required SES event destinations;
- creates or reuses a Standard SQS DLQ;
- converges 14-day retention and SQS-managed encryption;
- generates a queue policy restricted to the exact feedback topic.

Required event types are `BOUNCE`, `COMPLAINT`, `REJECT`, and `DELIVERY_DELAY`. `DELIVERY` is enabled by default. OPEN/CLICK are added only to marketing when explicitly configured.

> [!CAUTION]
> **Policy gates:** when an existing policy differs, the script prints current and proposed documents and requires `APPLY-SNS-POLICY` or `APPLY-SQS-POLICY`. Applying either document replaces the entire resource policy. Continue only for dedicated Nusend resources.

**Expected outcome:** the script prints the exact topic ARN, queue URL, and queue ARN. No HTTPS subscription exists yet; Nusend must be publicly deployed with the topic ARN first.

### Provision runtime IAM credentials

```sh
deploy/aws/provision-aws.sh iam
```

The script generates the runtime policy from the exact identity, configuration sets, sender, and topic. It creates or reuses the dedicated runtime IAM user and compares its inline policy before asking for `APPLY-IAM-POLICY`.

The runtime policy permits only:

- SES account, identity, configuration-set, and event-destination reads;
- `ses:SendEmail` through the configured identity/configuration sets and exact From address;
- SNS topic/subscription reads required by readiness.

Stock Compose requires static AWS key variables. When the user has zero total access keys, the script offers one human-gated `CREATE-RUNTIME-KEY` operation. The secret is written once to:

```text
~/.config/nusend/runtime-access-key.json
```

The directory is mode `0700` and the file mode `0600`. If any active or inactive key exists, the script creates nothing because AWS cannot reveal its secret again.

> [!CAUTION]
> Transfer `AccessKey.AccessKeyId` and `AccessKey.SecretAccessKey` directly into the deployment secret store as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Do not print, paste, commit, or back up the temporary file. After successful deployment, remove it securely according to the workstation's storage model.

The script prints all non-secret AWS values needed by Nusend.

## Pause and deploy Nusend

Copy the IAM command's outputs and runtime key into `.env`, complete every other value in [`.env.example`](../.env.example), and follow [`deployment.md` through **Start and verify**](./deployment.md#start-and-verify).

At minimum, the deployment must use the exact:

- `AWS_REGION`;
- `NUSEND_SES_FROM_EMAIL`;
- transactional and optional marketing configuration-set names;
- `NUSEND_SES_FEEDBACK_TOPIC_ARNS` topic ARN;
- approved lower-case tracking events, when enabled;
- `NUSEND_DOMAIN` used by the setup file.

The runbook-created long-lived IAM key has no `AWS_SESSION_TOKEN`. Set that variable only when deliberately using temporary runtime credentials. Keep application AWS keys separate from R2 credentials.

**Deployment gate:** complete the deployment guide's health checks. The running API must already have the exact feedback topic ARN allowlisted and `NUSEND_PUBLIC_BASE_URL=https://$NUSEND_DOMAIN`; otherwise it cannot confirm the subscription.

## Finalize after deployment

### Subscribe the public webhook

```sh
deploy/aws/finalize-aws.sh subscribe
```

The script checks public health and requires `SUBSCRIBE-WEBHOOK` before creating anything. It reuses the exact topic/protocol/endpoint match, refuses duplicates, waits up to two minutes for Nusend's automatic signed confirmation, keeps the normal SNS JSON envelope, and attaches the DLQ.

**Expected outcome:** exactly one confirmed HTTPS subscription with:

- the exact `https://<domain>/api/webhooks/aws/sns/ses` endpoint;
- `PendingConfirmation=false`;
- `RawMessageDelivery=false`;
- a `RedrivePolicy` containing the expected DLQ ARN.

If confirmation stays pending, do not create another subscription. Inspect API/Caddy logs, the topic allowlist, public TLS, and outbound HTTPS access to regional SNS endpoints. Confirmation tokens expire after two days.

### Provision alarms

```sh
deploy/aws/finalize-aws.sh alarms
```

When `ALARM_ACTION_ARN` is empty, the script creates or reuses a separate SNS topic and exact email subscription. AWS sends a confirmation email; approve it and rerun the script. It refuses the SES feedback topic and requires any supplied topic ARN to be in the same account and region.

The script creates or updates alarms for:

- SNS `NumberOfNotificationsFailed`;
- SNS `NumberOfNotificationsRedrivenToDlq`;
- SNS `NumberOfNotificationsFailedToRedriveToDlq`;
- SQS `ApproximateNumberOfMessagesVisible`.

All alarms trigger above zero and treat missing data as non-breaching. Do not use SQS `NumberOfMessagesSent` for automatic SNS redrive activity.

> [!IMPORTANT]
> **Monitoring gate:** confirm every alarm has the intended action and exercise the notification path according to the incident procedure. A configured but untested alarm is not production evidence.

### Validate AWS state

From the trusted provisioning workstation:

```sh
deploy/aws/finalize-aws.sh validate
```

This read-only script verifies:

- SES production access, sending, account suppression, identity, and DKIM;
- exact restricted SNS topic-policy conditions and SignatureVersion 2;
- exactly one confirmed webhook subscription with the expected envelope and DLQ;
- DLQ ARN, 14-day retention, SQS-managed encryption, restricted policy, and zero visible messages;
- at least four matching CloudWatch alarms.

**Expected outcome:** `AWS-side validation passed.` Any visible DLQ message blocks success and requires investigation before deliberate replay.

### Validate readiness before simulator mail

On any trusted workstation, complete the deployment guide's [CLI build, login, and `whoami` checks](./deployment.md#source-built-cli), then run:

```sh
deploy/aws/validate-nusend.sh --pre-simulator
```

The pre-simulator mode calls the deployed API, which uses the runtime AWS credentials. It requires every named configuration, schema, SES, SNS, identity, DKIM, and event-destination readiness check to be `ok`; it deliberately does not claim live feedback.

The script uses the same `.env.aws-setup` only to determine whether marketing checks are required. It does not use local AWS credentials or Docker. Use `NUSEND_AWS_SETUP_CONFIG=/secure/path/setup.conf` when the setup file is elsewhere.

### Run live simulator scenarios

Run this script on the deployment host from the tagged checkout. It uses Docker only and does not require Node, pnpm, the Nusend CLI, or the provisioning setup file.

```sh
deploy/aws/run-simulator.sh
```

The script asks for `RUN-SES-SIMULATOR`, then runs success, bounce, and complaint inside the deployed API container. Success defaults to end-to-end and therefore requires `DELIVERY` events. If DELIVERY was intentionally disabled, use:

```sh
deploy/aws/run-simulator.sh --success-send-acceptance
```

Bounce and complaint always run end to end. Simulator mail does not affect SES reputation metrics, but AWS may rate-limit or bill it.

### Verify live feedback and suppressions

Return to the authenticated CLI workstation and run final mode:

```sh
deploy/aws/validate-nusend.sh
```

Final mode requires observed feedback plus protected global suppressions for both:

- `bounce@simulator.amazonses.com` with reason `bounce`;
- `complaint@simulator.amazonses.com` with reason `complaint`.

## Production gate

Automated success is not the final production gate. A human must still:

- confirm alarm delivery;
- review SES quotas and ramp volume gradually;
- publish and monitor DMARC, starting with an appropriate policy;
- verify SPF/DKIM/DMARC alignment on real mail;
- inspect Gmail **Show original** and confirm DKIM covers `List-Unsubscribe` and `List-Unsubscribe-Post` before marketing volume;
- approve OPEN/CLICK privacy and retention behavior when enabled;
- prove backup/restore, reboot recovery, host capacity, and incident procedures.

The application does not consume or replay DLQ messages. Any visible message requires operator investigation and deliberate replay after remediation.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `AccessDenied` during setup | Check the temporary provisioning policy, its customized runtime-user ARN, SCPs, permission boundaries, account, and region |
| Identity/DKIM remains pending | Compare every authoritative CNAME with the generated TSV; remove duplicate provider-appended zone names; wait and rerun `provision-aws.sh ses` |
| Production request remains pending | Monitor AWS contact channels and answer follow-up questions; do not resubmit |
| Event destination fails | Verify the SNS topic and configuration set are in the same account and region and the restricted topic policy matches the exact set ARN |
| Runtime policy differs every run | Inspect the existing inline policy for external edits and compare the generated work-directory JSON |
| Existing runtime key secret is unavailable | Perform an explicit create-new/deploy/deactivate-old rotation; never delete the only active key blindly |
| Webhook confirmation remains pending | Verify the deployed topic allowlist, public URL/TLS, API/Caddy logs, and outbound SNS HTTPS access |
| Alarm script requests email confirmation | Approve the one existing AWS email, then rerun; do not create duplicates |
| Readiness is not `ok` | Run `ses setup-guide`; correct the named config, IAM, identity, event, topic, or subscription check |
| Simulator times out | Run from the deployed API container, verify DELIVERY when testing success end to end, and inspect SNS/DLQ/API logs |
| DLQ contains messages | Inspect the signed webhook failure, remediate, then replay deliberately |

## Official AWS references

- [AWS CLI SESv2 commands](https://docs.aws.amazon.com/cli/latest/reference/sesv2/)
- [SES identity and DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [Request SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Manage SES sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)
- [SES SNS event-destination topic policy](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html)
- [Configure SNS signature version](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-configure-message-signature.html)
- [SNS subscriptions](https://docs.aws.amazon.com/sns/latest/dg/sns-create-subscribe-endpoint-to-topic.html)
- [SNS dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html)
- [SNS CloudWatch metrics](https://docs.aws.amazon.com/sns/latest/dg/sns-monitoring-using-cloudwatch.html)
- [SQS queue attributes](https://docs.aws.amazon.com/cli/latest/reference/sqs/set-queue-attributes.html)
- [SQS CloudWatch metrics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html)
- [CloudWatch metric alarms](https://docs.aws.amazon.com/cli/latest/reference/cloudwatch/put-metric-alarm.html)
- [SES v2 IAM actions and resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html)
- [IAM actions and resource types](https://docs.aws.amazon.com/service-authorization/latest/reference/list_iam.html)
- [SES DMARC guidance](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
