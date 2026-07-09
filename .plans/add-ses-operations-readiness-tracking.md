# Plan: SES Operations Readiness, Simulator Testing, Observability, and Tracking

## Summary

Build Nusend's AWS SES operations foundation as a first-class product area. The result should let a self-hosted operator validate AWS/SES/SNS setup from the app, follow step-by-step setup guidance, run SES mailbox simulator scenarios, observe send/feedback/worker health, and ingest SES engagement tracking events (`Open`, `Click`) into SQLite.

## Implementation Progress

Canonical tracker for this implementation. Update this section before and after each major loop.

### Overall status

- Status: complete after follow-up `.plans/fix-ses-operations-review-findings.md`
- Started: 2026-07-09
- Implementer notes: Used additive `0004` migration. Browser verification skipped because the work is authenticated JSON API / CLI / backend-only docs with no browser-visible UI.

### Loop tracker

| Loop | Scope | Status | Verification | Review |
|---|---|---|---|---|
| 0 | Analyze full plan, inspect repo, decompose work | done | Plan read fully; advisory subagents completed | N/A |
| 1 | SES operations migration/schema | done | `pnpm test apps/service/src/db` via targeted suite passed | Final review passed |
| 2 | Rename/refactor `ses-feedback` to `ses` and event ingestion | done | `pnpm test apps/service/src/ses` passed | Final review passed |
| 3 | Config/runtime/AWS admin services | done | `pnpm test apps/service/src/config.test.ts apps/service/src/aws` passed | Final review passed |
| 4 | SES operations routes/readiness/setup/read models | done | `pnpm test apps/service/src/operations apps/service/src/aws apps/service/src/ses` passed | Final review passed |
| 5 | Simulator CLI and worker-run observability/logging | done | `pnpm test apps/service/src/ses apps/service/src/sending` passed | Final review passed |
| 6 | Docs, cleanup, grep, full validation | done | cleanup grep passed for active app/docs; `pnpm check` passed | Final review passed |

### Review and validation notes

- Subagents: `context-builder` advisory fanout completed for phases 1-4 and 5-8; outputs under `.pi-subagents/artifacts/outputs/a3e8881b-12c7-46e5-999e-1878ee02eb86/`.
- Implemented: additive `0004_ses_operations_and_tracking.sql`; new `apps/service/src/ses/` subsystem; old `apps/service/src/ses-feedback/` removed; new AWS admin/readiness services; authenticated `/api/operations/ses/*`; Open/Click ingestion; simulator CLI; `worker_runs`; JSON logger layer; docs under `docs/`.
- Deviations: remote-target simulator mode was not implemented; `--target-url` now fails fast with a clear message. Readiness `?refresh=1` is accepted at route level but no in-memory AWS cache was added; current checks run live per request. Request-completion middleware and structured Effect JSON log points are now implemented with unsubscribe token path redaction.
- Validation: post-follow-up `pnpm test --testTimeout=20000` passed (47 files / 277 tests); `git diff --check` passed; `pnpm check` passed with oxlint warnings only.
- Cleanup grep: active app/docs grep for `ses-feedback|SesFeedback|operations/ses-feedback` is clean; `ses_feedback` remains only in historical migrations/down migration and migration tests as expected.
- Final review: reviewer run `4a6866f7` found no blockers, then noted readiness/observability/test coverage gaps. Addressed worker `finished_at`, public-base-url validation, unsubscribe/tracking/latest-feedback checks. Follow-up reviewer run `5945444d` found no blockers or major issues.
- Post-review follow-up: `.reviews/ses-operations-review.md` found critical and coverage gaps. `.plans/fix-ses-operations-review-findings.md` implemented the cleanup: summary/simulator fixes, config diagnostics, AWS timeout/pagination/readiness checks, webhook route/audit coverage, worker-run retention, request logging, setup-guide/docs expansion, and tracker reconciliation.
- Accepted residual deviation after follow-up: `refresh=1` is a no-op because no cache exists and live checks avoid DB freshness ambiguity.
- Human checkpoints: none required; no production AWS calls or destructive actions were performed.
- Browser/manual verification: skipped because no browser-visible UI changed; route behavior is covered by in-process HTTP tests and CLI/backend tests.


This plan intentionally treats the codebase as early-development and cleanable. We should refactor stale SES feedback naming, remove old narrow endpoints, delete stale code/tests/docs, and design the new SES operations layer as if it existed from the start. At the same time, avoid self-inflicted operational traps: setup/readiness endpoints must work before SES is configured, and migration changes must respect the current checksum-validated migration runner unless we explicitly wipe/reset local DBs.

## Confirmed requirements

- Add scripts for sending to AWS SES mailbox simulator scenarios.
- Add easy in-app AWS/SES/SNS readiness validation.
- Add in-app step-by-step setup guidance.
- Add Markdown docs for SES setup, simulator testing, observability, and tracking.
- Add proper structured logging / observability.
- Ingest SES-provided open/click tracking events into the database.
- Prefer a clean ground-up design over minimal patches.
- Include cleanup/deletion work explicitly.

## Explicit assumptions

- There is no admin UI yet. “In the app” means authenticated API endpoints returning structured JSON for now; a future UI can consume those endpoints.
- Readiness/setup endpoints must work even when SES config, AWS credentials, config sets, SNS topics, or public webhook setup are missing.
- Missing SES/AWS setup is a readiness result, not an API boot failure.
- API endpoints remain protected by owner session or API key with `operations:read`.
- SES open/click support means ingestion, persistence, and operations visibility; not a full analytics dashboard yet.
- R2/assets are out of scope for this plan.

