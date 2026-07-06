# Nusend Project Summary

## What We Are Building

Nusend is a self-hostable, open-source (MIT) API-only email orchestration service built on AWS SES and Cloudflare.

It is not a Mailchimp clone. It is a lean, API-first SES orchestration layer for developers and agents that supports:

- transactional email
- marketing email / campaigns (once unsubscribe support exists)
- scheduled sending
- durable queueing with retries and dead-letter states
- bounce, complaint, and delivery handling from SES events
- contacts, lists, suppressions, and unsubscribe handling
- final HTML email sending, with HTML generation handled externally (for example by `mdtoemail`)

There is no admin web UI in v1. A CLI is future work and must be a thin wrapper over the HTTP API.

## Deployment Model

Single deployment = single tenant. Each user deploys Nusend into:

- their own Cloudflare account (Workers Paid plan expected, for Durable Objects)
- their own AWS account for SES

There are no organizations, workspaces, teams, or user sessions.

## Core Stack

- TypeScript
- Cloudflare Workers (`fetch` + `scheduled` handlers)
- Hono
- Cloudflare D1 (SQLite) as the durable source of truth
- Cloudflare Durable Objects (single global `Dispatcher`)
- Wrangler-managed D1 migrations in `migrations/`
- AWS SES v2 via signed HTTPS requests (`aws4fetch` planned; no AWS SDK bundle)
- Vitest with `@cloudflare/vitest-pool-workers`
- MIT license

## Authentication

API keys only:

- server-generated, high-entropy, prefixed `nusend_`
- sent as `Authorization: Bearer nusend_...`
- stored as SHA-256 hashes (fast hashing is correct for high-entropy secrets; slow password hashing only protects low-entropy input)
- multiple named keys may exist; no scopes or roles in v1
- keys are created with `pnpm key:create` and inserted via `wrangler d1 execute`; there is no admin endpoint

Public unauthenticated route families:

- `GET|POST /unsubscribe/:token`
- `POST /webhooks/ses`
- `GET /health`

Everything under `/api/*` requires an API key.

## Core Data Model

```txt
mailings   = immutable content snapshot + sending context
deliveries = one recipient's delivery state
```

- a transactional email is one `mailing` with one or few `deliveries`
- a campaign is one marketing `mailing` with many `deliveries`
- content is stored once per mailing, not per recipient
- `deliveries.vars_json` holds per-recipient personalization data
- `deliveries(mailing_id, email)` is unique: the durable defense against duplicate sends from at-least-once processing

Supporting tables:

- `contacts`, `lists`, `list_memberships`
- `suppressions` (scopes: `all` | `marketing` | `list`)
- `jobs` (the D1 queue)
- `send_attempts` (per-send audit/safety trail)
- `ses_events` (raw SES/SNS events, processed idempotently)
- `api_keys`

Workflow state/kind columns (`mailings.state`, `deliveries.status`, `jobs.kind`, `jobs.state`) are intentionally not CHECK-constrained — SQLite/D1 cannot alter CHECKs without table rebuilds — and are validated in TypeScript instead. Stable structural checks (for example `mailings.purpose`, suppression scope consistency) stay in SQL.

## Sending Pipeline

One downstream pipeline based on `deliveries` + `send_delivery` jobs.

### Direct recipients (transactional)

```txt
POST /api/mailings { recipients: [...] }
  -> validate (max 100 recipients)
  -> resolve optional contact ids
  -> apply suppression filter
  -> one D1 batch: mailing + deliveries + send_delivery jobs
  -> poke Dispatcher DO
  -> 201 with counts
```

Callers needing thousands of recipients must use contacts/lists and the campaign flow.

### List/campaign recipients

```txt
POST /api/mailings { listId: "..." }
  -> one D1 batch: mailing + expand_mailing job
  -> poke Dispatcher DO
  -> 202 with mailing id (expansion runs in the background)
```

`expand_mailing` snapshots list recipients into deliveries in chunks:

- reads list members by contact-id cursor (`jobs.payload_json` holds `{ afterContactId }`)
- the audience is pinned to mailing creation time (`subscribed_at <= mailings.created_at`); members who unsubscribe before their chunk is processed are dropped
- applies suppressions per chunk
- one `env.DB.batch()` per chunk: delivery inserts + send-job inserts + the next cursor job
- delivery inserts use `INSERT OR IGNORE` against the unique `(mailing_id, email)` index
- send jobs derive deterministic ids (`send_delivery:<deliveryId>`) from surviving delivery rows, so retried chunks never duplicate jobs
- creates `send_delivery` jobs only; it never sends

`GET /api/mailings/:id` exposes expansion/delivery progress as counts.

