# Nusend Project Summary

## Purpose

Nusend is a single-user, self-hostable email orchestration product for AWS SES with two first-class interfaces: an HTTP API and a CLI.

It is not a Mailchimp clone and not a hosted multi-tenant SaaS. The goal is a lean service that developers and agents can run on their own VPS to create, queue, send, track, and operate transactional and marketing email through SES.

## Current Status

Nusend currently supports creating protected mailings, queueing per-recipient delivery jobs, idempotent mailing creation, a send worker foundation that can send through AWS SES v2, and SES operations ingestion through SNS webhooks.

Implemented today:

- Bun + Hono HTTP service
- Effect v4 service/layer architecture
- SQLite migrations and local database tooling
- Google-only Better Auth setup with signup disabled
- single-user/self-hosted auth model
- owner bootstrap CLI
- first-party, user-owned Nusend API keys with scoped permissions, rotation, expiry, and debounced usage tracking
- device-code CLI login with authenticated browser activation and abuse controls
- first-class CLI for auth, API keys, contacts, and read-only mailings
- protected `POST /api/mailings` plus `GET /api/mailings` and `GET /api/mailings/:id`
- protected read-only `/api/operations/*` inspection endpoints
- contact/list management APIs
- manual suppression management APIs
- transactional mailing creation with explicit recipients
- marketing mailing creation from existing list data
- recipient snapshotting into `deliveries`
- suppression checks during mailing creation
- durable send-delivery queue primitives
- mailing creation idempotency via `Idempotency-Key`
- send attempts / SES message IDs / delivery error persistence
- purpose-agnostic SES v2 email transport
- send worker scripts for once/loop processing
- transactional send pipeline with placeholder rendering
- self-managed unsubscribe support for marketing mailings (`{{ unsubscribe.url }}`, signed public links, one-click POST, local suppressions)
- marketing send-time compliance gates for unsubscribe config, SES marketing configuration set, and suppressions
- RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers for marketing sends
- SES configuration-set/SNS feedback ingestion with local bounce/complaint suppressions
- sanitized SES operations endpoints
- request/body/content limits
- sanitized internal error logging
- production HTTPS validation for auth URLs/trusted origins

Not implemented yet:

- production marketing volume (pending live SES simulator feedback validation, operations monitoring, and Gmail DKIM one-click verification)
- templates
- Cloudflare R2 assets
- remaining CLI domain families for lists, suppressions, operations, and SES administration

## Current Interface

Nusend has two product interfaces:

1. The authoritative HTTP API in `apps/service`.
2. The first-class CLI in `apps/cli`, implemented as a thin HTTP client.

Available HTTP routes:

- `GET /health`
- `GET /health/db`
- `/api/auth/*` Better Auth passthrough for standard auth methods
- `GET /api/me`
- `GET /api/api-keys`
- `POST /api/api-keys`
- `DELETE /api/api-keys/:id`
- `POST /api/api-keys/:id/rotate`
- `POST /api/device-authorizations`
- `POST /api/device-authorizations/token`
- `GET /cli/activate`
- `POST /cli/activate`
- `POST /api/contacts`
- `GET /api/contacts`
- `GET /api/contacts/:id`
- `PATCH /api/contacts/:id`
- `DELETE /api/contacts/:id`
- `POST /api/lists`
- `GET /api/lists`
- `GET /api/lists/:id`
- `PATCH /api/lists/:id`
- `DELETE /api/lists/:id`
- `GET /api/lists/:id/contacts`
- `POST /api/lists/:id/contacts`
- `DELETE /api/lists/:id/contacts/:contactId`
- `POST /api/mailings`
- `GET /api/mailings`
- `GET /api/mailings/:id`
- `GET /api/operations/summary`
- `GET /api/operations/deliveries`
- `GET /api/operations/deliveries/:id`
- `GET /api/operations/ses/events`
- `GET /api/operations/ses/summary`
- `GET /api/operations/ses/events/:id`
- `GET /api/operations/ses/readiness`
- `GET /api/operations/ses/setup-guide`
- `GET /api/operations/ses/simulator-runs`
- `GET /api/operations/ses/simulator-runs/:id`
- `POST /api/suppressions`
- `GET /api/suppressions`
- `DELETE /api/suppressions/:id`
- `POST /api/webhooks/aws/sns/ses`
- `GET /unsubscribe/:token`
- `POST /unsubscribe/:token`