## Research findings

Official AWS docs consulted:

- SES mailbox simulator: <https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html>
- SES production access / sandbox: <https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html>
- SES event publishing setup: <https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-using-event-publishing-setup.html>
- SES event destination event types: <https://docs.aws.amazon.com/ses/latest/dg/event-destinations-manage.html>
- SES SNS event payload examples, including `Open` and `Click`: <https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html>
- SES configuration sets: <https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets.html>
- SES open/click tracking domains: <https://docs.aws.amazon.com/ses/latest/dg/configure-custom-open-click-domains.html>
- SESv2 `GetAccount`: <https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html>
- SESv2 `GetEmailIdentity`: <https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html>
- SESv2 `GetConfigurationSet`: <https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetConfigurationSet.html>
- SESv2 `GetConfigurationSetEventDestinations`: <https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetConfigurationSetEventDestinations.html>
- SESv2 `EventDestinationDefinition`: <https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_EventDestinationDefinition.html>
- SNS `GetTopicAttributes`: <https://docs.aws.amazon.com/sns/latest/api/API_GetTopicAttributes.html>
- SNS `ListSubscriptionsByTopic`: <https://docs.aws.amazon.com/sns/latest/api/API_ListSubscriptionsByTopic.html>

Key findings:

- SES sandbox is per-region. Sandbox can send only to verified recipients/domains or mailbox simulator addresses.
- SES production access removes recipient verification restrictions, but sender identities still need verification.
- SES mailbox simulator works in sandbox and production.
- Simulator sends do not affect reputation/bounce/complaint metrics and do not count against daily sending quota, but they are rate-limited and billable.
- SES event publishing requires a configuration set, event destination, and use of that config set during send.
- SESv2 event destination valid types include `SEND`, `REJECT`, `BOUNCE`, `COMPLAINT`, `DELIVERY`, `OPEN`, `CLICK`, `RENDERING_FAILURE`, `DELIVERY_DELAY`, and `SUBSCRIPTION`.
- SES open tracking inserts a 1x1 pixel; click tracking rewrites links. Optional `{{ses:openTracker}}` controls pixel placement. Optional custom redirect domains are configured on configuration sets.
- SESv2 readiness checks can use `GetAccount`, `GetEmailIdentity`, `GetConfigurationSet`, and `GetConfigurationSetEventDestinations`.
- SNS readiness checks can use `GetTopicAttributes` and `ListSubscriptionsByTopic` to verify topic existence and confirmed HTTPS subscription to the Nusend webhook.

Dependency evidence:

- `@aws-sdk/client-sesv2` is installed in `apps/service/package.json` at `3.1080.0`.
- Installed SESv2 types include `GetAccountCommand`, `GetEmailIdentityCommand`, `GetConfigurationSetCommand`, `GetConfigurationSetEventDestinationsCommand`, and `PutConfigurationSetTrackingOptionsCommand`.
- `@aws-sdk/client-sns` is not currently installed and should be added.
- Effect v4 exposes structured logging APIs (`Logger.consoleJson`, `Logger.layer`, `Effect.logInfo`, `Effect.annotateLogs`, `Effect.withLogSpan`) in the installed package; use those instead of a bespoke logger service.

## Current codebase findings

Relevant files:

- `apps/service/src/app.ts`
  - Mounts `/api/webhooks/aws/sns/ses`, `/api/operations`, mailings, contacts, lists, suppressions, unsubscribe.
- `apps/service/src/config.ts`
  - Splits `serviceConfig`, `sesFeedbackConfig`, `unsubscribeConfig`, `sendingConfig`.
  - API runtime does not load `sendingConfig`; worker does.
- `apps/service/src/services/email-transport-ses.ts`
  - Constructs `SESv2Client` for send transport only.
- `apps/service/src/ses-feedback/*`
  - Handles SNS signature verification, subscription confirmation, SES event decoding, bounce/complaint processing, and suppressions.
- `apps/service/src/ses-feedback/ses-event-schema.ts`
  - Decodes Bounce, Complaint, DeliveryDelay, Delivery, Reject, and unknown events, but not Open/Click as first-class events.
- `apps/service/src/db/migrations/sql/0003_ses_feedback_ingestion.sql`
  - Stores `ses_feedback_notifications` and `ses_feedback_recipients`.
- `apps/service/src/operations/routes.ts`
  - Exposes stale `GET /api/operations/ses-feedback`.
- `apps/service/src/operations/read-model.ts`
  - Lists `ses_feedback_recipients`; no raw notification freshness, readiness, simulator runs, or engagement tracking.
- `apps/service/src/http/respond.ts`
  - Central error mapping includes `SesFeedback*` errors.
- `apps/service/src/testing/layers.ts`
  - Provides fake SES feedback config/verifier/confirmer layers.
- `apps/service/src/sending/worker-main.ts`
  - Prints one JSON summary per worker cycle; no persisted worker-run observability.

## Chosen implementation strategy

### Build a cohesive `ses` subsystem

Replace the narrow `ses-feedback` concept with a coherent `ses` subsystem that owns:

- SNS webhook ingestion;
- SES event parsing and processing;
- deliverability feedback persistence;
- engagement event persistence;
- AWS SES/SNS readiness checks;
- setup guide generation;
- simulator orchestration;
- SES operations read models/routes;
- SES/SNS admin SDK wrappers.