### Marketing guard

Marketing mailing creation is rejected with `422 marketing_unsubscribe_not_available` until real unsubscribe support exists. Remove the guard only when the unsubscribe route is implemented.

### Mailing states

Mailings start as `scheduled` and stay `scheduled` until an actual sender starts processing deliveries (`sending`, then `completed`). The SES sender does not exist yet, so `send_delivery` jobs remain queued.

## Queue Design

D1 is the queue's source of truth:

```sql
jobs(id, kind, state, priority, payload_json, run_at, attempts, max_attempts,
     locked_by, locked_until, ref_id, last_error, created_at, updated_at)
```

- kinds are flexible strings validated in TypeScript: `expand_mailing`, `send_delivery`, `process_ses_event`, `finalize_mailing`, ...
- atomic claims via `UPDATE ... RETURNING` with lease expiry
- retry with capped exponential backoff; `state = dead` is the dead-letter queue
- claim order: `priority DESC, run_at ASC, created_at ASC, id ASC`
- transactional send jobs get priority 10, campaign work 0, so campaigns never block password resets
- claims always filter by an explicit registered-kind list; an empty list claims nothing

## Dispatcher Durable Object

A single global `Dispatcher` Durable Object (`idFromName("dispatcher")`) drives background work:

- `poke()` arms an alarm when queued registered-kind work exists
- `alarm()` runs one bounded queue slice (claim → process → complete/fail), then re-arms if work remains
- alarms are at-least-once; processors must be idempotent (leases + `INSERT OR IGNORE` + unique indexes)
- all durable state lives in D1, not in DO storage

Registered processors today: `expand_mailing` only. `send_delivery` must not be registered until a real SES sender exists — queued emails must never be marked processed without sending.

The Worker cron trigger (`*/5 * * * *`) is a watchdog/janitor, not the send loop: it releases expired leases and pokes the dispatcher if registered work is queued.

### Future SES sender

The dispatcher will later host the global SES rate limiter (token bucket), because the SES send rate is account/region-global and needs a single serialization point (this is why Cloudflare Queues are not used):

- register a `send_delivery` processor
- send via SES v2 signed HTTPS (`aws4fetch`), one delivery per send
- write `send_attempts`, update `deliveries`, retry/dead-letter through the D1 queue
- use SES configuration sets (`nusend-transactional` / `nusend-marketing`) for event publishing

## Templates and Content

Nusend stores final content only:

- `mailings.subject/html/text` plus `deliveries.vars_json` already represent a template instantiation
- Markdown source is never stored; `mdtoemail` (or any generator) stays external
- there is no stored-templates table yet; a future template API is copy-on-create convenience over immutable mailings

Planned placeholder contract (not implemented yet):

- syntax: `{{ path.to.value }}`
- values resolved from `deliveries.vars_json`
- HTML-escaped by default
- no loops, conditionals, or expressions in v1
- a missing variable fails the delivery terminally

## Public Routes (contracts)

Currently `501 not_implemented` stubs. Planned behavior:

- unsubscribe: verify signed token, update suppressions and/or list membership, required before any marketing send
- SES webhook: verify SNS signature and expected TopicArn, store the raw event in `ses_events`, process bounce/complaint/delivery idempotently, map `ses_message_id` to deliveries, update suppressions

Suppression policy:

- hard bounce → `scope=all`
- marketing unsubscribe → `scope=list` or `scope=marketing`
- complaint → `scope=marketing` (never automatically `scope=all`; transactional email like password resets must remain possible)

## D1 Constraints That Shape the Design

- statements are async and use positional parameters
- `env.DB.batch()` is the only multi-statement transaction; chunk work must fit in one batch
- 100 bound parameters per statement (multi-row inserts and `IN (...)` lookups are chunked)
- bounded work per invocation; the dispatcher processes slices and re-arms

## Roadmap

1. Cloudflare foundation (done): Worker + D1 schema + API keys + queue + dispatcher + expand_mailing + direct transactional creation
2. SES sender with Dispatcher rate limiter
3. Unsubscribe implementation (signed tokens, public page), then remove the marketing guard
4. SNS webhook verification and event processing
5. Contacts/lists/campaign API expansion
6. Templates API and placeholder rendering
7. CLI wrapper over the HTTP API

## Key Safety Principles

- Do not send marketing email without unsubscribe support.
- Do not make transactional email impossible because of a marketing unsubscribe or complaint.
- Never register/claim `send_delivery` without a real sender.
- Assume at-least-once processing everywhere; rely on leases, deterministic ids, and unique indexes.
- Store SES events raw before processing; verify SNS signatures.
- Keep queue jobs small and referential (`kind` + `ref_id` + small payload).
