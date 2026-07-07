# Nusend Project Summary

## What We Are Building

Nusend is a self-hostable, open-source MIT email sending service built on top of AWS SES.

It is not a Mailchimp clone. It is a lean, API-first SES orchestration layer for developers and agents.

Current implemented scope is intentionally smaller than the roadmap:

- single-user, self-hosted instance auth
- Google-only Better Auth login with signup disabled
- user-owned API keys for the implemented API
- protected `POST /api/mailings`
- transactional and marketing mailing records
- explicit-recipient and list-recipient snapshots into `deliveries`
- suppressions during mailing creation
- durable `send_delivery` queue primitives with retries and dead-letter states

Roadmap capabilities include:

- reusable templates
- real AWS SES sending
- send attempts and SES event ingestion
- unsubscribe routes/pages for marketing recipients
- public email assets hosted on Cloudflare R2
- contacts/list management APIs
- optional CLI/client tooling

Current interface:

- HTTP API

Initial deployment target:

- self-hosted VPS
- Bun runtime
- SQLite database
- AWS SES for delivery
- Cloudflare R2 for public email assets

## Core Stack

- TypeScript
- Effect (v4) for services/layers, config, schema validation, and typed errors
- Bun
- Hono (thin HTTP shell over Effect programs)
- SQLite via Bun's SQLite client
- AWS SES v2 (roadmap delivery integration)
- AWS SNS HTTPS webhook for SES events (roadmap)
- Cloudflare R2 / S3-compatible API for assets (roadmap)
- pnpm-managed monorepo
- MIT license

## Product Positioning

Recommended positioning:

> A self-hosted, API-first email service for AWS SES with transactional and marketing sends, scheduling, durable delivery state, and a roadmap for SES feedback handling, contacts, campaigns, unsubscribe management, reusable templates, and ad-hoc messages.

Keep the product focused on infrastructure and automation. Avoid early scope such as:

- visual email editor
- complex automation journeys
- A/B testing
- advanced segmentation
- large analytics dashboard
- hosted SaaS multi-tenancy

## Core Data Model: Mailings and Deliveries

The central model is:

```txt
mailings   = content + sending context
deliveries = one recipient's delivery state
```

This replaces an earlier generic content/message split.

Why:

- a one-off transactional email is one `mailing` with one `delivery`
- a marketing campaign is one `mailing` with many `deliveries`
- campaign recipient snapshots are simply delivery rows
- content is stored once per mailing, not once per recipient
- transactional vs marketing can be inferred from the parent mailing
- no generic shared content type is needed
- no Markdown source is stored in this service

## Transactional vs Marketing Email

Transactional and marketing emails share the same infrastructure but follow different policies.

### Transactional Email

Transactional emails:

- may be sent to arbitrary recipients
- do not require a contact, list, or campaign
- do not require unsubscribe links
- may use reusable templates or ad-hoc content
- should not be blocked merely because the recipient unsubscribed from or complained about marketing
- should usually respect hard-bounce suppression, because the address is likely undeliverable

Examples:

- password reset
- login code
- purchase receipt
- account notification

### Marketing Email

Marketing emails:

- are tied to marketing intent
- often use contacts and lists
- require unsubscribe support
- check list/marketing/global suppressions before sending
- may use reusable templates or ad-hoc newsletter/campaign content
- snapshot recipients into `deliveries` when scheduled

Examples:

- newsletter
- product update
- promotional email
- announcement campaign

### Policy Difference

The split is enforced by policy, not by separate sending infrastructure.

Relevant context lives on `mailings` and `deliveries`:

- `mailings.purpose`: `transactional` or `marketing`
- `mailings.list_id`: nullable, mostly marketing
- `deliveries.contact_id`: nullable
- `deliveries.email`: actual recipient snapshot

Marketing sends must enforce unsubscribe and suppression rules. Transactional sends must remain possible for sensible account-critical messages unless the address is truly undeliverable or manually blocked at an all-mail scope.