Current service scripts:

```sh
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service db:status
pnpm --filter @nusend/service db:rollback
pnpm --filter @nusend/service auth:bootstrap --email max@example.com --name "Max"
pnpm --filter @nusend/service dev
pnpm --filter @nusend/service start
pnpm --filter @nusend/service worker:send:once
pnpm --filter @nusend/service worker:send
pnpm --filter @nusend/service ses:simulate
pnpm --filter @nusend/service ses:simulate:all
pnpm --filter @nusend/service typecheck
pnpm --filter @nusend/service test
```

Current CLI scripts:

```sh
pnpm --filter @nusend/cli build   # builds @nusend/api-contract first, then the CLI
pnpm --filter @nusend/cli typecheck
pnpm --filter @nusend/cli test
./apps/cli/dist/main.js --help
```

Focused service tests use package-relative paths and omit pnpm's literal `--` separator because Vitest 4 treats arguments after it as non-filtering passthrough:

```sh
pnpm --filter @nusend/service test src/config.test.ts
```

Portable test-audit evidence is checked with:

```sh
pnpm audit:test          # exercise the adversarial audit-tool contract
pnpm audit:validate      # strictly validate committed identities, topology, and review evidence
pnpm audit:render:check  # verify the generated Markdown view is byte-current
pnpm audit:independent   # independently recompute final identities and multiset deltas
```

To compare a newly collected Vitest JSON report without comparing timing bytes, run:

```sh
node scripts/test-quality-audit/cli.mjs compare-report --snapshot final --report <current.json> --inventory docs/test-audit/final-inventory.json
```

This comparison requires a successful report with matching normalized identities, multiplicities, file count, and test count.

## Upgrade and compatibility notes

- Scoped API keys can revoke or rotate only keys whose permissions are a subset of the actor's permissions. A previously accepted scoped revoke may now return `403`; owner sessions remain unrestricted.
- CLI unknown options, options valid only on another subcommand, and duplicate nonrepeatable options exit `2` before config, credential, or network work. `--permission` remains repeatable.
- CLI HTTP redirects are rejected and API keys are never forwarded to a redirect target. Configure each profile with the canonical service URL instead of a redirecting alias.
- `NUSEND_HTTP_TIMEOUT_MS` overrides the CLI HTTP timeout (default `30000`). It must be an unpadded decimal safe integer of at least `1`; surrounding whitespace is invalid. Invalid values exit `2` when an HTTP client is needed. Local-only commands such as `config repair-permissions` do not parse it.
- Destructive `db:rollback` operations print a sorted table inventory before refusal or execution and require `NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK=1`.
- Migration `0008` creates a unique `jobs(delivery_id)` index. Legacy duplicate jobs make the migration fail and require operator inspection; do not delete duplicates silently.
- The internal `PaginationSchema` value is no longer exported from `@nusend/api-contract`; the `Pagination` type and `PaginationMetaSchema` remain public.
- Device-authorization request limiters are process-local in-memory ceilings and reset on restart. Multi-process deployments enforce one independent ceiling per process; durable pending-row limits remain database-backed.
- Migration `0004` intentionally uses reset-clean semantics for legacy `ses_feedback_*` data. Applying it discards those legacy rows; export them before migration if history is required.
- `/api/operations/deliveries` is a filtered, limit-only operational view and does not promise `offset`; unknown delivery query parameters are not a pagination contract. `/api/operations/ses/events` supports offset pagination.

## Current Stack

- TypeScript
- Effect `4.0.0-beta.93`
- Bun runtime
- Hono `4.12.x`
- SQLite via Bun's SQLite client in production and Node SQLite in tests
- Better Auth `1.6.23`
- first-party Nusend API keys for programmatic and CLI access
- pnpm monorepo
- MIT license

Roadmap integrations:

- SNS→SQS SES operations worker alternative if HTTPS webhook delivery becomes operationally painful
- Cloudflare R2 / S3-compatible API for public email assets

## Product Boundaries

Nusend should focus on infrastructure and automation:

