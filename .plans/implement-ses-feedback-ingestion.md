# Implement SES Feedback Ingestion via SES Configuration Sets and SNS

## Summary

Add self-managed SES feedback ingestion so Nusend can receive SES bounce, complaint, reject, and delivery-delay events from SES configuration-set event publishing through SNS, verify SNS messages, persist event audit records, and update local suppressions for reputation-critical events.

This is the next compliance/deliverability milestone after unsubscribe support and should be completed before real marketing volume.

This plan intentionally does **not** reintroduce `deliveries.status = bounced|complained|delivered`. Current delivery status remains send-processing status (`queued|sending|sent|failed|suppressed`). SES feedback becomes a separate event/audit model plus suppression side effects.

## Requirements and assumptions

- Use SES **configuration sets** for event publishing; do not use identity-level feedback notifications as the primary mechanism.
- Use SNS as the SES event destination.
- Chosen ingestion path for this milestone: SNS HTTPS webhook at Nusend, with an explicitly documented SNS→SQS worker alternative.
- Keep local SQLite `suppressions` as Nusend's send-policy source of truth.
- Enable SES account-level suppression for `BOUNCE` and `COMPLAINT` as defense in depth, not as the app source of truth.
- Keep `EmailTransport` purpose-agnostic; it already sends `configurationSetName` and `EmailTags` from `PreparedEmail`.
- Preserve one SES `SendEmail` call per delivery/recipient. This is important because complaint notifications can redact the exact complainer and become ambiguous for multi-recipient messages.
- Transactional sending must not be affected by marketing unsubscribe state. Global hard-bounce/complaint suppressions intentionally affect both transactional and marketing sends because they are reputation-critical.
- Automated tests first; live SES credentials are only needed for manual validation after implementation.
- Vetoable assumption: keep `NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET` optional in code for compatibility, but document clearly that **transactional feedback ingestion does not happen without a transactional configuration set**.

## Research findings

### SES configuration sets and event publishing

- SES configuration sets are groups of rules applied to sent mail. They support event destinations and dedicated IP pool management; AWS explicitly calls out separating marketing and transactional reputation when using dedicated IP pools.
  - https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets.html
- SES event publishing requires: create configuration set, add event destination, specify the configuration set when sending.
  - https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-using-event-publishing-setup.html
- SES supports SNS event destinations on configuration sets.
  - https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html
- For SES API sends, config sets and message tags can be provided as API parameters. Nusend already uses SESv2 API parameters.
  - https://docs.aws.amazon.com/ses/latest/dg/event-publishing-send-email.html
- Event destinations can publish `Bounce`, `Complaint`, `Reject`, `DeliveryDelay`, `Delivery`, `Send`, `Open`, `Click`, `Rendering Failure`, and `Subscription` events.
  - https://docs.aws.amazon.com/ses/latest/dg/event-destinations-manage.html

Recommended event types for this milestone:

- Required: `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY`
- Optional: `DELIVERY` for operations visibility
- Do not enable `OPEN` / `CLICK` initially.

### SES event payloads

- Configuration-set event publishing uses `eventType`; older identity feedback notifications use `notificationType`.
- SES warns notifications may contain multiple recipients, arrive unordered, have multiple event types for one recipient, and gain unknown fields over time. Parser schemas must tolerate unknown fields.
- Bounce notifications include `bounceType`, `bounceSubType`, `bouncedRecipients`, `feedbackId`.
- Complaint notifications include `complainedRecipients`, `feedbackId`, optional `complaintFeedbackType`, and may contain only likely recipients because many ISPs redact the exact complainer.
- Event-publishing payloads include `mail.tags`, including custom `EmailTags` when using configuration sets.
  - https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html
  - https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html
  - https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html

### SNS webhook behavior and security

- SNS HTTP/S endpoints must handle `SubscriptionConfirmation`, `Notification`, and optionally `UnsubscribeConfirmation` messages.
- SNS sends the message type in `x-amz-sns-message-type` and a JSON envelope body, commonly with `text/plain; charset=UTF-8`.
- AWS says SNS signatures **must** be verified before processing notifications and subscription confirmations; SignatureVersion 2 uses SHA-256 and is recommended.
- Always reject unexpected `TopicArn` values.
  - https://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.prepare.html
  - https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
  - https://docs.aws.amazon.com/sns/latest/dg/http-subscription-confirmation-json.html
- SNS treats HTTP `5xx` and `429` as retryable. Other non-2xx client errors are permanent. Treat an SQS DLQ on the SNS subscription as **required**; without it, config regressions or permanent endpoint failures can lose events after retry/non-retry handling.
  - https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html
  - https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html

### SNS signature validator package

- AWS publishes the official Node SNS validator package as `sns-validator`, with `@types/sns-validator` available. It validates `SigningCertURL`, `SignatureVersion`, and `Signature`.
  - https://github.com/aws/aws-js-sns-message-validator
  - https://www.npmjs.com/package/sns-validator