## HTML Rendering and mdtoemail

Markdown-to-email-HTML rendering is integral to the product, but it is handled by the separate `mdtoemail` package.

Nusend should receive/store final HTML and optional text content. Nusend should not store raw Markdown input.

`mdtoemail` remains responsible for:

- Markdown to conservative email-friendly HTML
- table-based email layout
- inline styles
- safe theme tokens
- diagnostics and strict mode
- HTTPS-only image validation
- raw HTML escaping/removal
- email-client compatibility decisions

Nusend is responsible for:

- accepting final `subject`, `html`, and optional `text`
- storing those values on `mailings`
- safe variable rendering if template variables are supported
- enforcing marketing unsubscribe policy
- sending via SES
- tracking delivery state

### mdtoemail Integration Boundary

Recommended boundary:

```txt
author/compiler side:
  Markdown -> mdtoemail -> final HTML/text

Nusend side:
  final subject/html/text -> mailing -> deliveries -> SES
```

Nusend may call `mdtoemail` through an API/library for convenience, but the database should not depend on or preserve Markdown source.

### Template Variables

Avoid naive string replacement in final HTML.

If Nusend supports variables, rendering must be context-aware:

- subject/text values need text normalization
- HTML text nodes need HTML escaping
- URL attributes need URL validation
- image URLs should be absolute HTTPS URLs
- unsubscribe URLs should be generated server-side and signed

Keep the variable system intentionally small.

## Templates

Templates are reusable content definitions, not delivery history.

Conceptual schema:

```sql
templates(
  id,
  name,
  purpose, -- transactional | marketing
  subject,
  html,
  text,
  created_at,
  updated_at
)
```

When sending from a template, copy the template's current `subject`, `html`, and `text` into a `mailing`. This makes the send immutable without requiring template-version tables in the MVP.

Template versions can be added later only if there is a concrete need for historical editing/audit workflows.

## Mailings

A `mailing` represents a send batch. It can target one recipient or many recipients.

Conceptual schema:

```sql
mailings(
  id,
  purpose, -- transactional | marketing
  state,   -- draft | scheduled | sending | paused | cancelled | completed

  name,    -- nullable; useful for marketing campaigns/newsletters
  subject,
  html,
  text,    -- nullable but recommended

  list_id, -- nullable; marketing context
  scheduled_at,

  created_at,
  updated_at
)
```

Notes:

- `html` is final email HTML or an HTML template with supported placeholders.
- `text` is optional but recommended for deliverability and accessibility.
- No Markdown source column.
- No `source = template | ad_hoc` column; infer from how the row was created if needed.
- No `template_id` initially; if a template is used, copy its content into the mailing.
- A marketing “campaign” is simply a marketing mailing.

### Mailing States

```txt
draft
scheduled
sending
paused
cancelled
completed
```

`completed` can be derived from deliveries, but storing it is useful for workflow and quick listing. It must be updated consistently by the worker/service.

## Deliveries

A `delivery` represents one recipient's delivery state for a mailing.

Conceptual schema:

```sql
deliveries(
  id,
  mailing_id,
  email,
  contact_id, -- nullable
  vars_json,  -- nullable personalization data

  status, -- scheduled | queued | sending | sent | delivered | bounced | complained | failed | suppressed | cancelled

  ses_message_id,
  last_error,

  created_at,
  updated_at
)
```

Notes:

- No `purpose` column; infer from `mailings.purpose`.
- No subject/body columns; infer from `mailings`.
- `email` is snapshotted so delivery history remains stable even if a contact changes later.
- `vars_json` stores per-recipient personalization data when needed.
- Campaign recipient snapshots are represented by many delivery rows for one marketing mailing.

### Delivery Statuses

```txt
scheduled
queued
sending
sent
delivered
bounced
complained
failed
suppressed
cancelled
```

A later implementation may add an explicit `unknown` / `possibly_sent` status for ambiguous failures after calling SES.