- API-first sending orchestration
- delivery state tracking
- durable queueing
- suppression/unsubscribe handling
- SES integration and feedback processing
- predictable machine-readable errors
- first-class CLI workflows over the public HTTP API

Avoid early scope:

- visual email editor
- complex journey/automation builder
- A/B testing
- advanced segmentation
- analytics dashboard
- hosted SaaS multi-tenancy
- broad SDK packages before the HTTP/CLI contract is stable

## Auth Model

Nusend is currently single-user and self-hosted per instance.

Principals:

```ts
type SessionPrincipal = {
  kind: "session";
  userId: string;
};

type ApiKeyPrincipal = {
  kind: "api_key";
  apiKeyId: string;
  userId: string;
  permissions: Record<string, string[]>;
};
```

Rules:

- a valid session is the instance owner
- session principals bypass per-route permissions intentionally
- API keys are user-owned and permission-scoped
- current API-key permission surface is defined in the shared `@nusend/api-contract` catalog: `contacts:read/write`, `lists:read/write`, `mailings:read/write`, `operations:read`, `suppressions:read/write`, and `api_keys:read/write`
- Better Auth organizations/workspaces are intentionally not used
- no organization tables or active-organization fields exist in the live schema

Bootstrap creates or updates owner users only; it does not create workspaces.

## Current Data Model

The central model is:

```txt
mailings   = content + sending context
deliveries = one recipient snapshot + delivery state
jobs       = durable send-delivery queue records pointing at deliveries
```

### Auth Tables

Better Auth owns only browser-auth tables:

- `users`
- `sessions`
- `accounts`
- `verifications`

Nusend owns first-party auth tables:

- `api_keys`, keyed by `user_id` and storing only key hashes/previews
- `device_authorizations`, for short-lived CLI login approval and polling

Connection model: app database access is serialized through a single-permit semaphore per connection so concurrent request fibers cannot interleave statements into an open transaction on the shared SQLite connection. Better Auth runs its own statements on a dedicated second connection (same pragmas) for file-path databases. A `:memory:` database (dev only) cannot split, so Better Auth shares the single handle and relies on the semaphore alone.

### Lists and Contacts

Current schema supports list-based recipient resolution:

```sql
lists(
  id,
  name,
  created_at
)

contacts(
  id,
  email,
  created_at,
  updated_at
)

list_memberships(
  list_id,
  contact_id,
  subscribed_at,
  unsubscribed_at
)
```

Contacts and lists are manageable through protected `/api/contacts` and `/api/lists` endpoints. List-recipient personalization is still not implemented.

A membership is subscribed when:

```sql
unsubscribed_at IS NULL
```

Contact-level personalization is not implemented. A future migration may add contact attributes when list personalization APIs exist.

### Suppressions

Current schema:

```sql
suppressions(
  id,
  email,
  scope,     -- all | marketing | list
  list_id,
  reason,    -- bounce | complaint | unsubscribe | manual
  created_at
)
```

Suppression scopes:

```txt
all        blocks transactional and marketing
marketing  blocks marketing only
list       blocks one list only
```

Current create-mailing behavior:

- transactional mailings check only `scope = all`
- marketing mailings check `all`, `marketing`, and matching `list`
- all-suppressed or empty recipient sets return `422 empty_recipient_set`
- partially suppressed mailings still persist suppressed `deliveries` rows, but only unsuppressed deliveries get jobs

### Mailings

Current schema:

```sql
mailings(
  id,
  purpose,      -- transactional | marketing
  state,        -- scheduled | sending | completed
  name,
  subject,
  html,
  text,
  list_id,
  scheduled_at,
  created_at,
  updated_at
)
```

Notes:

- `subject`, `html`, and optional `text` are stored on the mailing.
- `html` is final HTML or a placeholder-bearing template string rendered by the send worker.
- current placeholders are limited to `{{ user.email }}` and `{{ vars.<key> }}`; HTML placeholder values are escaped.
- raw Markdown is not stored in Nusend.
- a marketing campaign is represented as a marketing mailing.
- new mailings start as `scheduled`.
- the send worker advances mailings to `sending` when the first attempt starts.
- `completed` means all deliveries are terminal (`sent`, `failed`, or `suppressed`), not that recipient inbox delivery was confirmed by SES events.

### Deliveries

Current schema:

```sql
deliveries(
  id,
  mailing_id,
  email,
  contact_id,
  vars_json,
  status,       -- queued | sending | sent | failed | suppressed
  ses_message_id,
  last_error,
  created_at,
  updated_at
)
```

Notes:

- `email` is snapshotted.
- `contact_id` is nullable.
- `vars_json` is per-recipient personalization data supplied by explicit-recipient requests.
- list recipient personalization is not implemented yet because contacts have no attrs column.
- `ses_message_id` stores the provider message ID after SES accepts a send.
- `last_error` stores a safe, bounded delivery-level failure reason.
- SES operations is recorded separately in `ses_notifications / ses_events` audit tables; it does not add `delivered`, `bounced`, or `complained` delivery statuses.
- future pause/cancel APIs may add cancelled delivery/job states; draft mailings should only be added with a real draft workflow.

### Jobs

Current schema:

```sql
jobs(
  id,
  state,         -- queued | leased | succeeded | dead
  run_at,
  attempts,
  max_attempts,
  locked_by,
  locked_until,
  delivery_id,
  last_error,
  created_at,
  updated_at
)
```

`jobs.delivery_id` points to `deliveries.id`. The queue is intentionally send-delivery-specific, not a generic internal job platform.

Current queue primitives support:

- claim due jobs atomically
- lease metadata
- retry with SQL-backed backoff
- release expired leases
- complete jobs
- fail jobs into retry or dead state

`worker:send:once` and `worker:send` consume due send-delivery jobs. The queue runner owns complete/fail transitions, reconciles dead jobs back to terminal delivery state, and refreshes mailing state. The send processor records delivery/attempt state and returns success/failure.

### Send Attempts

Current schema:

```sql
send_attempts(
  id,
  delivery_id,
  job_id,
  attempt_no,
  status,          -- started | succeeded | failed | ambiguous
  ses_message_id,
  error_message,
  started_at,
  finished_at
)
```

Attempts are created before the external SES call, then updated after success/failure. DB transactions stay short and never wrap the SES request.

## Current Mailings API

`POST /api/mailings` creates a mailing, snapshots recipients into deliveries, and queues one send-delivery job per unsuppressed delivery. `GET /api/mailings` lists metadata and delivery-status counts without message bodies. `GET /api/mailings/:id` returns one mailing including subject/HTML/text; neither read endpoint exposes recipient variables.

Auth:

- Better Auth session owner, or
- user-owned API key with `mailings:read` for GET routes
- user-owned API key with `mailings:write` for POST

Request must provide exactly one recipient source:

- `recipients` for explicit recipients
- `listId` for list recipients

Transactional requests must use explicit `recipients`. Marketing requests may use `recipients` or `listId`.

Current limits:

- request body: 1 MB
- explicit recipients: 1,000
- list recipients: 5,000
- suppression/contact lookup batch size: 500
- subject: 200 chars
- name: 120 chars
- html/text: 200,000 chars each
- email: 320 chars
- list ID: 200 chars
- serialized recipient `vars`: 10,000 bytes
- `Idempotency-Key`: 255 characters after trimming

Successful creation returns the mailing ID, purpose, scheduled time, state, and delivery/queued/suppressed counts.

Optional `Idempotency-Key` behavior:

- same key + same normalized request returns the original creation response
- same key + different normalized request returns `409 idempotency_conflict`
- response snapshots are stored so later delivery status changes do not alter replay responses

## Current Operations Inspection API

The read-only operations surface helps the instance owner inspect queue, delivery, and send-attempt state during SES validation without direct SQLite queries.

Routes:

- `GET /api/operations/summary`
- `GET /api/operations/deliveries`
- `GET /api/operations/deliveries/:id`
- `GET /api/operations/ses/events`
- `GET /api/operations/ses/events/:id`
- `GET /api/operations/ses/summary`
- `GET /api/operations/ses/readiness`
- `GET /api/operations/ses/setup-guide`
- `GET /api/operations/ses/simulator-runs`
- `GET /api/operations/ses/simulator-runs/:id`

Auth:

- Better Auth session owner, or
- user-owned API key with `operations:read`

Scope and privacy:

- read-only: no retry, cancel, release, or queue mutation controls
- delivery list/detail include job and latest/all attempt context
- responses omit recipient `vars_json`, mailing HTML/text, auth/session data, API-key data, and raw SES/SNS feedback JSON
- standalone jobs/attempts endpoints, queue mutation APIs, and an admin UI remain future work

## Sending Architecture

Email sending should be a pipeline. The raw sender should remain purpose-agnostic.

Final worker flow:

```txt
claim send-delivery job
  -> load delivery + mailing
  -> start send attempt
  -> run policy gates
  -> render placeholders
  -> prepare transport email
  -> call raw transport sender
  -> record outcome
  -> complete/fail job
```

The raw transport sender should only know how to send a prepared email:

```ts
type PreparedEmail = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string | null;
  headers: Record<string, string>;
  tags: Record<string, string>;
  configurationSetName: string | null;
};
```

It should not know about:

- marketing vs transactional policy
- unsubscribe rules
- suppression policy
- mailing creation idempotency
- queue retry policy

Those belong in earlier pipeline stages.

### Pipeline Stages

1. **Claim job**
   - use existing queue claim logic
   - job remains leased while processing

2. **Load context**
   - load delivery by `job.delivery_id`
   - load mailing by `delivery.mailing_id`

3. **Start attempt**
   - insert `send_attempts` row
   - mark delivery `sending`
   - mark mailing `sending` if it was still `scheduled`
   - do this in a short DB transaction

4. **Policy gates**
   - skip/complete already terminal deliveries
   - re-check suppressions immediately before sending
   - enforce marketing unsubscribe/compliance requirements before marketing sends
   - future: quota/rate checks

5. **Render placeholders**
   - render subject/html/text for this delivery
   - current context supports:
     - `user.email`
     - `vars.*` from `deliveries.vars_json`
   - HTML placeholder values are escaped; subject/text substitutions stay plain text
   - future richer rendering work includes context-aware URL handling and `unsubscribe.url`

6. **Prepare transport email**
   - set `from`, `to`, subject/html/text
   - set SES tags such as `mailing_id`, `delivery_id`, `purpose`
   - choose configuration set if configured
   - include headers produced by policy/preparation stages

7. **Raw send**
   - call SES v2 `SendEmail`
   - return provider message ID

8. **Record success**
   - mark attempt succeeded
   - store SES message ID
   - mark delivery `sent`
   - complete job

9. **Record failure**
   - mark attempt failed
   - store safe error message
   - for retryable failures, fail the send-delivery job so queue backoff handles retry/dead state
   - if a job reaches `dead`, mark its delivery `failed` and refresh mailing state
   - for permanent policy failures, mark delivery failed/suppressed and complete the job

Never hold a DB transaction open while calling SES.

### Transactional Sending Flow

Transactional sending uses the same pipeline and raw sender.

Policy expectations:

- explicit recipients only at creation time
- no unsubscribe requirement
- `scope=all` suppressions block sending
- marketing/list suppressions do not block transactional sending

Current milestone recommendation:

- enable transactional sending first
- keep marketing sending blocked by policy until unsubscribe support exists

### Marketing Sending Flow

Marketing sending uses the same raw sender, with additional policy/preparation before the raw send step.

Creation flow:

```txt
POST /api/mailings purpose=marketing listId=...
  -> validate/auth/idempotency
  -> load subscribed list contacts
  -> apply create-time suppressions
  -> create mailing
  -> snapshot deliveries
  -> create send-delivery jobs
```

Worker policy/preparation flow:

```txt
load delivery + mailing
  -> re-check all/marketing/list suppressions
  -> require unsubscribe feature/config
  -> generate signed unsubscribe URL
  -> expose unsubscribe.url to rendering
  -> add List-Unsubscribe headers
  -> prepare generic transport email
  -> raw sender sends prepared email
```

Marketing-specific requirements:

- public unsubscribe route/page
- signed unsubscribe token
- list or marketing suppression on unsubscribe
- `List-Unsubscribe` header
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click` where supported

Key boundary: marketing compliance is a policy/preparation concern, not raw sender logic.

## Pre-Send Safety Requirements

Nusend now has the two safety foundations required before real SES sending: mailing creation idempotency and send attempts.

### Mailing Creation Idempotency

`POST /api/mailings` supports an optional `Idempotency-Key` header.

Behavior:

- same key + same normalized request returns the original creation response
- same key + different normalized request returns `409 idempotency_conflict`
- idempotency records store `response_json` so retries do not recompute mutable delivery counts after sending
- DB uniqueness conflicts are re-read instead of leaking raw constraint errors

Current table:

```sql
mailing_idempotency_keys(
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (...)
)
```

### Send Attempts and Ambiguous Sends

SES normal `SendEmail` does not provide a true application-level idempotency token. Nusend must assume at-least-once processing around crashes/timeouts.

Current send-attempt model:

```sql
send_attempts(
  id,
  delivery_id,
  job_id,
  attempt_no,
  status,          -- started | succeeded | failed | ambiguous
  ses_message_id,
  error_message,
  started_at,
  finished_at
)
```

Current delivery outcome fields:

```sql
deliveries.ses_message_id
deliveries.last_error
```

Important ambiguity:

```txt
SES accepts message -> process crashes before DB success write -> lease expires -> retry can duplicate send
```

This cannot be eliminated completely without provider idempotency. Mitigate by recording attempts before sending, keeping sends one-recipient-per-delivery, using clear statuses, and surfacing ambiguous states if needed.

### Marketing Compliance Gate

Marketing sends are no longer blanket-blocked, but they remain operationally gated. A marketing delivery is retried (not permanently failed) when unsubscribe config or `NUSEND_SES_MARKETING_CONFIGURATION_SET` is missing, and it is suppressed at send time when the recipient has a matching `all`, `marketing`, or list-scoped suppression.

Create-time validation is not enough. The worker pipeline enforces marketing compliance immediately before raw sending.

Implemented marketing compliance support:

- public HTTPS unsubscribe URL config
- signed delivery-id unsubscribe token generation with current/previous secret support
- public unsubscribe confirmation/one-click endpoints
- local `scope='marketing'` suppression write on unsubscribe
- optional originating list membership `unsubscribed_at` update
- `List-Unsubscribe` and `List-Unsubscribe-Post` headers
- policy tests proving marketing retries without config and suppresses recipients at send time

Before real marketing volume, validate SES operations ingestion with the simulator in production, perform live SES/Gmail DKIM verification for the unsubscribe headers, and monitor operations for marketing config retry/dead-job buildup.

## SES Integration Vision

Use AWS SES v2 `SendEmail` through an `EmailTransport` service.

Recommended service boundary:

```ts
interface EmailTransport {
  send(email: PreparedEmail): Effect.Effect<SendResult, EmailTransportError>;
}
```

Live implementation:

- wraps `@aws-sdk/client-sesv2`
- maps AWS errors into typed errors
- never logs secrets or full payloads
- returns SES message ID on success

Test implementation:

- fake transport service
- can simulate success, retryable failure, permanent failure, and ambiguous failure

Current SES / send-worker config:

```txt
AWS_REGION
NUSEND_SES_FROM_EMAIL
NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET optional
NUSEND_SES_MARKETING_CONFIGURATION_SET required for marketing sends
NUSEND_SES_FEEDBACK_TOPIC_ARNS optional comma-separated allowed SNS topic ARNs; enables feedback webhook
NUSEND_SES_REQUEST_TIMEOUT_MS default 30000
NUSEND_SEND_WORKER_LEASE_SECONDS default 300
NUSEND_SEND_WORKER_BATCH_SIZE default 1
NUSEND_SEND_WORKER_POLL_MS default 5000
NUSEND_PUBLIC_BASE_URL required for marketing sends; absolute HTTPS URL without query, fragment, or HTML-escapable characters (`&`, `'`, `"`, `<`, `>`)
NUSEND_UNSUBSCRIBE_SECRET required for marketing sends; at least 32 characters
NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET optional during unsubscribe token secret rotation; at least 32 characters and different from current
```

`NUSEND_SEND_WORKER_BATCH_SIZE * NUSEND_SES_REQUEST_TIMEOUT_MS + 10000` must stay below `NUSEND_SEND_WORKER_LEASE_SECONDS * 1000`.

Delivery rows must be retained for at least 13 months so old signed unsubscribe links can resolve honestly. If a retained delivery no longer exists, unsubscribe routes return an expired-link response instead of pretending success.

SES tags should include:

```txt
mailing_id
delivery_id
purpose
```

Configuration sets should be selected in the prepare stage and passed to the raw transport as already-computed data.

## SES Feedback Ingestion

Nusend uses SES configuration sets with SNS HTTPS webhook delivery:

```txt
SES configuration set -> SNS Standard topic -> POST /api/webhooks/aws/sns/ses
```

Current audit tables:

```sql
ses_notifications(
  id,                    -- PK
  sns_message_id,        -- UNIQUE
  sns_topic_arn,
  sns_type,              -- Notification | SubscriptionConfirmation | UnsubscribeConfirmation
  ses_message_id,
  event_type,
  raw_json,
  received_at
)