This is a load-bearing refactor, not cosmetic: the current feature is no longer only “feedback”; it becomes SES operations.

### Preserve API bootability before SES is configured

The app must start and expose setup/readiness guidance with zero SES config. Therefore:

- app startup config should validate only what is required to boot the API/auth/DB;
- SES config parsing should produce structured “missing” values for readiness checks, not throw boot-fatal errors;
- live sending/worker startup can still fail fast when required send config is absent;
- readiness checks report missing AWS credentials/config/permissions as actionable check results.

### Use additive migration by default, not checksum-breaking reset

The current migration runner checksum-validates applied migrations. Rewriting/deleting applied migrations would break any existing DB. Therefore default implementation should add a new migration that cleanly drops stale SES feedback tables and creates the new SES operations tables.

A full reset-clean migration rewrite is allowed only if the implementer deliberately wipes all local/dev DBs and updates migration tests accordingly. That is optional, not the recommended default.

## Alternatives considered

### Minimally extend `ses-feedback/*`

Rejected. It preserves stale naming and makes readiness/tracking/simulator code feel bolted on.

### Make SES config mandatory for API startup

Rejected. It prevents operators from reaching the readiness/setup endpoints precisely when setup is incomplete.

### Reset all migrations as the default

Rejected as default because the migration runner checksum-validates applied migrations. Additive `0004` gives a clean runtime schema without breaking existing DBs. A full reset remains optional if the team explicitly chooses to wipe dev DBs.

### Use SES-managed subscription management

Rejected. Nusend owns contacts, lists, suppressions, and unsubscribe URLs. SES `ListManagementOptions` can override manual unsubscribe headers and would create a second source of truth.

### Build a full analytics dashboard now

Rejected. Ingest and expose open/click data first; UI/analytics can come later.

## Target routes

### Existing route to delete

Remove this stale route and all references:

```txt
GET /api/operations/ses-feedback
```

### New authenticated operations routes

```txt
GET /api/operations/ses/summary
GET /api/operations/ses/events
GET /api/operations/ses/events/:id
GET /api/operations/ses/readiness
GET /api/operations/ses/setup-guide
GET /api/operations/ses/simulator-runs
GET /api/operations/ses/simulator-runs/:id
```

All require owner session or API key with `operations:read`.

Behavior:

- `GET /api/operations/ses/summary`
  - event counts by type;
  - latest SNS notification time;
  - latest parsed event time;
  - bounce/complaint/open/click totals;
  - recent SES issues;
  - selected worker/dead-job/ambiguous-attempt health signals.

- `GET /api/operations/ses/events`
  - sanitized list of SES events.
  - filters: `eventType`, `mailingId`, `deliveryId`, `email`, `sesMessageId`, `limit`, `offset`.
  - no raw SNS JSON in response.

- `GET /api/operations/ses/events/:id`
  - sanitized event detail.
  - include linked mailing/delivery IDs, link URL for click events, event metadata, but not raw SNS JSON.

- `GET /api/operations/ses/readiness`
  - live local config + AWS/SNS checks.
  - query options:
    - `?refresh=1` to bypass short cache;
    - optional `?includeAws=false` for local-only checks if useful.

- `GET /api/operations/ses/setup-guide`
  - ordered setup instructions with current statuses from readiness checks.

- `GET /api/operations/ses/simulator-runs*`
  - persisted simulator validation runs.

Public webhook remains:

```txt
POST /api/webhooks/aws/sns/ses
```

Define the webhook path as a single exported constant, e.g.:

```ts
export const sesSnsWebhookPath = "/api/webhooks/aws/sns/ses";
```

Use that constant in routing, readiness expected-endpoint checks, setup-guide JSON, simulator docs, and Markdown docs.

## Target database changes

Add a new migration, recommended name:

```txt
apps/service/src/db/migrations/sql/0004_ses_operations_and_tracking.sql
```

### Migration behavior

- Create new tables listed below.
- Drop old `ses_feedback_recipients` and `ses_feedback_notifications` only if this project accepts losing old dev feedback rows.
- Since the project is early-development and the user wants no legacy code, recommended action is to drop old tables in this migration rather than dual-write or migrate stale data.
- Update tests to expect old tables gone and new tables present.

### `ses_notifications`

```sql
CREATE TABLE ses_notifications (
  id TEXT PRIMARY KEY,
  sns_message_id TEXT NOT NULL UNIQUE,
  sns_topic_arn TEXT NOT NULL,
  sns_type TEXT NOT NULL CHECK (sns_type IN ('Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation')),
  ses_message_id TEXT,
  event_type TEXT,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
```

### `ses_events`

Use a simple `dedupe_key`, not expression-based table constraints.

```sql
CREATE TABLE ses_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  notification_id TEXT NOT NULL REFERENCES ses_notifications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'Send',
    'Rendering Failure',
    'Reject',
    'Delivery',
    'DeliveryDelay',
    'Bounce',
    'Complaint',
    'Subscription',
    'Open',
    'Click',
    'Unknown'
  )),
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  ses_message_id TEXT,
  recipient_email TEXT COLLATE NOCASE,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('recorded', 'suppressed', 'ignored')),
  occurred_at TEXT,

  bounce_type TEXT,
  bounce_sub_type TEXT,
  complaint_feedback_type TEXT,
  feedback_id TEXT,
  diagnostic_code TEXT,
  reject_reason TEXT,
  delivery_delay_type TEXT,

  link_url TEXT,
  link_tags_json TEXT,
  ip_address TEXT,
  user_agent TEXT,

  created_at TEXT NOT NULL
);
```