## Sending Flows

### One-Off Transactional Send

```txt
POST /send
  -> create mailing(purpose=transactional, subject/html/text)
  -> create one delivery(email, vars_json?)
  -> enqueue send_delivery job
```

### Transactional Send From Template

```txt
load template
  -> copy subject/html/text into mailing(purpose=transactional)
  -> create one delivery(email, vars_json?)
  -> enqueue send_delivery job
```

### Marketing Campaign / Newsletter

```txt
create mailing(purpose=marketing, list_id, subject/html/text)
  -> snapshot subscribed contacts into deliveries
  -> enqueue one send_delivery job per delivery
```

Campaign progress is derived from deliveries:

```sql
select count(*) from deliveries where mailing_id = ?;
select count(*) from deliveries where mailing_id = ? and status = 'delivered';
select count(*) from deliveries where mailing_id = ? and status = 'bounced';
select count(*) from deliveries where mailing_id = ? and status = 'complained';
```

## Contacts and Lists

Keep contact/list models simple.

### Contacts

```sql
contacts(
  id,
  email,
  created_at,
  updated_at
)
```

Roadmap: add contact-level personalization only when list personalization is implemented. A future column such as `attrs_json` could store optional data:

```json
{
  "firstName": "Max",
  "plan": "Pro"
}
```

Avoid a contact `status` column initially unless it is clearly needed. Subscription and suppression state live in dedicated tables.

### Lists

```sql
lists(
  id,
  name,
  created_at
)
```

### List Memberships

```sql
list_memberships(
  list_id,
  contact_id,
  subscribed_at,
  unsubscribed_at
)
```

No separate membership `status` column is needed.

A membership is subscribed if:

```sql
unsubscribed_at is null
```

## Suppressions and Unsubscribe Handling

Suppressions are first-class and separate from list membership state.

Conceptual schema:

```sql
suppressions(
  id,
  email,
  scope,  -- all | marketing | list
  list_id,
  reason, -- bounce | complaint | unsubscribe | manual
  created_at
)
```

### Suppression Scopes

```txt
all       -> blocks transactional and marketing
marketing -> blocks marketing only
list      -> blocks a specific list only
```

### Recommended Policy

Hard permanent bounce:

```txt
create suppression(scope=all, reason=bounce)
```

Marketing unsubscribe:

```txt
create suppression(scope=list or marketing, reason=unsubscribe)
set list_memberships.unsubscribed_at if list-specific
```

Complaint from marketing email:

```txt
delivery.status = complained
create suppression(scope=marketing or list, reason=complaint)
```

Complaint from transactional email:

```txt
delivery.status = complained
record SES event
create suppression(scope=marketing, reason=complaint) if appropriate
do not automatically create scope=all
```

Rationale: a complaint should stop unwanted marketing, but should not automatically make important transactional email impossible. Password resets, login codes, receipts, and account-critical notifications may still be necessary.

Manual suppression:

```txt
scope chosen by user/admin/API caller
```

### Unsubscribe Page

The only initial public UI is an unsubscribe page.

Unsubscribe links should:

- use signed tokens
- avoid exposing raw internal IDs unnecessarily
- encode mailing/list/recipient context
- work reliably without authentication
- update list membership and/or suppressions
- be required for marketing mailings

Marketing sends must not proceed without unsubscribe support.

## Queue Design

SQLite is acceptable for the initial self-hosted queue if implemented carefully.

Jobs should be small and reference domain rows instead of storing full payloads.

Conceptual schema:

```sql
jobs(
  id,
  kind, -- send_delivery
  state, -- queued | leased | succeeded | failed | dead | cancelled

  run_at,
  attempts,
  max_attempts,
  locked_by,
  locked_until,

  ref_id,
  last_error,

  created_at,
  updated_at
)
```

`kind + ref_id` determines what table to load. No generic `ref_type` is needed initially.

`state = dead` is the dead-letter queue. No separate DLQ table is needed initially.