- Source inspection of the current package shows it supports SignatureVersion `1` and `2`, using `RSA-SHA1` for v1 and `RSA-SHA256` for v2:
  - https://raw.githubusercontent.com/aws/aws-js-sns-message-validator/master/index.js
- The package is old and callback-based. Wrap it behind a Nusend `SnsMessageVerifier` service so it can be replaced later.

### SES suppression and simulator

- SES account-level suppression can be enabled for `BOUNCE` and `COMPLAINT`; it is region/account-specific and case-sensitive for APIs. Use it as defense in depth.
  - https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html
- SES mailbox simulator supports:
  - `bounce@simulator.amazonses.com`
  - `complaint@simulator.amazonses.com`
- Simulator events do not count toward bounce/complaint rates or deliverability metrics.
  - https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html

### SNS→SQS alternative

SNS can also deliver SES events to SQS. This avoids public webhook signature handling, subscription-confirmation SSRF concerns, and HTTP retry behavior. It would require a new SQS polling worker and `@aws-sdk/client-sqs` integration.

Chosen for this milestone: HTTPS webhook, because:

- The user specifically asked about SNS endpoint/webhook flow.
- Nusend already has a public HTTPS app for unsubscribe links.
- It avoids requiring AWS credentials in the API service for SQS polling.
- It is simpler operationally for a single self-hosted instance.

Revisit SNS→SQS if webhook delivery/retry/security complexity becomes painful or if the project adds more AWS event consumers.

## Current codebase findings

- `apps/service/src/sending/prepare.ts`
  - Builds SES tags: `delivery_id`, `mailing_id`, `purpose`.
  - Selects transactional vs marketing configuration set from sending config.
  - Adds one-click unsubscribe headers for marketing.
- `apps/service/src/services/email-transport-ses.ts`
  - Uses SESv2 `SendEmailCommand.ConfigurationSetName` and `EmailTags`.
  - Sends one recipient per command (`Destination.ToAddresses: [email.to]`).
- `apps/service/src/sending/policy.ts`
  - Applies local `suppressions` before sending.
  - Marketing sends retry when unsubscribe config or marketing config set is missing.
- `apps/service/src/unsubscribe/unsubscribe.ts`
  - Inserts local marketing unsubscribe suppressions.
  - Existing `suppressions` supports reasons `bounce|complaint|unsubscribe|manual`.