Dedupe rule:

- `ses_notifications.sns_message_id` is the primary SNS redelivery idempotency gate.
- Insert events only when the notification insert is new.
- `dedupe_key` is still useful as a final invariant for generated per-event rows, e.g. `${snsMessageId}:${eventType}:${recipientEmail ?? ''}:${linkUrl ?? ''}:${index}`.
- Preserve multiple legitimate opens/clicks because each has a distinct SNS message ID.

### `ses_simulator_runs`

```sql
CREATE TABLE ses_simulator_runs (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL CHECK (scenario IN ('success', 'bounce', 'complaint', 'ooto', 'suppressionlist')),
  mode TEXT NOT NULL CHECK (mode IN ('send_acceptance', 'end_to_end')),
  purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  target_base_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'sent', 'validated', 'failed', 'timed_out')),
  expected_event_type TEXT,
  expected_suppression_reason TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
```

### `worker_runs`

```sql
CREATE TABLE worker_runs (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('once', 'loop')),
  released INTEGER NOT NULL,
  claimed INTEGER NOT NULL,
  succeeded INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  dead INTEGER NOT NULL,
  skipped_stale INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
```

### Indexes

Add indexes:

```sql
CREATE INDEX ses_notifications_received_at_idx ON ses_notifications(received_at);
CREATE INDEX ses_events_event_created_idx ON ses_events(event_type, created_at);
CREATE INDEX ses_events_delivery_id_idx ON ses_events(delivery_id);
CREATE INDEX ses_events_mailing_id_idx ON ses_events(mailing_id);
CREATE INDEX ses_events_ses_message_id_idx ON ses_events(ses_message_id);
CREATE INDEX ses_events_recipient_email_idx ON ses_events(recipient_email);
CREATE INDEX ses_events_link_url_idx ON ses_events(link_url);
CREATE INDEX ses_simulator_runs_started_at_idx ON ses_simulator_runs(started_at);
CREATE INDEX ses_simulator_runs_status_idx ON ses_simulator_runs(status);
CREATE INDEX worker_runs_finished_at_idx ON worker_runs(finished_at);
```

## New/refactored module layout

Create/target:

```txt
apps/service/src/aws/
  ses-admin.ts
  sns-admin.ts
  readiness.ts
  readiness.test.ts

apps/service/src/ses/
  constants.ts
  config.ts
  event-schema.ts
  event-schema.test.ts
  process-event.ts
  process-event.test.ts
  sns-schema.ts
  sns-verifier.ts
  sns-verifier.test.ts
  sns-confirmer.ts
  sns-confirmer.test.ts
  webhook-routes.ts
  webhook-routes.test.ts
  read-model.ts
  read-model.test.ts
  routes.ts
  routes.test.ts
  setup-guide.ts
  setup-guide.test.ts
  simulator.ts
  simulator.test.ts
  simulator-main.ts
```

Delete/replace after equivalent new modules pass tests:

```txt
apps/service/src/ses-feedback/config.ts
apps/service/src/ses-feedback/errors.ts
apps/service/src/ses-feedback/process.ts
apps/service/src/ses-feedback/routes.ts
apps/service/src/ses-feedback/ses-event-schema.ts
apps/service/src/ses-feedback/sns-confirmer.ts
apps/service/src/ses-feedback/sns-schema.ts
apps/service/src/ses-feedback/sns-verifier.ts
apps/service/src/ses-feedback/*.test.ts
```

Update imports in:

- `apps/service/src/app.ts`
- `apps/service/src/main.ts`
- `apps/service/src/http/respond.ts`
- `apps/service/src/testing/layers.ts`
- `apps/service/src/operations/*`
- `apps/service/src/config.ts`
- tests under app/operations/db/config.

## Configuration design

Refactor config so API can report readiness without requiring complete SES setup.

Suggested types:

```ts
type AppConfig = {
  auth: Option.Option<AuthConfig>;
  databasePath: string;
  host: string;
  port: number;
  publicBaseUrl: Option.Option<string>;
};

type EmailRuntimeConfig = {
  awsRegion: Option.Option<string>;
  fromEmail: Option.Option<string>;
  transactionalConfigurationSet: Option.Option<string>;
  marketingConfigurationSet: Option.Option<string>;
  feedbackTopicArns: readonly string[];
  requestTimeoutMs: number;
  workerBatchSize: number;
  workerLeaseSeconds: number;
  workerPollMs: number;
  trackingEvents: readonly ('open' | 'click')[];
  trackingCustomRedirectDomain: Option.Option<string>;
};

type UnsubscribeRuntimeConfig = {
  currentSecret: Option.Option<Redacted.Redacted<string>>;
  previousSecret: Option.Option<Redacted.Redacted<string>>;
};
```

Important behavior:

- API startup may load incomplete `EmailRuntimeConfig` and `UnsubscribeRuntimeConfig` as structured `Option`s.
- Worker startup and actual live sending still fail fast when required send config is missing.
- Marketing send policy still requires public base URL, unsubscribe secret, marketing configuration set, and unsubscribe placeholder.
- Readiness checks explain missing config.
- No legacy env aliases.

Env vars to keep/add:

```txt
AWS_REGION=us-east-1
NUSEND_PUBLIC_BASE_URL=https://mail.example.com
NUSEND_SES_FROM_EMAIL=sender@example.com
NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET=nusend-transactional-prod
NUSEND_SES_MARKETING_CONFIGURATION_SET=nusend-marketing-prod
NUSEND_SES_FEEDBACK_TOPIC_ARNS=arn:aws:sns:...
NUSEND_SES_TRACKING_EVENTS=open,click
NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN=tracking.example.com
NUSEND_UNSUBSCRIBE_SECRET=...
NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET=...
```

`AWS_REGION` should remain the standard AWS SDK env var.

## AWS admin services

Add `@aws-sdk/client-sns` pinned compatibly with the current AWS SDK family.

Create small service interfaces:

```ts
interface SesAdminService {
  getAccount(): Effect.Effect<SesAccountSummary, AwsAdminError>;
  getEmailIdentity(identity: string): Effect.Effect<SesIdentitySummary, AwsAdminError>;
  getConfigurationSet(name: string): Effect.Effect<SesConfigurationSetSummary, AwsAdminError>;
  getConfigurationSetEventDestinations(name: string): Effect.Effect<readonly SesEventDestinationSummary[], AwsAdminError>;
}

interface SnsAdminService {
  getTopicAttributes(topicArn: string): Effect.Effect<SnsTopicSummary, AwsAdminError>;
  listSubscriptionsByTopic(topicArn: string): Effect.Effect<readonly SnsSubscriptionSummary[], AwsAdminError>;
}
```

Live implementations wrap:

- `SESv2Client`
- `SNSClient`
- AWS SDK standard credential chain
- timeout options
- sanitized error mapping

Test implementations are fake layers.

Error mapping should classify:

- missing credentials;
- access denied / missing IAM permission;
- not found;
- throttled;
- unknown AWS error.

Readiness converts these to check statuses, not fatal route defects.

## Readiness checks

Implement `runSesReadinessChecks(options)` returning stable ordered check results.

Result shape:

```ts
type ReadinessStatus = 'ok' | 'warning' | 'error' | 'skipped';

type ReadinessCheck = {
  id: string;
  status: ReadinessStatus;
  title: string;
  message: string;
  action: string | null;
  docs?: readonly string[];
  details?: Record<string, unknown>;
};
```

Overall status:

- `error` if any check is `error`.
- `warning` if no errors but any warnings/skips.
- `ok` only if all required checks pass.

Recommended checks:

1. `config.public_base_url`
   - HTTPS URL, no query/fragment, present for marketing/unsubscribe/webhook setup.
2. `config.unsubscribe_secret`
   - present and valid for marketing sends.
3. `config.aws_region`
   - `AWS_REGION` present.
4. `config.from_email`
   - `NUSEND_SES_FROM_EMAIL` present and parseable.
5. `config.configuration_sets`
   - transactional and marketing config set names present.
6. `config.feedback_topics`
   - at least one valid SNS topic ARN configured.
7. `config.worker_budget`
   - batch size/request timeout/lease invariant passes.
8. `aws.credentials_and_account`
   - `GetAccount` succeeds, or returns missing IAM/credentials guidance.
9. `ses.account.production_access`
   - production access true = ok; false = warning with sandbox guidance.
10. `ses.account.sending_enabled`
   - true = ok; false = error.
11. `ses.account.enforcement_status`
   - `HEALTHY` = ok; `PROBATION` = warning; `SHUTDOWN` = error.
12. `ses.account.suppression_recommendation`
   - account-level suppression includes bounce/complaint = ok/recommendation; absence is warning at most because Nusend owns local suppressions.
13. `ses.identity.from_email`
   - check exact From email identity first, then domain identity fallback.
   - `VerifiedForSendingStatus` true required.
14. `ses.identity.dkim`
   - DKIM signing/status useful warning/recommendation, not always fatal.
15. `ses.config_set.transactional.exists`
   - config set exists and sending enabled.
16. `ses.config_set.marketing.exists`
   - config set exists and sending enabled.
17. `ses.config_set.transactional.events`
   - enabled event destination to configured SNS topic includes required events.
18. `ses.config_set.marketing.events`
   - enabled event destination includes required events and `OPEN`/`CLICK` when configured.
19. `ses.config_set.tracking_domain`
   - if custom redirect domain configured, SES config set tracking options match and HTTPS policy is acceptable.
20. `sns.topic.exists`
   - `GetTopicAttributes` succeeds for each topic ARN.
21. `sns.topic.signature_version`
   - report signature version; recommend v2 if desired, but current verifier supports SNS validation through library.
22. `sns.subscription.webhook`
   - `ListSubscriptionsByTopic` has confirmed HTTPS subscription endpoint exactly equal to `${publicBaseUrl}${sesSnsWebhookPath}`.
23. `db.ses_operations_schema`
   - new SES operations tables exist.
24. `operations.latest_feedback`
   - warning if no SES notification has ever been received after setup is otherwise complete.

IAM guidance:

- Readiness should include minimal IAM permissions in docs and check actions:
  - `ses:GetAccount`
  - `ses:GetEmailIdentity`
  - `ses:GetConfigurationSet`
  - `ses:GetConfigurationSetEventDestinations`
  - `sns:GetTopicAttributes`
  - `sns:ListSubscriptionsByTopic`
- If missing permissions, checks should report `skipped` or `warning` with exact action to grant, not generic internal error.

Caching:

- Add short in-memory TTL caching for AWS-backed readiness, e.g. 60 seconds.
- `?refresh=1` bypasses cache.
- Local config/DB checks can run every request.