Recommended queue behavior:

- enable SQLite WAL mode
- set `busy_timeout`
- use short transactions
- atomically claim jobs
- use leases with expiration
- retry with backoff
- mark as `dead` after max attempts
- keep job payloads tiny
- roadmap: store detailed send history in `send_attempts` once real SES sending exists

Possible state transitions:

```txt
queued -> leased -> succeeded
queued -> leased -> failed -> queued
queued -> leased -> dead
queued -> cancelled
leased -> queued       -- lease expired / worker crashed
```

## Send Attempts

Keep send attempts separate because they are operationally useful and safety-relevant.

```sql
send_attempts(
  id,
  delivery_id,
  job_id,
  attempt_no,
  status,
  ses_message_id,
  error_message,
  started_at,
  finished_at
)
```

SES does not appear to expose an application-level idempotency token for normal sending. Nusend should assume at-least-once processing and handle ambiguous failures carefully.

## SES Sending

Use AWS SES v2 `SendEmail`.

Worker flow:

```txt
claim send_delivery job
  -> load delivery
  -> load mailing
  -> check suppression/list policy
  -> render variables if needed
  -> choose SES configuration set from mailing purpose
  -> send via SES
  -> write send_attempt
  -> store ses_message_id on delivery
  -> update delivery status
  -> complete job
```

Important SES constraints:

- sending quotas are per AWS region
- quotas are based on recipients
- SES has max send rate and 24-hour send quota
- sandbox accounts are heavily limited
- `SendEmail` supports Simple, Raw, and Templated content
- Simple messages can include HTML, text, or both
- `SendEmail` accepts `ConfigurationSetName`
- `SendEmail` accepts `EmailTags`
- SES can accept a message without ultimately sending it in some cases

Nusend should eventually include quota/rate awareness to avoid exceeding SES limits.

## SES Configuration Sets

Use SES configuration sets.

AWS SES event publishing to SNS is configured through configuration sets. `SendEmail` accepts a `ConfigurationSetName`, and SES publishes configured events for messages sent with that configuration set.

Recommended configuration sets:

```txt
nusend-transactional
nusend-marketing
```

Use the appropriate configuration set on every send:

```txt
mailings.purpose = transactional -> nusend-transactional
mailings.purpose = marketing      -> nusend-marketing
```

Send SES email tags for easier event correlation and debugging:

```txt
mailing_id
 delivery_id
purpose
```

Primary event mapping should still use:

```txt
SES mail.messageId -> deliveries.ses_message_id
```

### Configuration Set Event Destinations

Configure SNS event destinations for the configuration sets.

Events to support early:

- Bounce
- Complaint
- Delivery
- Send
- Reject
- Rendering Failure
- DeliveryDelay
- Subscription if SES list management is ever used

Open/click tracking can be added later only if explicitly desired.

## SES Suppression Settings

SES has its own account-level suppression list and configuration set-level suppression overrides.

Important researched behavior:

- SES account-level suppression can apply to bounces and complaints.
- Newer SES accounts may use account-level suppression by default for both bounces and complaints.
- SES accepts messages to account-suppressed addresses but does not send them when suppression reasons match.
- Messages to account-suppressed addresses still count toward daily sending quota.
- Only hard bounces are added to the account-level suppression list for bounce suppression.
- Configuration sets can override account-level suppression behavior.
- Config-set suppression is not a separate list; it changes which reasons apply when using that config set.

### Recommended Nusend Position

Nusend's own database suppressions should be the application source of truth.

Use SES configuration sets primarily for event publishing.

Be cautious with SES-managed suppression because account-level complaint suppression can interfere with transactional email if not configured carefully.

Possible SES setup:

```txt
marketing config set:
  suppression: bounce + complaint is acceptable

transactional config set:
  suppression: bounce only, or carefully override complaint-based suppression
```

Rationale:

- A hard bounce means the address is probably undeliverable.
- A complaint should stop marketing.
- A complaint should not automatically block password resets, login codes, receipts, or other account-critical transactional email.

Exact SES suppression setup should be documented clearly for operators because SES account defaults may differ by account age/configuration.

## SES ListManagementOptions

Do not use SES-managed ListManagementOptions initially.

Reasons:

- Nusend has its own contacts/lists/unsubscribe model.
- SES ListManagementOptions makes SES manage unsubscribe preferences.
- It requires the `{{amazonSESUnsubscribeUrl}}` placeholder.
- SES overrides existing `List-Unsubscribe` headers when used.
- SES only adds list-unsubscribe/footer behavior for single-recipient sends.

Instead:

- implement Nusend's own unsubscribe page
- generate Nusend unsubscribe URLs
- add appropriate `List-Unsubscribe` / `List-Unsubscribe-Post` headers for marketing mail
- process unsubscribe actions into Nusend suppressions/list memberships
- use SES configuration sets for feedback events

## SES Event Handling

Use SES configuration sets and SNS HTTPS webhook delivery.

Conceptual schema:

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

No `recipient_email` column is needed if `delivery_id` maps successfully. Raw JSON preserves event details.

Webhook flow:

```txt
receive SNS request
  -> verify SNS signature
  -> validate expected TopicArn
  -> handle SubscriptionConfirmation
  -> store raw ses_event
  -> idempotently process event
  -> map ses_message_id to delivery
  -> update delivery status
  -> update suppressions for bounces/complaints/unsubscribes
```

SNS signature verification is required.

Event processing must be idempotent because SNS may retry deliveries.

### SES Event Details to Consider

SES event payloads include:

- `eventType`
- `mail.messageId`
- `mail.tags`
- `bounce.bounceType`
- `bounce.bounceSubType`
- `bounce.bouncedRecipients`
- `complaint.complainedRecipients`
- `delivery.recipients`

Complaint caveat: many ISPs redact the actual complainant. SES may include all same-domain recipients for the complained message. Since Nusend sends one delivery per recipient, mapping by SES message ID should remain precise.

## Cloudflare R2 Assets

Cloudflare R2 will store public email assets such as images.

Recommendations:

- use a custom domain for production assets
- avoid relying on `r2.dev` for production
- final email image URLs should be absolute HTTPS URLs
- no local or relative image URLs should remain in final email HTML
- asset upload/management can be exposed via API/CLI

R2 asset URLs should be resolved before the final HTML is stored on a mailing.

## API and Future Clients

Current interface:

- Hono HTTP API

Future client tooling can include a Bun-powered CLI or typed SDK after the HTTP API is stable. Any future CLI should call the public HTTP API and must not import service internals such as DB, queue, or SES modules.

Agent-friendly API traits:

- predictable REST resources
- JSON request/response bodies
- machine-readable errors
- idempotency keys for create/send operations before real delivery
- dry-run/preview endpoints later
- health endpoint
- OpenAPI later

Current API area:

- protected mailing creation

Potential future API areas:

- deliveries
- templates
- contacts
- lists
- suppressions
- assets
- queue inspection/admin
- SES webhooks
- unsubscribe

## pnpm Monorepo Structure

Keep the monorepo lean. Current structure:

```txt
nusend/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md
  LICENSE
  PROJECT.md

  apps/
    service/
      package.json
      tsconfig.json
      src/
        main.ts
        app.ts
        config.ts
        auth/
        db/
        http/
        mailings/
        queue/
        services/
        testing/
```

No `packages/` folder initially. Add packages only when code is truly shared between real apps/consumers.

### API and Worker in One App

Do not split API and worker into separate workspace apps initially. They share too much: DB access, queue logic, delivery state transitions, suppression logic, SES integration, rendering logic, and config/env loading.

When the send worker is implemented, keep it in `apps/service` as another entrypoint rather than a separate app.

### Future CLI