- `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
  - Already has `suppressions` table and unique indexes.
- `apps/service/src/db/migrations/sql/0002_simplify_send_queue_and_states.sql`
  - Current delivery statuses intentionally exclude future-only `bounced`, `complained`, and `delivered` states.
- `apps/service/src/http/respond.ts`
  - `AppRuntime` currently provides auth/database/id/unsubscribe config; webhook needs SNS feedback config and verifier services.
- `apps/service/src/main.ts`
  - API service currently does not require SES send-worker config. Feedback webhook should have its own optional config group.
- `README.md` / `PROJECT.md`
  - Currently describe SES bounce/complaint ingestion as future work; update after implementation.

## Chosen implementation strategy

Use a public SNS HTTPS webhook backed by small Effect services:

1. Parse the raw SNS JSON envelope for signature verification without dropping any fields.
2. Verify SNS signature using `SnsMessageVerifier` backed by `sns-validator` in production and fakes in tests.
3. Enforce exact allowed `TopicArn` values from `NUSEND_SES_FEEDBACK_TOPIC_ARNS`.
4. Decode the already-verified SNS envelope with Effect `Schema` for app use.
5. Handle `SubscriptionConfirmation` by validating and visiting `SubscribeURL` through a small `SnsSubscriptionConfirmer` service after signature + topic allowlist + URL checks; persist a notification audit row for verified confirmations after successful confirmation.
6. Handle `Notification` by parsing nested SES event JSON, inserting idempotent notification/recipient audit rows, and applying local suppressions for hard bounces and complaints.
7. Make all writes idempotent. Do not depend on DB affected-row counts because `DatabaseService.run` returns `void`.
8. Keep all network effects outside SQLite transactions.

Route response policy:

- `204`: success, idempotent duplicate, subscription confirmed, or authentic-but-unrecognized SES event recorded/ignored.
- `400`: malformed outer JSON or invalid SNS envelope shape before signature verification.
- `403`: invalid SNS signature or unexpected `TopicArn`.
- `404`: feedback config absent/disabled.
- `500`: DB/internal/transient confirmation failures so SNS retries.

## Alternatives considered

### Identity-level SES notifications

Rejected as primary path. Identity notifications are simpler but are not tied to per-send configuration sets, do not provide the same event-tag path, and couple all mail from an identity to one feedback route.

### SNS→SQS worker instead of webhook

Viable and potentially more secure for a larger AWS-heavy deployment. Rejected for this milestone because it adds a new AWS SDK dependency and a new worker/operational process, while the user asked specifically about webhook mechanics and the app already exposes public HTTPS routes.

If chosen later, use:

```txt
SES configuration set -> SNS topic -> SQS queue -> Nusend feedback worker -> SQLite
```

### Manual SNS signature verification

Rejected initially. It is security-sensitive: canonical string ordering, cert URL validation, certificate retrieval, and signature versions are easy to get wrong. Use AWS's official `sns-validator` wrapper first.

### Raw SNS message delivery

Rejected. Raw delivery would bypass the SNS envelope/signature fields needed by this webhook pattern. Keep default non-raw delivery.

### Update `deliveries.status` to `bounced` / `complained`

Rejected. The recent state simplification made delivery status send-processing-specific. SES feedback should be modeled separately unless a future product decision redefines delivery status.

### Use SES managed lists / `ListManagementOptions`

Rejected. Nusend already self-manages unsubscribe and suppression state; SES managed lists would create a second source of truth.

## Data model changes

Add migration:

```txt
apps/service/src/db/migrations/sql/0003_ses_feedback_ingestion.sql
```

Use the existing migration format with exactly one `-- migrate:up` and one `-- migrate:down` marker.

Recommended tables:

```sql
-- migrate:up
CREATE TABLE ses_feedback_notifications (
  sns_message_id TEXT PRIMARY KEY,
  sns_topic_arn TEXT NOT NULL,
  sns_type TEXT NOT NULL CHECK (sns_type IN ('Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation')),
  event_type TEXT,
  ses_message_id TEXT,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ses_feedback_recipients (
  id TEXT PRIMARY KEY,
  sns_message_id TEXT NOT NULL REFERENCES ses_feedback_notifications(sns_message_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  ses_message_id TEXT,
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  feedback_id TEXT,
  bounce_type TEXT,
  bounce_sub_type TEXT,
  complaint_feedback_type TEXT,
  diagnostic_code TEXT,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('recorded', 'suppressed', 'ignored')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (sns_message_id, recipient_email, event_type)
);

CREATE INDEX ses_feedback_recipients_delivery_id_idx ON ses_feedback_recipients (delivery_id);
CREATE INDEX ses_feedback_recipients_ses_message_id_idx ON ses_feedback_recipients (ses_message_id);
CREATE INDEX ses_feedback_recipients_email_idx ON ses_feedback_recipients (recipient_email);
CREATE INDEX ses_feedback_recipients_event_created_idx ON ses_feedback_recipients (event_type, created_at);

-- migrate:down
DROP TABLE IF EXISTS ses_feedback_recipients;
DROP TABLE IF EXISTS ses_feedback_notifications;
```

Notes:

- Store full raw SNS/SES JSON only in `ses_feedback_notifications.raw_json`; operations APIs must not expose it by default.
- Pass `received_at` and `created_at` explicitly from `currentIso`; the DDL defaults are only safety nets and tests should use Clock/TestClock deterministically.
- Drop `processed_at`; successful row existence after the transaction is the processing marker.
- Verified `SubscriptionConfirmation` / `UnsubscribeConfirmation` messages should create notification audit rows (no recipient rows). Insert the confirmation row after successful confirmation so a failed confirmation is not deduped as handled.
- Use `sns_message_id` as the notification idempotency key because SNS retries use the original message ID.
- Per-recipient rows support multi-recipient notifications even though Nusend sends one recipient per SES call.
- Keep `delivery_id` nullable because old/unmatched SES events can still be useful for audit and suppression.
- Make all writes idempotent:
  - notification insert: `ON CONFLICT(sns_message_id) DO NOTHING`,
  - recipient insert: `ON CONFLICT(sns_message_id, recipient_email, event_type) DO NOTHING`,
  - suppression insert: existing partial-index conflict `DO NOTHING`.
- Do not branch on insert affected-row counts; the DB service does not expose them.

## Config and service additions

### New config

Follow the unsubscribe config layout: define the domain config type next to the service in `apps/service/src/ses-feedback/config.ts`, then re-export/use that type from `apps/service/src/config.ts` where the env parser lives.

```ts
export type SesFeedbackConfig = {
  readonly topicArns: readonly string[];
};
```

Env:

```sh
NUSEND_SES_FEEDBACK_TOPIC_ARNS=arn:aws:sns:us-east-1:123456789012:nusend-ses-feedback-prod
```

Semantics:

- Empty/whitespace means feedback webhook disabled.
- Comma-separated non-empty ARNs enable the route.
- Validate basic ARN shape: `arn:aws:sns:<region>:<account>:<topic>` and, if easy, partition variants such as `aws-us-gov` / `aws-cn`.
- Do not require SES send-worker env in the API service.
- Document that no events are emitted for sends that do not specify an SES configuration set.

### New services

Add `apps/service/src/ses-feedback/config.ts`:

- `SesFeedbackConfig` Context service containing `Option<SesFeedbackConfig>`.
- `SesFeedbackConfigLive(config)` layer.

Add `apps/service/src/ses-feedback/sns-verifier.ts`:

- `SnsMessageVerifier` service:

```ts
verify(message: unknown): Effect.Effect<VerifiedSnsEnvelope, SnsVerificationError>
```

- Live implementation wraps `sns-validator`.
- First verify the wrapper under Bun before building the rest of the feature: the library is old and uses Node `https`/`crypto`/`url.parse`; source inspection shows SigV2 support, but Bun compatibility must be pinned by a smoke test.
- Check whether the installed version caches signing certificates in memory; if it fetches per message, note the extra HTTPS round trip in docs/tests.
- Test implementation accepts/rejects deterministically.
- Add `SnsVerificationError` tagged error.
- Important: call verifier with the full raw parsed SNS object before app schema decoding strips fields.

Add `apps/service/src/ses-feedback/sns-confirmer.ts`:

- `SnsSubscriptionConfirmer` service:

```ts
confirm(subscribeUrl: string): Effect.Effect<void, SnsConfirmationError>
```

- Live implementation uses `fetch` to GET `SubscribeURL` only after:
  - parsed URL uses HTTPS,
  - hostname matches expected SNS host patterns for the message region/partition,
  - original SNS envelope was signature-verified and topic-allowlisted.
- Fake test implementation records calls.

Wire services into:

- `apps/service/src/main.ts`
- `apps/service/src/testing/layers.ts`
- `apps/service/src/http/respond.ts` `AppServices` type only; do **not** widen `RouteError` for webhook-specific errors.

## Route/API changes

Add public route module:

```txt
apps/service/src/ses-feedback/routes.ts
```

Mount in `apps/service/src/app.ts`:

```txt
POST /api/webhooks/aws/sns/ses
```

Route behavior:

1. Apply `bodyLimit`, suggested max `512kb` because SNS message payload can be 256 KB before envelope/signature escaping overhead.
2. Read raw body with `context.req.text()`.
3. Run `handleSesFeedbackSnsRequest(rawBody)`.
4. Return empty responses:
   - `204` success / duplicate / subscription confirmed / known ignored event,
   - `400` malformed request before trust is established,
   - `403` invalid verifier/topic,
   - `404` disabled,
   - `500` transient internal failure.

Do not expose detailed error bodies on this public endpoint.

Do not route this through `runRoute`, because `runRoute` maps errors to JSON envelopes and its `RouteError` union belongs to normal API routes. Add a small dedicated `runWebhookRoute` in `http/respond.ts` (following the `runHtmlRoute` precedent) or keep an equivalent local runner in `ses-feedback/routes.ts`. It should map webhook-specific tagged errors to bare status codes and return an empty `500` for unhandled causes after sanitized logging.

## Domain modules

### `apps/service/src/ses-feedback/sns-schema.ts`

Parsing must be split:

1. Outer envelope for signature verification:
   - Preferred first attempt: pass the raw body string directly to `sns-validator.validate(...)`, because the package accepts strings and parses internally while preserving all fields required for signature verification.
   - If the string path is awkward or fails under Bun, use a direct `JSON.parse(rawBody)` fallback so `sns-validator` sees all original fields, including `Token` for subscription confirmations. Add that new parse site to `.plans/migrate-to-effect-v4-bun.md` with a comment explaining it is required for SNS signature verification.
2. App-level schema decoding after signature verification:
   - Use Effect `Schema` to validate app-needed fields.

Schema should accept:

- `Type`: `Notification | SubscriptionConfirmation | UnsubscribeConfirmation`
- `MessageId`
- `TopicArn`
- `Message`
- `Timestamp`
- `SignatureVersion`
- `Signature`
- `SigningCertURL`
- `Token` for subscription confirmations
- optional `SubscribeURL`, `Subject`, `UnsubscribeURL`

Keep schema permissive for unknown fields.

### `apps/service/src/ses-feedback/ses-event-schema.ts`

Use `Schema.fromJsonString` for the nested SNS `Message` string.

Support at least:

- `eventType`
- `mail.messageId`
- `mail.destination`
- `mail.tags` as `Record<string, readonly string[]>`
- `bounce.bouncedRecipients[]`
- `complaint.complainedRecipients[]`
- `deliveryDelay.delayedRecipients[]`
- `reject.reason`
- optional `delivery.recipients[]`

Tolerate unknown fields and unknown event types.

### `apps/service/src/ses-feedback/process.ts`

Main function:

```ts
handleSesFeedbackSnsRequest(rawBody: string): Effect.Effect<void, SesFeedbackError | DatabaseError, Services>
```

Processing rules:

- If feedback config is absent, fail as disabled so route returns `404`.
- Parse/verify the raw outer SNS envelope: prefer handing the raw body string to `SnsMessageVerifier`; use an allowlisted raw `JSON.parse` only if the wrapper requires it.
- Verify signature via `SnsMessageVerifier` before trusting the envelope.
- Reject if `TopicArn` is not exactly in allowed topic ARNs.
- Decode verified envelope with app schema.
- `SubscriptionConfirmation`:
  - call `SnsSubscriptionConfirmer.confirm(SubscribeURL)` after URL checks;
  - after confirmation succeeds, insert an idempotent notification audit row with explicit `$now`;
  - do not create recipient rows.
- `UnsubscribeConfirmation`:
  - after signature/topic validation, insert an idempotent notification audit row with explicit `$now`;
  - do not create recipient rows.
- `Notification`:
  - decode nested SES event;
  - derive affected recipients;
  - resolve delivery/mailing by:
    1. `mail.tags.delivery_id[0]` if present and matching `deliveries.id`, preferably with matching recipient email;
    2. fallback to `deliveries.ses_message_id = mail.messageId`;
    3. fallback unmatched with `delivery_id = NULL`.
  - process DB writes in one transaction;
  - all network effects must already be complete before transaction starts.

Recipient derivation:

- `Bounce`: `bounce.bouncedRecipients[].emailAddress`
- `Complaint`: `complaint.complainedRecipients[].emailAddress`
- `DeliveryDelay`: `deliveryDelay.delayedRecipients[].emailAddress`
- `Delivery`: `delivery.recipients[]` if enabled
- `Reject`: `mail.destination[]` because reject applies to whole message
- Unknown/unhandled authentic event type: insert notification row, optionally no recipient rows, return `204`.

Suppression rules:

- `Bounce`:
  - If `bounceType === 'Permanent'`, insert `scope='all'`, `reason='bounce'` for each bounced recipient with a known email.
  - For `Transient` and `Undetermined`, record only; do not auto-suppress initially.
- `Complaint`:
  - If `complaintFeedbackType === 'not-spam'`, record only; do not suppress.
  - For absent type or any other type, insert `scope='all'`, `reason='complaint'` for each complained recipient.
- `Reject` and `DeliveryDelay`:
  - Record only; do not suppress.

Suppression insert SQL:

```sql
INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
VALUES ($id, $email, 'all', NULL, $reason, $now)
ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING;
```

Do not overwrite existing manual/unsubscribe/bounce/complaint suppressions in this milestone; feedback event rows remain the audit trail.

## Operations/read-model updates

Required:

- Add `GET /api/operations/ses-feedback` with existing operations read auth.
- Return sanitized recent feedback recipient rows:
  - id
  - eventType
  - actionTaken
  - deliveryId
  - mailingId
  - sesMessageId
  - recipientEmail
  - feedbackId
  - bounceType / bounceSubType
  - complaintFeedbackType
  - diagnosticCode truncated to a safe length
  - createdAt
- Do **not** return `raw_json`, arbitrary headers, or full nested SES payloads.

Optional secondary update:

- Include recent SES feedback in `/api/operations/summary.recentIssues` with `kind: 'ses_feedback'`.
- Do not rely on summary alone because its `LIMIT 10` can bury feedback among job/attempt errors.

Tests must cover the required dedicated endpoint and any summary extension.

## AWS setup/runbook documentation

Update `README.md` with a production setup section.

Recommended AWS-side setup:

1. Create one SNS **Standard** topic, e.g. `nusend-ses-feedback-prod`.
2. Create or choose an SQS DLQ in the same account/region and attach it to the SNS HTTPS subscription. This is required, not optional.
3. Give SES permission to publish to the topic with a topic policy constrained by account and configuration-set source ARN where possible.
4. Create SES configuration sets:
   - `nusend-transactional-prod`
   - `nusend-marketing-prod`
5. Add SNS event destinations to both config sets with matching event types:
   - required: `BOUNCE`, `COMPLAINT`, `REJECT`, `DELIVERY_DELAY`
   - optional: `DELIVERY`
   - not initially: `OPEN`, `CLICK`
6. Subscribe this HTTPS endpoint to the SNS topic with default non-raw delivery:

```txt
https://<public-host>/api/webhooks/aws/sns/ses
```

7. Configure endpoint retry policy and DLQ; alarm on DLQ visible messages. Document the failure mode: if `NUSEND_SES_FEEDBACK_TOPIC_ARNS` is accidentally removed while the SNS subscription still exists, the webhook returns `404`, SNS treats it as non-retryable, and events must land in the DLQ for later redrive.
8. Ensure app egress can fetch SNS signing certificates and `SubscribeURL` over HTTPS.
9. Set env:

```sh
NUSEND_SES_FEEDBACK_TOPIC_ARNS=arn:aws:sns:us-east-1:123456789012:nusend-ses-feedback-prod
NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET=nusend-transactional-prod
NUSEND_SES_MARKETING_CONFIGURATION_SET=nusend-marketing-prod
```

10. Enable SES account-level suppression for defense in depth:

```sh
aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT
```

11. Test with SES simulator addresses:

```txt
bounce@simulator.amazonses.com
complaint@simulator.amazonses.com
```

Document plainly:

- No SES feedback events are emitted for a send unless that send uses a configuration set with an event destination.
- Simulator events do not affect SES reputation metrics.

## Step-by-step implementation tasks

### Phase 1 — Dependencies and config

1. Add dependencies:
   - `sns-validator` in `apps/service/package.json` dependencies
   - `@types/sns-validator` in devDependencies (prefer the workspace/root devDependency pattern unless TypeScript resolution requires the service package)
2. Add `sesFeedbackConfig` parser to `apps/service/src/config.ts`.
3. Add config tests in `apps/service/src/config.test.ts`:
   - absent config returns `Option.none`,
   - trims comma-separated ARNs,
   - rejects invalid ARN entries,
   - keeps API service independent from send-worker SES config.
4. Add `apps/service/src/ses-feedback/config.ts` and wire default `Option.none()` in test layers.

### Phase 2 — SNS verifier/confirmer services

1. First create a minimal `SnsMessageVerifier` wrapper and run a Bun compatibility smoke for `sns-validator` before implementing dependent logic.
2. Prefer passing the raw body string to the wrapper; otherwise ensure it receives the full raw parsed SNS object before schema stripping.
3. Confirm SignatureVersion 1 and 2 behavior from package source/tests and note certificate caching behavior.
4. Add fake verifier layer for route/domain tests.
5. Add `SnsSubscriptionConfirmer` service wrapping `fetch`.
6. Add SubscribeURL hostname/protocol validation.
7. Add tests:
   - verifier rejects malformed required SNS fields,
   - verifier supports SignatureVersion `2` based on package source/wrapper behavior,
   - subscription confirmation preserves `Token`,
   - confirmer rejects non-HTTPS / non-SNS URLs,
   - confirmer calls expected URL only after validation.

### Phase 3 — Schema and parser modules

1. Add raw outer envelope verification helper for SNS signature verification: prefer raw-string validation; add a raw JSON parse helper only if needed by the wrapper.
2. Add app-level SNS envelope schema.
3. Add SES event schema using `Schema.fromJsonString` for nested `Message`.
4. Add parser tests using AWS example payload shapes for:
   - permanent bounce,
   - transient bounce,
   - complaint,
   - `complaintFeedbackType: 'not-spam'`,
   - delivery delay,
   - reject,
   - unknown extra fields,
   - unknown authentic event type.

### Phase 4 — Migration

1. Add `0003_ses_feedback_ingestion.sql` with migration markers, tables, indexes, and down migration.
2. Add/extend migration tests:
   - parse migration file,
   - up/down smoke,
   - migrated DB has indexes and constraints,
   - driver parity includes new tables.
3. Run a Bun migration smoke with a temp DB and clean it up.

### Phase 5 — Processing logic

1. Implement `handleSesFeedbackSnsRequest` and helpers.
2. Implement idempotent transaction:
   - duplicate SNS notification no-ops safely via idempotent writes,
   - no reliance on affected-row counts.
3. Implement delivery resolution by tag then SES message-id fallback.
4. Add tests:
   - disabled config returns route-level 404 behavior,
   - invalid signature/topic rejected,
   - subscription confirmation calls confirmer,
   - duplicate SNS notification creates no duplicate notification/recipient/suppression rows,
   - permanent bounce inserts `scope=all` bounce suppression,
   - transient bounce records only,
   - complaint inserts `scope=all` complaint suppression,
   - `not-spam` complaint records only,
   - reject/delivery-delay record only,
   - event with no matching delivery still records and suppresses known recipient when appropriate,
   - multi-recipient bounce/complaint creates one row per recipient,
   - hard bounce followed later by complaint for the same email records both feedback rows but keeps the original global suppression row because suppression insert is conflict-no-op,
   - authentic unknown event type is recorded/ignored with 204 semantics.

### Phase 6 — HTTP route integration

1. Add `apps/service/src/ses-feedback/routes.ts`.
2. Mount public route in `apps/service/src/app.ts` before `notFound`.
3. Extend `AppServices` / runtime layers in:
   - `http/respond.ts`
   - `main.ts`
   - `testing/layers.ts`
4. Add route tests:
   - content-type `text/plain` accepted,
   - body near 256 KB accepted if under 512 KB,
   - oversized body rejected,
   - success returns `204`,
   - malformed payload returns `400`,
   - invalid verifier/topic returns `403`,
   - transient DB failure returns `500` so SNS retries.

### Phase 7 — Operations visibility

1. Add sanitized feedback list read model in `apps/service/src/operations/read-model.ts`.
2. Add route in `apps/service/src/operations/routes.ts`.
3. Add query parsing only if needed; keep initial endpoint simple with a bounded default limit.
4. Add `operations/routes.test.ts` coverage:
   - auth required,
   - sorted recent feedback rows,
   - raw JSON omitted,
   - diagnostics truncated.
5. Optional: add summary recent issue union row and tests.

### Phase 8 — Docs and cleanup

1. Update `README.md`:
   - env vars,
   - webhook URL,
   - AWS config-set/SNS/DLQ setup,
   - SES simulator validation,
   - account-level suppression recommendation,
   - transactional config-set caveat.
2. Update `PROJECT.md`:
   - move bounce/complaint ingestion from future blocker to current implementation once complete,
   - keep delivery state model accurate,
   - keep real marketing volume caveats updated to DKIM/Gmail verification + simulator/operations monitoring.
3. Remove or rewrite stale lines saying “add SES bounce/complaint ingestion before marketing”; replace with “verify ingestion in production with simulator before volume”.
4. Update `.plans/migrate-to-effect-v4-bun.md` conformance allowlists only if implementation needs a new raw `JSON.parse` site for SNS signature verification; if `sns-validator` raw-string validation works, no new project parse site should be added.
5. Re-run formatting.

## Testing and verification plan

Automated tests:

```sh
pnpm test -- apps/service/src/config.test.ts
pnpm test -- apps/service/src/ses-feedback
pnpm test -- apps/service/src/app.test.ts apps/service/src/operations
pnpm test -- apps/service/src/db apps/service/src/testing
pnpm --filter @nusend/service typecheck
pnpm check
```

Migration smoke:

```sh
NUSEND_DB_PATH=.data/tmp-ses-feedback-plan.sqlite pnpm --filter @nusend/service db:migrate
NUSEND_DB_PATH=.data/tmp-ses-feedback-plan.sqlite pnpm --filter @nusend/service db:status
rm -f .data/tmp-ses-feedback-plan.sqlite .data/tmp-ses-feedback-plan.sqlite-*
```

Manual/live validation after implementation and deployment:

1. Configure SES config sets and SNS topic/subscription/DLQ.
2. Confirm SNS subscription; verify Nusend logs no signature/topic failures.
3. Send a transactional test to `bounce@simulator.amazonses.com` through Nusend using the transactional configuration set.
4. Verify:
   - send worker records SES message id,
   - SNS webhook stores a bounce event,
   - local `suppressions` has `scope='all' reason='bounce'`,
   - `/api/operations/ses-feedback` shows the event,
   - SNS DLQ remains empty.
5. Repeat with `complaint@simulator.amazonses.com`.
6. Send a normal success test and verify no unintended suppression.
7. Before real marketing volume, still verify Gmail “Show original” DKIM coverage for `List-Unsubscribe` / `List-Unsubscribe-Post`.

## Risks and mitigations

- **Invalid/spoofed webhook calls**: verify SNS signatures and exact `TopicArn`; return `403` for failures.
- **Schema stripping breaks signature verification**: verify against raw parsed object before schema decoding; include `Token` support.
- **SSRF via SubscribeURL**: only confirm after signature + topic allowlist; validate HTTPS and SNS hostname before `fetch`.
- **SNS retries causing duplicates**: use `sns_message_id` and idempotent writes.
- **Partial processing**: insert notification, recipient rows, and suppressions in one DB transaction.
- **Network while holding SQLite lock**: perform signature verification/cert fetch and subscription confirmation outside transactions.
- **Complaint ambiguity**: preserve one SES send per recipient; do not batch recipients.
- **Incorrect suppression on not-spam feedback**: record `complaintFeedbackType='not-spam'` but do not suppress.
- **Over-suppressing transient bounces**: only auto-suppress permanent bounces and complaints initially.
- **Raw event PII leakage**: store raw JSON for audit, but never return it from operations endpoints.
- **Dependency age (`sns-validator`)**: isolate behind service; source confirms SigV2 support; document replaceability.
- **Silent transactional feedback gap**: document that transactional events require `NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET`.
- **SNS delivery loss**: require subscription DLQ and CloudWatch alarm in docs; explicitly document config-regression redrive behavior.

## Definition of done

- SES feedback webhook exists and is disabled unless configured with allowed SNS topic ARN(s).
- SNS messages are signature-verified and topic-allowlisted before processing.
- Subscription confirmation is supported safely.
- Permanent bounces and complaints insert local global suppressions idempotently.
- `not-spam` complaints and transient bounces record without suppressing.
- Reject and delivery-delay events are persisted without suppression.
- Duplicate SNS retries are idempotent.
- Operations API exposes sanitized recent feedback visibility.
- README/PROJECT accurately describe implementation and AWS setup.
- Automated tests and `pnpm check` pass.
- Temp migration smoke succeeds and temp DB files are cleaned up.

## Open questions

No blocking questions.

Main vetoable assumption: keep `NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET` optional in code for compatibility, while documenting it as required for transactional feedback coverage in production.

## Implementation Progress

Started: 2026-07-08
Tracker maintained by: pi

### Loop breakdown / validation contract

- [x] Phase 1 — Dependencies and config
  - Analysis: add sns-validator deps; parse optional `NUSEND_SES_FEEDBACK_TOPIC_ARNS`; add config service and test-layer default.
  - Verification planned: targeted config tests, dependency smoke.
  - Browser/manual verification: skipped; backend/config only.
- [x] Phase 2 — SNS verifier/confirmer services
  - Analysis: isolate old callback package behind Effect service; validate SubscribeURL before fetch.
  - Verification planned: targeted unit tests and Bun smoke for `sns-validator` import/signature-version support.
  - Browser/manual verification: skipped; backend webhook internals only.
- [x] Phase 3 — Schema and parser modules
  - Analysis: schema-decode verified SNS envelope and nested SES events with unknown-field tolerance.
  - Verification planned: schema/parser unit tests with representative payloads.
  - Browser/manual verification: skipped; backend parsing only.
- [x] Phase 4 — Migration
  - Analysis: add audit/recipient tables and indexes; update migration tests/smoke.
  - Verification planned: migration tests and temp DB migrate/status smoke.
  - Browser/manual verification: skipped; DB-only.
- [x] Phase 5 — Processing logic
  - Analysis: idempotent notification/recipient/suppression transaction; resolve delivery by tag then SES message id.
  - Verification planned: domain tests covering disabled/signature/topic/idempotency/suppression/event cases.
  - Browser/manual verification: skipped; backend processing only.
- [x] Phase 6 — HTTP route integration
  - Analysis: public SNS webhook with raw text body, 512kb limit, bare status mapping.
  - Verification planned: route/app tests for status mapping/body handling.
  - Browser/manual verification: skipped; HTTP API tested in-process, no visual UI.
- [x] Phase 7 — Operations visibility
  - Analysis: sanitized operations endpoint for recent feedback rows.
  - Verification planned: operations route/read-model tests.
  - Browser/manual verification: skipped; JSON API only.
- [x] Phase 8 — Docs and cleanup
  - Analysis: README/PROJECT updates; conformance allowlist only if raw JSON.parse site added.
  - Verification planned: formatting/lint/typecheck/tests; final migration smoke; independent reviews.
  - Browser/manual verification: skipped; docs/backend only.

### Progress log

- 2026-07-08: Read full plan and required implement-plan/loop/effect/subagents/code-research/web-research skills before edits. No human checkpoint needed; plan has no blocking open questions and no production-impacting actions are being run. Chose sequential single-writer implementation because phases share files and DB/runtime integration; subagents will be used for independent review passes.

- 2026-07-08: Completed Phases 1-7 sequentially as one backend feature loop. Files changed include config/runtime wiring, `ses-feedback` services/schemas/process/routes/tests, migration `0003`, operations read model/routes, test layers, and dependency manifests. Confirmed `sns-validator` Bun import smoke from `apps/service` and inspected installed `sns-validator@0.3.5` source: supports SignatureVersion 1/2 (`RSA-SHA1`/`RSA-SHA256`) and caches signing certificates in-memory by cert URL. Raw SNS verification uses the package's raw-string path; no new direct application `JSON.parse` site was added, so `.plans/migrate-to-effect-v4-bun.md` allowlist did not need updating. Browser verification skipped: backend/webhook/JSON API only, covered by in-process HTTP tests.
- 2026-07-08: Verification passed: `pnpm --filter @nusend/service typecheck`; targeted Vitest for config, ses-feedback, app, operations, db, and testing (`38 files / 245 tests`); Bun temp migration smoke with migrate/status and cleanup. Formatting applied only to touched TS/JSON files with targeted `oxfmt`, not repository-wide.
- 2026-07-08: Independent review pass completed (3 fresh reviewer subagents). No blockers. Incorporated useful findings: added direct parser/schema tests for SNS/SES payload variants including unknown fields and Delivery; added route tests for verifier failure -> 403 and DB/internal failure -> 500; added processing tests for SES message-id fallback, UnsubscribeConfirmation audit, Delivery event, and bounce-then-complaint suppression preservation; added migration index/check-constraint assertions; tightened SubscribeURL validation to match SNS topic region/partition; added a 10s timeout to live subscription confirmation fetch. SignatureVersion 2 full live success test remains source-inspection/smoke-test based because generating a valid SNS cert/signature path would require test certificate plumbing or live AWS; wrapper remains isolated for replacement.
- 2026-07-08: Post-review validation passed: targeted `pnpm test -- apps/service/src/ses-feedback apps/service/src/db/migrate.integration.test.ts apps/service/src/app.test.ts` (39 files / 252 tests), full `pnpm check` (format, lint with pre-existing main.integration no-await-in-loop warnings only, typecheck, all tests), and temp DB migrate/status smoke with cleanup. Browser/manual verification skipped: backend/API/webhook only; HTTP route behavior verified in-process.

- 2026-07-08: Final review pass completed (2 fresh reviewer subagents) with no blockers. Reviewers confirmed prior findings were resolved and remaining live AWS signature/simulator validation is deployment-time/manual. Human checkpoints skipped because plan had no blocking questions, no production credentials/actions were required, and all work was local/backend-only.

### Final status

- [x] Phase 1 — Dependencies and config
- [x] Phase 2 — SNS verifier/confirmer services
- [x] Phase 3 — Schema and parser modules
- [x] Phase 4 — Migration
- [x] Phase 5 — Processing logic
- [x] Phase 6 — HTTP route integration
- [x] Phase 7 — Operations visibility
- [x] Phase 8 — Docs and cleanup
- [x] Independent review pass after implementation completed; feedback incorporated.
- [x] Final independent review completed with no blockers.
- [x] Automated validation completed (`pnpm check`, targeted tests, migration smoke).
- [x] Browser/manual UI verification skipped with reason: backend/API/webhook/docs only; no browser-visible UI change.