## Setup guide endpoint

Implement `buildSesSetupGuide(readiness)` returning JSON:

```json
{
  "title": "Set up AWS SES for Nusend",
  "status": "warning",
  "steps": [
    {
      "id": "verify-sender-identity",
      "status": "warning",
      "title": "Verify your SES sending identity",
      "why": "SES only sends from verified identities.",
      "actions": [
        { "kind": "console", "text": "Open SES > Identities > Create identity." },
        { "kind": "cli", "command": "aws sesv2 get-email-identity --email-identity example.com" }
      ],
      "relatedChecks": ["ses.identity.from_email"]
    }
  ]
}
```

Guide steps:

1. Choose SES region.
2. Verify sending identity/domain.
3. Enable/verify DKIM.
4. Request production access or understand sandbox/simulator limits.
5. Create transactional and marketing configuration sets.
6. Create SNS Standard topic.
7. Allow SES to publish to SNS topic.
8. Add event destinations for required events.
9. Subscribe Nusend webhook endpoint.
10. Configure env vars.
11. Run readiness endpoint.
12. Run simulator scripts.
13. Configure SNS DLQ/alarms.
14. Verify Gmail/List-Unsubscribe manually.
15. Enable/verify open/click tracking if desired.

The setup guide must not mutate AWS.

## SES event ingestion and tracking

### Event schema

Extend SES event decoding for:

- `Send`
- `Rendering Failure`
- `Reject`
- `Delivery`
- `DeliveryDelay`
- `Bounce`
- `Complaint`
- `Subscription`
- `Open`
- `Click`
- unknown authentic events as `Unknown`

Open fields:

```ts
open: {
  ipAddress?: string;
  timestamp?: string;
  userAgent?: string;
}
```

Click fields:

```ts
click: {
  ipAddress?: string;
  link?: string;
  linkTags?: Record<string, string[]>;
  timestamp?: string;
  userAgent?: string;
}
```

### Processing rules

- Verify SNS signature before processing.
- Validate TopicArn allowlist.
- Insert raw `ses_notifications` first.
- If notification already exists, skip event side effects idempotently.
- Resolve delivery by SES tag `delivery_id`, then by SES message ID fallback.
- Store one or more `ses_events` rows per notification as appropriate.
- Permanent Bounce creates `scope=all reason=bounce` suppression.
- Complaint creates `scope=all reason=complaint`, except `complaintFeedbackType='not-spam'`.
- Open/Click never mutate delivery status and never suppress.
- Delivery/Bounce/Complaint do not mutate `deliveries.status`; delivery status remains send-processing-only.
- Raw SNS JSON stays in DB for audit/debug but is never returned by operations routes and never logged.

### Tracking caveats to document

- Open tracking is imprecise due to image blocking/proxying/prefetching.
- Click tracking rewrites URLs through SES tracking infrastructure.
- Tracking should be explicitly configured and documented for operators.
- Optional `{{ses:openTracker}}` placement is not auto-injected in this milestone.

## Simulator scripts

Add scripts:

```json
"ses:simulate": "bun src/ses/simulator-main.ts",
"ses:simulate:all": "bun src/ses/simulator-main.ts all"
```

CLI examples:

```sh
pnpm --filter @nusend/service ses:simulate success --purpose transactional --mode send-acceptance
pnpm --filter @nusend/service ses:simulate bounce --purpose transactional --mode end-to-end --target-url https://mail.example.com --api-key nusend_...
pnpm --filter @nusend/service ses:simulate complaint --purpose marketing --mode end-to-end --target-url https://mail.example.com --api-key nusend_...
pnpm --filter @nusend/service ses:simulate all --mode end-to-end --target-url https://mail.example.com --api-key nusend_...
```

Scenarios:

| Scenario | Address | Expected |
|---|---|---|
| `success` | `success@simulator.amazonses.com` | SES accepts send; optional Delivery event if enabled |
| `bounce` | `bounce@simulator.amazonses.com` | Bounce event stored; `scope=all reason=bounce` suppression |
| `complaint` | `complaint@simulator.amazonses.com` | Complaint event stored; `scope=all reason=complaint` suppression |
| `ooto` | `ooto@simulator.amazonses.com` | send succeeds; no local suppression expected |
| `suppressionlist` | `suppressionlist@simulator.amazonses.com` | depends on SES account-level suppression settings; document exact observed validation expectation |

### Simulator modes

#### `send-acceptance`

- Runs locally or on server.
- Creates a mailing in the local DB.
- Runs worker until SES accepts/rejects the send.
- Validates delivery attempt/message ID/failure path.
- Does not claim to validate SNS feedback ingestion.

#### `end-to-end`

Two supported approaches:

1. **Server-local mode**
   - Run CLI on the deployed server using the deployed DB and public webhook config.
   - CLI creates mailing locally, runs worker, polls local DB for SNS-ingested events.

2. **Remote target mode**
   - CLI calls target deployment's public API/operations endpoints with an API key.
   - Target deployment creates/sends/polls using its own DB.
   - This avoids the local DB vs deployed webhook DB mismatch.

Recommended implementation for first version:

- Implement server-local mode first because it can reuse internal Effect workflows.
- Add remote target mode if it is straightforward after route/readiness endpoints exist.
- The CLI must clearly state when a scenario cannot validate feedback because it is not running against the deployment receiving SNS.

Persist every run in `ses_simulator_runs` when using local/server mode.

