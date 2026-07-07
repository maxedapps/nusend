# Nusend Cloudflare Conventions

## Table of contents
- [Files](#files)
- [Commands](#commands)
- [D1 state](#d1-state)
- [Worker and Durable Object runtime](#worker-and-durable-object-runtime)
- [Testing](#testing)
- [Security and logging](#security-and-logging)
- [Known pitfalls](#known-pitfalls)

## Files

Nusend is currently a single Worker package at the repository root.

- Worker/config:
  - `wrangler.jsonc`
  - `worker-configuration.d.ts`
  - `src/index.ts`
  - `src/app.ts`
  - `src/bindings.ts`
- Durable Object dispatcher:
  - `src/dispatch/dispatcher.ts`
  - `src/dispatch/processors.ts`
- D1 queue and migrations:
  - `migrations/0001_init.sql`
  - `src/queue/jobs.ts`
  - `src/queue/runner.ts`
  - `src/queue/backoff.ts`
  - `src/queue/time.ts`
- Mailings/domain routes:
  - `src/mailings/routes.ts`
  - `src/mailings/create-mailing.ts`
  - `src/mailings/expand-mailing.ts`
  - `src/mailings/pipeline.ts`
  - `src/mailings/suppressions.ts`
  - `src/mailings/validation.ts`
- Auth and public stubs:
  - `src/auth/api-keys.ts`
  - `src/public-routes/unsubscribe.ts`
  - `src/public-routes/ses-webhook.ts`
- Tests/helpers:
  - `vitest.config.ts`
  - `test/apply-migrations.ts`
  - `test/helpers.ts`
  - `src/**/*.test.ts`

## Commands

From repo root:

- Dev Worker: `pnpm dev`
- Deploy Worker: `pnpm deploy`
- Generate Worker types: `pnpm cf-typegen`
- Local D1 migrations: `pnpm db:migrate:local`
- Remote D1 migrations: `pnpm db:migrate:remote` only when production/remote DB work is explicitly intended and `wrangler.jsonc` has a real database id.
- Create API key SQL/commands: `pnpm key:create [name]`
- Typecheck: `pnpm typecheck` (runs `wrangler types && tsc --noEmit`)
- Tests: `pnpm test`
- Full validation: `pnpm check`

## D1 state

- `wrangler.jsonc` defines one D1 binding: `DB` for database `nusend`; the checked-in `database_id` is a placeholder.
- Migrations live in root `migrations/` and are used by Wrangler and Worker tests.
- Use the package scripts for D1 operations. Do not accidentally run remote D1 commands while the placeholder database id remains in config.
- Application queries should use `prepare().bind()` and `env.DB.batch()` for atomic multi-statement writes. Avoid `exec()` in app code.
- Preserve D1 limits encoded in `src/lib/d1-batch.ts`: max 100 bound params and chunked `IN (...)` lookups.

## Worker and Durable Object runtime

- `src/index.ts` exports module Worker handlers and re-exports `Dispatcher`.
- `fetch` is served by Hono via `createApp().fetch`.
- `scheduled` is a cron watchdog: it releases expired leases and pokes the dispatcher; it must not process jobs directly.
- `Dispatcher` is a single global Durable Object selected by `idFromName("dispatcher")`.
- `Dispatcher` alarms process only registered job kinds from `src/dispatch/processors.ts`; do not register `send_delivery` until the real SES sender exists.
- Use `ctx.waitUntil()` for background work that must continue after an HTTP response, and catch/log sanitized errors for detached work.

## Testing

- Tests use `@cloudflare/vitest-pool-workers` via `cloudflareTest` in `vitest.config.ts`; keep that as the source of truth for API shape.
- D1 migrations are applied in `test/apply-migrations.ts` and tables are cleared before each test.
- Prefer Worker-runtime tests for code using D1, Durable Objects, alarms, Web Crypto, Worker globals, or `waitUntil`.
- Durable Object alarm tests use `cloudflare:test` helpers such as `runDurableObjectAlarm`.

## Security and logging

- API keys are bearer tokens with prefix `nusend_`; only SHA-256 hashes are stored in D1.
- `scripts/create-api-key.ts` prints plaintext keys exactly once plus local/remote `wrangler d1 execute` commands.
- Do not log bearer tokens, API-key hashes, raw webhook payloads, SES/SNS secrets, unsubscribe tokens, or recipient PII.
- Public unauthenticated routes are only `GET|POST /unsubscribe/:token`, `POST /webhooks/ses`, and `GET /health` per `PROJECT.md`.
- `observability` is enabled in `wrangler.jsonc`; assume Worker logs and invocation metadata persist.

## Known pitfalls

- Marketing send creation is intentionally blocked until unsubscribe support exists; do not remove this guard before implementing/validating unsubscribe.
- The D1 queue is the durable source of truth. Preserve at-least-once invariants: leases, deterministic job ids, unique indexes, `INSERT OR IGNORE`, and registered-kind filtering.
- `send_delivery` jobs are created but intentionally not processed until a real SES sender exists.
- D1 workflow-state strings are deliberately validated in TypeScript, not SQL CHECK constraints, because SQLite/D1 cannot alter CHECKs without table rebuilds.
- Cron is a watchdog/janitor, not the send loop. The Durable Object alarm loop drives bounded registered work.
- The root `apps/service/` directory is currently empty; do not infer a multi-package app layout from it.
