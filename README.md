# Nusend

Nusend is a self-hostable, API-only email orchestration service built on AWS SES and Cloudflare (Workers, D1, Durable Objects).

See [`PROJECT.md`](./PROJECT.md) for the product direction, architecture, and roadmap.

## Current Scope

Implemented:

- API-key-authenticated `/api` boundary (`Authorization: Bearer nusend_...`)
- direct-recipient transactional mailings (`POST /api/mailings`, up to 100 recipients)
- suppression filtering and delivery/job creation in one atomic D1 batch
- mailing progress endpoint (`GET /api/mailings/:id`)
- D1 job queue (leases, retries with backoff, dead-letter, priorities)
- Dispatcher Durable Object processing `expand_mailing` jobs via alarms
- cron watchdog (every 5 minutes) that releases expired leases and pokes the dispatcher
- public route stubs (`/unsubscribe/:token`, `/webhooks/ses`) returning `501`

Not implemented yet (see roadmap in `PROJECT.md`): actual SES sending, unsubscribe handling, SNS webhook processing, templates/placeholders, contacts/lists CRUD API, CLI. Marketing mailing creation is rejected with `422 marketing_unsubscribe_not_available` until unsubscribe support exists.

## Setup

Requirements: Node.js, pnpm, a Cloudflare account (Workers Paid for Durable Objects).

```sh
pnpm install
```

Create the D1 database and wire it up:

```sh
pnpm exec wrangler d1 create nusend
# copy the printed database_id into wrangler.jsonc
```

Apply migrations:

```sh
pnpm db:migrate:local    # local dev database
pnpm db:migrate:remote   # production database
```

## API Keys

Generate a key (printed once) plus the insert commands:

```sh
pnpm key:create my-key-name
```

Run the printed `wrangler d1 execute` command (`--local` and/or `--remote`) to register the key hash.

## Local Development

```sh
pnpm dev
```

```sh
curl http://localhost:8787/health

curl -i http://localhost:8787/api/mailings \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer nusend_...' \
  --data '{
    "purpose": "transactional",
    "subject": "Reset your password",
    "html": "<p>Reset your password</p>",
    "text": "Reset your password",
    "recipients": [{ "email": "user@example.com", "vars": { "firstName": "Max" } }]
  }'
```

Success response (`201`):

```json
{
  "counts": { "deliveries": 1, "queued": 1, "suppressed": 0 },
  "mailing": {
    "id": "...",
    "purpose": "transactional",
    "scheduledAt": "2026-07-06T12:00:00.000Z",
    "state": "scheduled"
  }
}
```

Use exactly one recipient source: `recipients` or `listId`. Transactional mailings must use `recipients`. A request that resolves to no sendable recipients returns `422 empty_recipient_set`. Suppressed recipients still get `deliveries` rows, so `counts.deliveries = counts.queued + counts.suppressed`. `scope=all` suppressions block all mail; marketing/list suppressions only block marketing mail.

Check progress:

```sh
curl http://localhost:8787/api/mailings/<id> -H 'authorization: Bearer nusend_...'
```

Send jobs stay `queued` for now — the SES sender is a later phase.

## Checks and Tests

Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`, with D1 migrations applied in test setup.

```sh
pnpm format
pnpm lint
pnpm typecheck   # runs `wrangler types` first
pnpm test
pnpm check       # all of the above
```

## Deploy

```sh
pnpm db:migrate:remote
pnpm deploy
```