## Observability and logging

Use Effect logging primitives instead of a bespoke logger service.

### Runtime logging layer

Add a module such as:

```txt
apps/service/src/observability/effect-logger.ts
```

Responsibilities:

- configure `Logger.consoleJson` or a small custom `Logger.make` JSON logger if `consoleJson` shape is insufficient;
- route JSON logs to stdout/stderr appropriately;
- provide helpers for safe annotations if useful.

Use:

- `Effect.logInfo`, `Effect.logWarning`, `Effect.logError`, `Effect.logDebug`;
- `Effect.annotateLogs` / `Effect.annotateLogsScoped`;
- `Effect.withLogSpan`.

### Sanitization rules

Never log:

- API keys;
- auth/session tokens;
- secrets/redacted values;
- raw SNS JSON;
- email HTML/text;
- recipient vars JSON;
- raw AWS SDK payloads.

Prefer:

- delivery IDs;
- mailing IDs;
- job IDs;
- event IDs;
- SNS message IDs;
- masked or hashed email only when needed.

### Log points

Add structured logs for:

- request start/end with request ID, method, path, status, duration;
- app startup and shutdown;
- worker cycle start/end;
- jobs claimed/released/dead;
- send attempt start/success/failure/ambiguous;
- webhook received/verified/rejected;
- SES notification/event stored;
- suppression created;
- unsubscribe applied;
- readiness check started/completed with aggregate status;
- simulator run started/completed.

### Durable observability

- Persist worker cycles to `worker_runs`.
- Include worker health in operations summary.
- Include latest SES notification/event in SES summary.
- Do not persist every log line to SQLite in this milestone.

## Implementation phases

### Phase 1 — SES operations model and migration

1. Add `0004_ses_operations_and_tracking.sql`.
2. Create `ses_notifications`, `ses_events`, `ses_simulator_runs`, `worker_runs`.
3. Drop old `ses_feedback_*` tables in this migration if accepted.
4. Update migration tests, driver parity tests, and database contract tests.
5. Update test fixtures that directly seed old feedback tables.

Validation:

```sh
pnpm test apps/service/src/db
```

### Phase 2 — Move and rename SES webhook/event modules coherently

1. Create `apps/service/src/ses/`.
2. Move SNS schema/verifier/confirmer from `ses-feedback` to `ses`.
3. Replace SES event schema with new first-class event model.
4. Replace `process.ts` with new notification/event processor writing `ses_notifications`/`ses_events`.
5. Rename errors and update `http/respond.ts` mappings.
6. Update `app.ts` to mount new webhook route.
7. Delete old `apps/service/src/ses-feedback/` after equivalent tests pass.

Validation:

```sh
pnpm test apps/service/src/ses
pnpm test apps/service/src/app.test.ts
pnpm test apps/service/src/http/respond.test.ts
```

### Phase 3 — Config and runtime composition

1. Refactor config types so API can load incomplete SES config as readiness data.
2. Keep worker/send-time config fail-fast for required live sending values.
3. Add tracking env parsing.
4. Add `@aws-sdk/client-sns`.
5. Add AWS SES/SNS admin service layers and fakes.
6. Update API runtime to provide readiness services lazily/non-fatally.
7. Update tests and `.env.example`.

Validation:

```sh
pnpm test apps/service/src/config.test.ts
pnpm test apps/service/src/services
```

### Phase 4 — Readiness and setup guide endpoints

1. Implement readiness check engine with local, SES, and SNS checks.
2. Add short TTL cache and `?refresh=1`.
3. Implement setup guide generation.
4. Add operations routes under `/api/operations/ses/*`.
5. Delete `/api/operations/ses-feedback`.
6. Update route/read-model tests.

Validation:

```sh
pnpm test apps/service/src/operations
pnpm test apps/service/src/aws
pnpm test apps/service/src/ses
```

### Phase 5 — Open/click tracking ingestion and operations read models

1. Add Open/Click processing tests using AWS example-shaped payloads.
2. Add event list/detail/summary read models.
3. Ensure operations output is sanitized.
4. Add query parsing/validation for SES event filters.
5. Verify bounce/complaint suppression behavior still passes.

Validation:

```sh
pnpm test apps/service/src/ses
pnpm test apps/service/src/operations
```

### Phase 6 — Simulator CLI

1. Implement local/server `send-acceptance` mode.
2. Implement server-local `end-to-end` mode that polls local DB for SNS-ingested events.
3. Optionally implement remote target mode through public operations API if scope remains manageable.
4. Persist local/server runs to `ses_simulator_runs`.
5. Add package scripts.
6. Add tests with fake email transport and fake injected SES events.

Validation:

```sh
pnpm test apps/service/src/ses/simulator.test.ts
```

### Phase 7 — Observability

1. Add Effect JSON logger layer.
2. Add request logging middleware.
3. Replace operational `console.log/error` calls inside runtime-backed code with Effect logs.
4. Persist `worker_runs` per worker cycle.
5. Add sanitized logging tests where practical.
6. Keep pre-runtime fatal config parse errors on `console.error` because logger is unavailable before runtime construction.

Validation:

```sh
pnpm test apps/service/src/observability apps/service/src/sending
```

### Phase 8 — Documentation and cleanup

Create docs:

```txt
docs/ses-setup.md
docs/ses-readiness.md
docs/ses-simulator-testing.md
docs/observability.md
docs/engagement-tracking.md
docs/production-readiness.md
```

Update:

- `README.md`
- `PROJECT.md`
- `.env.example`
- route lists and scripts

Cleanup grep:

```sh
grep -R "ses-feedback\|SesFeedback\|ses_feedback\|operations/ses-feedback" -n apps README.md PROJECT.md docs .env.example
```

Expected result: no stale references, except possibly notes in migration docs/tests if deliberately retained.

## Documentation requirements

Docs must cover:

- SES sandbox vs production.
- Mailbox simulator addresses and expectations.
- SES configuration sets.
- Required event destination types.
- SNS topic/subscription setup.
- Required IAM permissions for readiness checks.
- Required env vars.
- Running readiness checks.
- Running simulator scripts.
- Understanding simulator modes.
- Monitoring recommendations.
- Open/click privacy and reliability caveats.
- Gmail/DKIM/List-Unsubscribe manual verification.
- Raw SNS JSON retention/PII note.

## Testing plan

Targeted tests:

```sh
pnpm test apps/service/src/db
pnpm test apps/service/src/config.test.ts
pnpm test apps/service/src/ses
pnpm test apps/service/src/aws
pnpm test apps/service/src/operations
pnpm test apps/service/src/sending
```

Full validation:

```sh
pnpm check
```

Add/adjust tests for:

- config parsing with missing SES setup;
- worker fail-fast with missing required send config;
- readiness all-ok, missing config, missing credentials, access denied, sandbox, missing SNS subscription;
- setup guide statuses/actions;
- SNS webhook route status mapping;
- SES event schema for all supported event types;
- event insertion/dedupe on SNS redelivery;
- bounce/complaint suppression side effects;
- open/click persistence;
- operations SES event filters;
- simulator success/failure/timeout states;
- worker run persistence;
- structured log sanitization.

## Live validation checklist after implementation

1. Deploy app with public HTTPS URL.
2. Call:

```sh
curl -H 'x-api-key: ...' https://host/api/operations/ses/readiness?refresh=1
```

3. Follow setup guide until required checks pass.
4. Run server-local simulator:

```sh
pnpm --filter @nusend/service ses:simulate success --purpose transactional --mode send-acceptance
pnpm --filter @nusend/service ses:simulate bounce --purpose transactional --mode end-to-end
pnpm --filter @nusend/service ses:simulate complaint --purpose transactional --mode end-to-end
```

5. Verify:

```txt
GET /api/operations/ses/summary
GET /api/operations/ses/events?eventType=Bounce
GET /api/suppressions?reason=bounce
```

6. Send a marketing simulator/real test mailing and confirm unsubscribe flow.
7. Send a real marketing test to Gmail and inspect original message for:
   - DKIM pass;
   - `List-Unsubscribe`;
   - `List-Unsubscribe-Post`.
8. If tracking enabled, open email and click test link; verify `Open`/`Click` events.

## Risks and mitigations

- **Readiness cannot require complete setup to boot**: config must represent missing values, not throw at API startup.
- **Simulator DB mismatch**: distinguish local send acceptance from deployed end-to-end validation.
- **AWS IAM gaps**: readiness maps missing permissions to actionable check results.
- **SNS async delays**: simulator uses clear polling timeouts and failure diagnostics.
- **Open tracking unreliability**: document image blocking/proxying/prefetching.
- **Click tracking rewrites links**: document UX/privacy impact.
- **Raw JSON PII**: do not expose/log raw payloads; add docs and future retention work.
- **Migration blast radius**: additive `0004` is default; reset migration only by explicit choice.
- **Scope size**: implement in coherent phases; do not mix R2/assets into this work.

## Cleanup checklist

Delete/replace:

- `apps/service/src/ses-feedback/`
- old `SesFeedback*` error names
- `ses_feedback_*` table references
- `/api/operations/ses-feedback`
- stale README/PROJECT route/docs references
- tests that assert old table names or endpoint paths
- ad-hoc runtime `console.log/error` where Effect logging should be used
- optional/hidden webhook-disabled behavior that obscures setup problems

Keep only if still useful after refactor:

- SNS signature verifier logic, moved/renamed.
- SNS subscription confirmation logic, moved/renamed.
- existing suppression policy tests, rewritten against `ses_events`.

## Definition of Done

- `apps/service/src/ses-feedback` is gone.
- New SES operations routes exist and are authenticated.
- Old `/api/operations/ses-feedback` route is gone.
- Readiness endpoint works with missing SES config and reports actionable checks.
- Setup-guide endpoint gives step-by-step AWS setup instructions.
- Simulator CLI supports send-acceptance and end-to-end modes with clear output.
- SES event ingestion stores deliverability and engagement events in `ses_events`.
- Bounce/complaint suppressions still work.
- Open/click events are persisted and visible through operations endpoints.
- Worker runs are persisted.
- Runtime logs are structured and sanitized through Effect logging.
- Docs are added/updated.
- Stale SES feedback names are removed by grep.
- `pnpm check` passes.

## Independent review notes

This plan was reviewed with Claude Opus 4.8. Key accepted corrections:

- readiness/setup must not require complete SES config to boot;
- simulator feedback validation needs explicit deployment/server modes to avoid local DB vs public webhook DB mismatch;
- additive `0004` migration is safer than rewriting checksum-validated migrations;
- event dedupe should not use invalid expression-based table `UNIQUE` constraints;
- observability should use Effect logging instead of a bespoke logger service;
- SES module rename must be coherent with event-processing changes, not split into broken intermediate phases.
