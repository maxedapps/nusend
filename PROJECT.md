# Nusend Project Summary

## Purpose

Nusend is a single-user, self-hostable, API-first email orchestration service for AWS SES.

It is not a Mailchimp clone and not a hosted multi-tenant SaaS. The goal is a lean service that developers and agents can run on their own VPS to create, queue, send, and track transactional and marketing email through SES.

## Current Status

Nusend currently supports creating protected mailings, queueing per-recipient delivery jobs, idempotent mailing creation, and a send worker foundation that can send transactional deliveries through AWS SES v2.

Implemented today:

- Bun + Hono HTTP service
- Effect v4 service/layer architecture
- SQLite migrations and local database tooling
- Google-only Better Auth setup with signup disabled
- single-user/self-hosted auth model
- owner bootstrap CLI
- user-owned Better Auth API keys
- protected `POST /api/mailings`
- protected read-only `/api/operations/*` inspection endpoints
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
- terminal marketing send policy block until unsubscribe support exists
- request/body/content limits
- sanitized internal error logging
- production HTTPS validation for auth URLs/trusted origins

Not implemented yet:

- marketing SES sending
- unsubscribe routes/pages
- SES event ingestion
- contact/list management APIs
- templates
- Cloudflare R2 assets
- CLI/client tooling

## Current Interface

The current interface is the HTTP API in `apps/service`.

Available routes:

- `GET /health`
- `GET /health/db`
- `/api/auth/*` Better Auth passthrough for standard auth methods
- `POST /api/mailings`
- `GET /api/operations/summary`
- `GET /api/operations/deliveries`
- `GET /api/operations/deliveries/:id`

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
```

## Current Stack

- TypeScript
- Effect `4.0.0-beta.93`
- Bun runtime
- Hono `4.12.x`
- SQLite via Bun's SQLite client in production and Node SQLite in tests
- Better Auth `1.6.23`
- Better Auth API Key plugin `1.6.23`
- pnpm monorepo
- MIT license

Roadmap integrations:

- AWS SNS HTTPS webhook for SES events
- Cloudflare R2 / S3-compatible API for public email assets

## Product Boundaries

Nusend should focus on infrastructure and automation:

- API-first sending orchestration
- delivery state tracking
- durable queueing
- suppression/unsubscribe handling
- SES integration and feedback processing
- predictable machine-readable errors

Avoid early scope:

- visual email editor
- complex journey/automation builder
- A/B testing
- advanced segmentation
- analytics dashboard
- hosted SaaS multi-tenancy
- premature CLI/SDK packages

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
- current API-key permission surface is `mailings:create` and `operations:read`
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

Current Better Auth tables:

- `users`
- `sessions`
- `accounts`
- `verifications`
- `api_keys`

API keys use `reference_id = userId`.

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

Important limitation: list/contact management APIs do not exist yet. Lists and contacts can currently only be managed directly in the database or tests.

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
- future SES event ingestion may add `delivered`, `bounced`, and `complained` statuses.
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

`POST /api/mailings` creates a mailing, snapshots recipients into deliveries, and queues one send-delivery job per unsuppressed delivery.

Auth:

- Better Auth session, or
- user-owned API key with `mailings:create`

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

Auth:

- Better Auth session owner, or
- user-owned API key with `operations:read`

Scope and privacy:

- read-only: no retry, cancel, release, or queue mutation controls
- delivery list/detail include job and latest/all attempt context
- responses omit recipient `vars_json`, mailing HTML/text, auth/session data, and API-key data
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

Marketing sends are currently blocked by worker policy until unsubscribe support exists. Marketing jobs become terminal delivery failures with a clear policy error and do not call the raw transport.

Create-time validation is not enough. The worker pipeline must enforce marketing compliance immediately before raw sending.

Required before unblocking marketing:

- public unsubscribe URL config
- signed unsubscribe token generation
- unsubscribe endpoint/page
- suppression write on unsubscribe
- `List-Unsubscribe` headers
- policy tests proving marketing cannot send without this support

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
NUSEND_SES_MARKETING_CONFIGURATION_SET optional, future
NUSEND_SES_REQUEST_TIMEOUT_MS default 30000
NUSEND_SEND_WORKER_LEASE_SECONDS default 300
NUSEND_SEND_WORKER_BATCH_SIZE default 1
NUSEND_SEND_WORKER_POLL_MS default 5000
```

`NUSEND_SEND_WORKER_BATCH_SIZE * NUSEND_SES_REQUEST_TIMEOUT_MS + 10000` must stay below `NUSEND_SEND_WORKER_LEASE_SECONDS * 1000`.