ses_events(
  id,                    -- PK
  dedupe_key,            -- UNIQUE
  notification_id,       -- FK ses_notifications(id)
  event_type,
  delivery_id,
  mailing_id,
  ses_message_id,
  recipient_email,
  action_taken,          -- recorded | suppressed | ignored
  occurred_at,
  bounce_type,
  bounce_sub_type,
  complaint_feedback_type,
  feedback_id,
  diagnostic_code,
  reject_reason,
  delivery_delay_type,
  link_url,
  link_tags_json,
  ip_address,
  user_agent,
  created_at
)
```

Webhook flow:

```txt
receive raw SNS request
  -> parse outer SNS JSON shape
  -> verify SNS signature
  -> validate exact TopicArn allowlist
  -> handle SubscriptionConfirmation safely
  -> store raw SNS/SES audit JSON
  -> idempotently store per-recipient feedback
  -> map by delivery_id tag, then SES message ID
  -> insert global suppressions for permanent bounces and complaints
```

Permanent bounces create `scope=all reason=bounce`; complaints create `scope=all reason=complaint` except `complaintFeedbackType='not-spam'`. Transient bounces, rejects, delivery delays, deliveries, and unknown authentic event types are recorded without suppression. Delivery status remains send-processing-only.

Supported event types for the current milestone: Bounce, Complaint, Reject, DeliveryDelay, optional Delivery, optional Open/Click tracking, and authentic unknown events. Operations readiness also checks SES identity/DKIM, account suppression, configuration-set event destinations/tracking domain, SNS SignatureVersion 2, and confirmed webhook subscriptions. Worker-cycle observability is stored in bounded `worker_runs` rows with idle heartbeat behavior. SNS→SQS remains a documented alternative if public webhook delivery/retry/security becomes painful.

## Suppression and Unsubscribe Policy

Nusend's database suppressions are the application source of truth.

Recommended policy:

- hard permanent bounce -> `scope=all`, `reason=bounce`
- SES complaint feedback -> `scope=all`, `reason=complaint` unless `complaintFeedbackType='not-spam'`
- marketing unsubscribe -> `scope=list` or `scope=marketing`, `reason=unsubscribe`
- manual suppression -> caller chooses scope deliberately

Rationale: hard bounces and complaints are reputation-critical and should block both transactional and marketing sends; marketing unsubscribes remain marketing/list-scoped.

Do not use SES-managed `ListManagementOptions` initially because Nusend owns contacts, lists, unsubscribe links, and suppression behavior.

SES configuration sets are used for event publishing. Operators should also enable SES account-level suppression for `BOUNCE` and `COMPLAINT` as defense in depth, while keeping local SQLite suppressions as the application source of truth.

## Templates and Rendering Roadmap

Templates are not implemented today.

Future template model:

```sql
templates(
  id,
  name,
  purpose,
  subject,
  html,
  text,
  created_at,
  updated_at
)
```

When sending from a template, copy the current subject/html/text into `mailings`. This makes each send immutable without template-version tables.

Markdown-to-email HTML rendering should remain outside Nusend, ideally in the separate `mdtoemail` package. Nusend should store final HTML/text, not raw Markdown.

If placeholders are supported, rendering must be safe by context:

- text contexts escape/normalize text
- HTML text nodes escape HTML
- URL attributes validate URLs
- generated unsubscribe URLs are signed server-side
- missing variables fail predictably

Keep the placeholder system small. Initial useful variables:

```txt
{{ user.email }}
{{ vars.firstName }}
{{ unsubscribe.url }}  -- marketing only, after unsubscribe support exists
```

## Cloudflare R2 Assets Roadmap

Cloudflare R2 can later store public email assets such as images.

Recommendations:

- use a custom domain for production assets
- avoid relying on `r2.dev` for production
- require final email image URLs to be absolute HTTPS URLs
- resolve/upload assets before final HTML is stored on a mailing
- expose asset management only after core sending is stable

## CLI and Client Tooling

The CLI is now a core Nusend interface, not a future polish item.

The CLI must:

- call the public HTTP API
- avoid importing service internals or touching the service SQLite database directly
- import shared public API contracts from `@nusend/api-contract`
- support stable JSON output for automation
- store credentials through an explicit credential-store abstraction

Shared packages are now justified because `apps/service` and `apps/cli` are both real consumers of the public API contract.

## Repository Shape

Current structure:

```txt
nusend/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
  README.md
  PROJECT.md

  apps/
    service/
      package.json
      tsconfig.json
      src/
        app.ts
        main.ts
        config.ts
        auth/
        contacts/
        db/
        http/
        lists/
        mailings/
        operations/
        queue/
        sending/
        services/
        ses/
        suppressions/
        testing/
        unsubscribe/
    cli/
      package.json
      tsconfig.json
      src/
        main.ts
        client/
        commands/
        config/
        credentials/
        output/
        testing/

  e2e/
    cli-service.e2e.test.ts

  packages/
    api-contract/
      package.json
      tsconfig.json
      src/
        api-keys/
        auth/
        contacts/
        mailings/
        index.ts
        errors.ts
        pagination.ts
        permissions.ts
        routes.ts