A CLI is deferred. Add it only when there is a concrete distributable/client need. It should be a separate app then because it would have a `bin`, talk to the service over HTTP, and be installable independently.

### No Premature Shared Packages

Do not create these initially:

- `packages/core`
- `packages/db`
- `packages/queue`
- `packages/email`
- `packages/types`
- `packages/client`

Create `packages/client` only after there are at least two real consumers of shared client code, for example a future CLI plus SDK users or integration tests.

### Workspace Config

Minimal `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
```

### TypeScript Notes

Use strict TypeScript. Prefer stable HTTP/OpenAPI behavior first. Add a typed SDK/client package later only if needed.

## Initial Build Phases

### Phase 1: Repository and Service Foundation

Implemented/current:

- pnpm workspace
- `apps/service`
- Hono server
- config/env loading
- SQLite connection
- migrations
- health endpoint

Deferred:

- CLI, if/when a concrete client need exists

### Phase 2: Durable Queue

- jobs table
- queue claim/release/complete/fail/dead logic
- retries/backoff
- lease expiration

Deferred:

- worker process
- queue admin API/CLI

### Phase 3: Mailings and Transactional Sending

- `mailings`
- `deliveries`
- ad-hoc transactional mailing creation

Deferred before real sending:

- SES send integration
- send attempts
- delivery status updates
- idempotency keys

### Phase 4: Templates and Variable Rendering

- reusable templates
- copy template content into mailings
- safe variable rendering
- preview/dry-run endpoint
- optional mdtoemail API integration for convenience, without storing Markdown source

### Phase 5: Contacts, Lists, and Marketing Mailings

- contacts
- lists
- list memberships
- marketing mailing creation/scheduling
- snapshot list contacts into deliveries

### Phase 6: Suppression and Unsubscribe

- suppression table
- marketing suppression checks
- signed unsubscribe links
- public unsubscribe page
- list/marketing unsubscribe behavior

### Phase 7: SES Configuration Sets and Events

- SES configuration set docs/setup
- SNS webhook
- signature verification
- subscription confirmation
- event storage
- bounce/complaint/delivery/reject/delay processing
- automatic suppression updates

### Phase 8: R2 Assets

- asset upload API/CLI (future)
- R2 storage
- public custom-domain URLs
- final HTML asset URL validation/integration

### Phase 9: Agent-Friendly Polish

- structured errors
- idempotency keys
- dry-run endpoints
- JSON CLI output (future, if CLI is added)
- OpenAPI generation
- deployment docs
- systemd/Docker guidance

## Key Safety Principles

- Do not send marketing emails without unsubscribe support.
- Do not make transactional email impossible because of a marketing unsubscribe or complaint.
- Treat permanent hard bounces as likely all-mail undeliverability.
- Do not blindly retry ambiguous SES failures without considering duplicate-send risk.
- Store SES events raw before processing.
- Verify SNS signatures.
- Use SES configuration sets for event publishing.
- Be cautious with SES account/config-set suppression settings, especially for complaints.
- Keep queue jobs small and referential.
- Use context-aware escaping for all rendered variables.
- Require HTTPS URLs for final email images.
- Treat complaint and bounce handling as core deliverability functionality, not optional analytics.

## Current Open Technical Questions

These should be resolved during implementation:

- exact template variable syntax and renderer
- whether text body is required or optional for MVP
- exact SES configuration set setup automation/docs
- exact SES suppression configuration recommendation for transactional vs marketing
- exact R2 public URL/custom-domain strategy
- whether to add a CLI and, if so, whether to use Hono RPC, generated OpenAPI client, or a hand-written HTTP client

Default lean choices:

- no CLI until there is a concrete need; use a hand-written HTTP client if added
- no shared workspace packages initially
- `mailings` + `deliveries` as the core model
- no stored Markdown source
- jobs table state as DLQ
- marketing campaigns represented as marketing mailings
- deliveries as campaign recipient snapshots
- Nusend-owned unsubscribe/suppression model
- SES configuration sets for event publishing