SES tags should include:

```txt
mailing_id
delivery_id
purpose
```

Configuration sets should be selected in the prepare stage and passed to the raw transport as already-computed data.

## SES Events Roadmap

Use SES configuration sets and SNS HTTPS webhook delivery.

Future event table:

```sql
ses_events(
  id,
  sns_message_id,
  ses_message_id,
  event_type,
  delivery_id,
  raw_json,
  processed_at,
  created_at
)
```

Webhook flow:

```txt
receive SNS request
  -> verify SNS signature
  -> validate expected TopicArn
  -> handle SubscriptionConfirmation
  -> store raw event
  -> idempotently process event
  -> map SES message ID to delivery
  -> update delivery status
  -> update suppressions for bounces/complaints/unsubscribes
```

SNS signature verification is required.

Events to support early:

- Bounce
- Complaint
- Delivery
- Send
- Reject
- Rendering Failure
- DeliveryDelay

Open/click tracking should be optional and only added if explicitly desired.

## Suppression and Unsubscribe Policy

Nusend's database suppressions are the application source of truth.

Recommended policy:

- hard permanent bounce -> `scope=all`, `reason=bounce`
- marketing unsubscribe -> `scope=list` or `scope=marketing`, `reason=unsubscribe`
- marketing complaint -> `scope=marketing` or `scope=list`, `reason=complaint`
- transactional complaint -> record event; do not automatically block all transactional email
- manual suppression -> caller chooses scope deliberately

Rationale: a complaint should stop unwanted marketing, but should not automatically make password resets, login codes, receipts, or account-critical transactional email impossible.

Do not use SES-managed `ListManagementOptions` initially because Nusend owns contacts, lists, unsubscribe links, and suppression behavior.

SES configuration sets should be used primarily for event publishing and optional suppression behavior. Operators must configure SES suppression carefully because account-level complaint suppression can interfere with transactional mail.

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

## Future Client Tooling

No CLI exists today.

A CLI or typed SDK can be added later when there is a concrete need. Any future CLI should:

- call the public HTTP API
- avoid importing service internals
- support JSON output
- be installable independently if it becomes a real distributable

Do not add shared packages until there are at least two real consumers.

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
        db/
        http/
        mailings/
        queue/
        services/
        testing/
```

No `apps/cli` and no `packages/*` exist today.

Keep API and future worker entrypoints inside `apps/service` initially. They share DB access, queue logic, delivery state transitions, suppression logic, SES config, and rendering/preparation code.

## Roadmap Order

Recommended next phases:

### 1. Sending foundation

- add idempotency for `POST /api/mailings`
- add `send_attempts`
- add `deliveries.ses_message_id` and `deliveries.last_error`
- add send pipeline modules
- add purpose-agnostic `EmailTransport`
- add transactional SES sending first
- add worker `run once` and loop entrypoints
- keep marketing sends blocked by policy until unsubscribe support exists

### 2. Marketing compliance

- public unsubscribe URL config
- signed unsubscribe tokens
- unsubscribe endpoint/page
- suppression/list-membership update on unsubscribe
- `List-Unsubscribe` headers
- unblock marketing sending only after policy tests pass

### 3. SES feedback events

- configuration-set docs/setup
- SNS webhook
- SNS signature verification
- raw event storage
- idempotent event processing
- delivery status updates
- bounce/complaint suppressions

### 4. Contact/list management APIs

- create/update/delete lists
- add/import contacts
- subscribe/unsubscribe memberships
- manage suppressions manually

### 5. Templates and placeholder rendering

- template CRUD if needed
- safe placeholder renderer
- preview/dry-run endpoint
- optional mdtoemail integration boundary

### 6. Assets and polish

- R2 asset upload/management
- OpenAPI docs
- deployment docs
- Docker/systemd guidance
- future CLI/SDK only if needed

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

Questions to resolve after the initial sending foundation:

- whether `text` should become required before real sending
- how to surface ambiguous send attempts in API/admin views
- exact SES configuration-set names and operator setup docs
- exact SES account/config-set suppression recommendation for transactional vs marketing
- public unsubscribe URL configuration format
- whether to add a minimal admin/API surface for queue and delivery inspection before SES events

Default lean choices:

- single-user/self-hosted only
- no org/workspace support
- no CLI until a concrete need exists
- no shared packages initially
- `mailings` + `deliveries` as the core model
- one send-delivery job per unsuppressed delivery
- Nusend-owned suppression/unsubscribe model
- SES configuration sets for feedback events
- transactional sending before marketing sending