```

Keep API and worker entrypoints inside `apps/service`. They share DB access, queue logic, delivery state transitions, suppression logic, SES config, and rendering/preparation code. The CLI must remain outside those internals and communicate through HTTP.

## Roadmap Order

Completed milestones:

1. Sending foundation: idempotent mailing creation, send attempts, SES transport/pipeline, and worker run-once/loop.
2. Marketing compliance: signed unsubscribe flow, list/suppression updates, RFC 8058 headers, and send-time policy gates.
3. SES operations events: verified SNS webhook ingestion, audit/read models, readiness/simulator tooling, and bounce/complaint suppressions.
4. Contact/list/suppression management HTTP APIs.
5. First-class API contract, first-party API keys, device login, and CLI auth/API-key/contact/mailings-read commands.

Next milestones:

### 6. Templates and placeholder rendering

- template CRUD if needed
- safe placeholder renderer
- preview/dry-run endpoint
- optional mdtoemail integration boundary

### 7. Assets and polish

- R2 asset upload/management
- OpenAPI docs
- deployment docs
- Docker/systemd guidance
- future SDKs only after the HTTP API and CLI contract stabilizes

## Key Safety Principles

- Raw sending must be purpose-agnostic.
- Policy gates run before raw sending.
- Do not send marketing email without unsubscribe support.
- Do not make transactional email impossible because of marketing unsubscribe/complaint state.
- Treat hard permanent bounces as likely all-mail undeliverability.
- Assume SES sending can be ambiguous after process crashes/timeouts.
- Record send attempts before external send calls.
- Never hold DB transactions open while calling SES.
- Keep queue jobs small and referential.
- Store raw SES events before processing.
- Verify SNS signatures.
- Use context-aware escaping for rendered variables.
- Require HTTPS for auth production origins and final email assets.
- Avoid logging secrets, API keys, raw auth causes, or sensitive email payloads.

## Open Questions

Questions for future milestones:

- whether `text` should become required before real sending
- how to surface ambiguous send attempts in API/admin views
- exact SES configuration-set names and operator setup docs
- exact SES account/config-set suppression recommendation for transactional vs marketing
- whether to add queue mutation/admin controls beyond the existing read-only operations API

Default lean choices:

- single-user/self-hosted only
- no org/workspace support
- CLI is a core interface
- shared packages are allowed for public API contracts consumed by service and CLI
- `mailings` + `deliveries` as the core model
- one send-delivery job per unsuppressed delivery
- Nusend-owned suppression/unsubscribe model
- SES configuration sets for feedback events
- transactional sending before marketing sending
