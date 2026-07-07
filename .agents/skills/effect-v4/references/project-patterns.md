# Nusend Effect Patterns

## Table of contents
- [Where to start](#where-to-start)
- [Current code shape](#current-code-shape)
- [Best Effect targets](#best-effect-targets)
- [Boundary conventions](#boundary-conventions)
- [Services to introduce](#services-to-introduce)
- [Schema and errors](#schema-and-errors)
- [Queue, retries, and time](#queue-retries-and-time)
- [Commands](#commands)

## Where to start

Nusend is a single Cloudflare Worker + Durable Object service. Start with:

- `src/index.ts` for Worker `fetch` and `scheduled` boundaries.
- `src/app.ts` for Hono route registration and top-level error mapping.
- `src/dispatch/dispatcher.ts` and `src/dispatch/processors.ts` for Durable Object alarm processing.
- `src/queue/jobs.ts` and `src/queue/runner.ts` for D1 queue transitions.
- `src/mailings/routes.ts`, `src/mailings/create-mailing.ts`, and `src/mailings/expand-mailing.ts` for current business workflows.
- `src/mailings/validation.ts` for current manual request validation that should become Effect Schema when migrating.
- `src/auth/api-keys.ts` and `scripts/create-api-key.ts` for crypto/API-key boundaries.

## Current code shape

- The repo currently has no `effect` dependency. Check `package.json` before using examples and install an explicit v4 beta when implementation starts.
- Current implementation is promise-first with explicit `db: D1Database`, `now?: () => string`, and `createId?: () => string` parameters.
- Tests run in the Cloudflare Worker runtime through `@cloudflare/vitest-pool-workers`; preserve Worker-runtime tests for D1, Durable Objects, Web Crypto, alarms, and `waitUntil` behavior.
- D1 statements and `env.DB.batch()` semantics are central to correctness. Keep transaction boundaries and idempotent `INSERT OR IGNORE` patterns intact.

## Best Effect targets

Use Effect where it materially improves typed dependencies, typed failures, validation, retries, or runtime boundaries:

1. HTTP/public boundaries: JSON parsing, request schemas, response error mapping in `src/mailings/routes.ts`, future unsubscribe, and SES webhook routes.
2. Queue/dispatcher workflows: `src/queue/runner.ts`, `src/dispatch/dispatcher.ts`, and job processors such as `src/mailings/expand-mailing.ts`.
3. Future SES sender: AWS signing/fetch, timeouts, retry policy, rate-limit interactions, send-attempt audit writes, and typed transient vs permanent errors.
4. Future SNS webhook processing: signature/cert verification, raw-event persistence, schema validation, idempotent processing, and suppression updates.
5. Config/secrets: SES credentials, region, SNS topic ARN, unsubscribe signing secret, and any future endpoint secrets should use lazy config and `Redacted`.

Keep tiny pure helpers as plain TypeScript unless converting their callers already makes Effect usage natural; examples include SQL placeholder builders and simple count aggregation.

## Boundary conventions

- Run Effects only at framework/platform edges: Hono handlers, Worker `scheduled`, Durable Object `poke`/`alarm`, scripts, and tests.
- Prefer a small runtime helper, e.g. `src/effect/runtime.ts`, that builds a `ManagedRuntime` from Worker bindings and exposes route/scheduled runners.
- Cache Worker runtimes by Cloudflare `env` object (`WeakMap<AppBindings, ManagedRuntime>`) so tests and different env objects do not share stale bindings.
- Durable Objects receive their own `this.env`; build/provide layers from that boundary rather than importing `env` globally.
- `waitUntil` work must catch/log sanitized causes; a failed dispatcher poke should not fail an already committed request.

## Services to introduce

Good first service boundaries:

- `Database`: wraps D1 `prepare`, `first`, `all`, `run`, and `batch` with typed `DatabaseError` failures.
- `Clock`/time: prefer Effect clock for workflows that calculate leases, alarms, schedules, and retry times; keep deterministic tests.
- `IdGenerator`: wraps `crypto.randomUUID()` and API-key random bytes for deterministic tests.
- `DispatcherClient`: wraps Durable Object lookup/poke so routes do not manually build stubs.
- `Logger`: structured, redacted logging for route/queue/DO failures.
- Future `SesClient`, `SnsVerifier`, `UnsubscribeTokenSigner`, and config services.

Keep service interfaces capability-focused. Do not expose broad Worker `env` to domain code.

## Schema and errors

- Replace manual unknown parsing in `src/mailings/validation.ts` with `Schema` once Effect is installed. Preserve existing normalization behavior and tests.
- Validate serialized job payloads, especially `expand_mailing` payload JSON in `src/mailings/expand-mailing.ts`, with Schema instead of casts.
- Validate third-party data: SES API responses, SNS messages, SNS cert documents, and webhook bodies.
- Model expected failures as tagged typed errors: invalid request, unauthorized, not found, empty recipient set, stale lease, database failure, invalid job payload, signature verification failure, token invalid/expired, SES transient/permanent failures.
- HTTP mapping should live near route boundaries; do not leak D1 internals, secrets, bearer tokens, raw webhook payloads, or recipient PII in logs/responses.

## Queue, retries, and time

- The durable D1 queue already implements persistent retry/backoff through `jobs.run_at`; do not replace durable queue retries with in-memory Effect retries.
- Use `Effect.retry`/`Schedule` inside a single job only for bounded transient external calls, especially SES HTTPS sends and SNS certificate fetches.
- Preserve at-least-once/idempotency invariants: deterministic job ids, `INSERT OR IGNORE`, unique indexes, leases, and registered-kind filtering.
- Use Effect time/TestClock where tests would otherwise need real sleeps or manual `now` plumbing.

## Commands

From repo root:

- Install latest v4 beta intentionally, e.g. `pnpm add effect@4.0.0-beta.<latest>` after checking `pnpm view effect versions --json`.
- Typecheck: `pnpm typecheck` (runs `wrangler types` first).
- Tests: `pnpm test`.
- Full validation: `pnpm check`.
- Cloudflare type generation only: `pnpm cf-typegen`.
