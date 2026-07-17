# Nusend Effect Patterns

## Table of contents

- [Where to start](#where-to-start)
- [Current code shape](#current-code-shape)
- [Services and layers](#services-and-layers)
- [Runtime boundaries](#runtime-boundaries)
- [Transactions and time](#transactions-and-time)
- [Schema and errors](#schema-and-errors)
- [Queue and retries](#queue-and-retries)
- [Testing](#testing)
- [Conformance rules](#conformance-rules)
- [Commands](#commands)

## Where to start

Nusend is a Bun + Hono service (`apps/service`) targeting a self-hosted VPS,
built on Effect v4 (exact-pinned beta). Start with:

- `src/main.ts` — the composition boundary: config read, layer stack, `ManagedRuntime.make`, `Bun.serve`, signal-driven `dispose()`.
- `src/services/database.ts` — the driver-agnostic `Database` service (interface + key + shared `makeTransaction`); `src/services/database-bun.ts` is the production layer (bun:sqlite, also provides the raw `SqliteHandle` for Better Auth).
- `src/services/auth.ts` (key/types) + `src/services/auth-live.ts` (Better Auth layer — an approved `Redacted.value` site).
- `src/unsubscribe/token.ts` is also an approved `Redacted.value` boundary: it unwraps unsubscribe HMAC secrets only at the Node `crypto.createHmac` call site.
- `src/http/respond.ts` — the error envelope, the one exhaustive `catchTags` → status/code table, and `runRoute`.
- `src/config.ts` — Effect `Config` definitions (empty-as-missing semantics, all-or-nothing auth group, `Redacted` secrets).
- `src/queue/jobs.ts` + `src/queue/runner.ts` — durable queue transitions and the poll-cycle runner.
- `src/testing/layers.ts` — in-process test layers (`DatabaseNodeLive` over node:sqlite, `TestClock`, fake auth, test runtimes).

## Current code shape

- Effect v4 beta is a runtime dependency of `@nusend/service`, pinned exactly. Re-run API probes before bumping the pin (beta churn).
- Services use `Context.Service<Shape>("nusend/Name")`; layers via curried `Layer.succeed(Key)(impl)`, `Layer.effect`, and `Layer.effectContext` (multi-key: `Database` + `SqliteHandle` from one acquisition).
- Business logic is Effect programs; Hono and Better Auth are boundary libraries (thin shells around programs). `src/auth/permissions.ts` and `src/queue/backoff.ts` stay pure TypeScript on purpose.
- SQLite access is synchronous on both drivers; DB calls are wrapped in `Effect.try` with tagged `DatabaseError { operation, cause }` (operation labels only — never SQL params).

## Services and layers

- `Database` (`nusend/Database`): `run/get/all/exec/ping/transaction`. `exec` is for multi-statement SQL (migration files) only; everything else stays single-statement prepared. Drivers: `DatabaseBunLive(path)` (production, WAL + pragmas, acquireRelease close-on-dispose) and `DatabaseNodeLive(path)` (tests, node:sqlite, applies real migration files).
- `SqliteHandle` (`nusend/SqliteHandle`): the raw bun:sqlite handle, provided by `DatabaseBunLive`, consumed only by `AuthLive`.
- `Auth` (`nusend/Auth`): `handler` (raw `/api/auth/*` passthrough), `getSession`, `verifyApiKey`. Live layer builds `betterAuth()`; tests use `FakeAuthLive`.
- `IdGenerator` (`nusend/IdGenerator`): must stay synchronous/non-suspending — ids are generated inside write transactions.
- `main.ts` wiring: reuse the same `dbLayer` reference in `Layer.mergeAll(dbLayer, IdGeneratorLive, AuthLive(cfg).pipe(Layer.provide(dbLayer)))` — memoization guarantees one connection.

## Runtime boundaries

`Effect.run*` is allowed only at: `main.ts`, `http/respond.ts` (`runRoute`), `auth/middleware.ts` (`requirePrincipal`), `db/migrate.ts`, `auth/bootstrap.ts`, `src/testing/`, and test files. Everything else composes Effects.

- CLIs (`db/migrate.ts`, `auth/bootstrap.ts`) build a `ManagedRuntime`, run with `runPromiseExit`, map tagged failures to `console.error` + exit code, pretty-print defects, and dispose in `finally`.
- Route handlers build a program and hand it to `runRoute(context, runtime, program, onSuccess)`; the compiler proves the program's error union is a subset of the handled `RouteError` union.
- `requirePrincipal` maps auth failures (401/403 with frozen messages) itself; infra errors and defects → sanitized 500.

## Transactions and time

- `Database.transaction(work)` = `BEGIN IMMEDIATE` → work → `COMMIT`, rollback on every non-success exit (typed failure, defect, interruption), armed only after BEGIN succeeds. Work inside a transaction must be DB-only (plus sync Clock/IdGenerator reads) — a suspended fiber would hold SQLite's write lock.
- Never construct `Date`s outside `src/lib/iso-time.ts`. "Now" comes from `Clock` (`currentIso`); ISO math via `addSecondsIso`; lenient user-supplied dates via `parseLenientDateToIso`.
- The queue runner takes ONE clock snapshot for release + claim (`claimJobsAt`/`releaseExpiredLeasesAt`), then reads fresh time per complete/fail — pinned by a stepping-clock test.

## Schema and errors

- Trust boundaries decode with Schema: `src/mailings/schema.ts` (HTTP request; raw-input presence checks BEFORE decode — `Object.hasOwn` semantics), `src/queue/schema.ts` (row shapes; decode failure = defect because SQLite CHECK-constrains the columns).
- Transforms: `Schema.decodeTo` + `SchemaGetter.transform` (trim, lowercase, vars→JSON string); custom checks via `Schema.makeFilter` (custom messages); aggregate field issues with `{ errors: "all" }`; asymmetric transforms use `SchemaGetter.forbidden` for encode.
- Tagged errors live in `src/errors.ts` (`Data.TaggedError`). HTTP mapping is centralized in `http/respond.ts`; `EmptyRecipientSetError.reason` and auth middleware messages are frozen API contract — do not reword.
- Config failures use `Config.fail(new ConfigProvider.SourceError({ message }))` (plain strings do not typecheck in the beta).

## Queue and retries

- Durable per-job retry/backoff lives in SQL (`run_at` CASE ladder in `jobs.ts`) — never convert it to `Effect.retry`/`Schedule`. `Schedule` is reserved for the future in-process worker poll loop and SES calls.
- The runner's stale-lease handling is nested on purpose: `completeJob`/`failJob`'s own `JobNotLeasedError` is caught inside its branch and counted `skippedStale` — a flat catch chain mis-routes it.
- Processor failures (typed or defect, via `Cause.squash`) route to `failJob`; infrastructure `DatabaseError` propagates out of `runOnce`.

## Testing

- Default: in-process vitest on `runTest`/`testLayer` (node:sqlite `:memory:`, migrations applied, FK on; `TestClock.layer()`; sequential ids). Multi-instant scenarios are ONE program with `TestClock.setTime` between steps — each `runTest` builds a fresh database.
- `withTestApp`/`makeTestRuntime` wire the real Hono app to an in-process runtime with `FakeAuthLive` for route/middleware tests.
- Options: `{ migrate: false }` (unmigrated DB), `{ ids: [...] }` (fixed id list, e.g. forced collisions), `{ clock: steppingClockLayer([...]) }` (pin clock-read cadence).
- Bun subprocess scenarios (`testing/bun-scenario.ts`) are retained ONLY for: the Better Auth integration test, the migrate CLI integration test, the driver-parity smoke (`db/driver-parity.test.ts` — identical snapshots on both drivers), the `main.ts` boot smoke, and the bun side of the database contract. Bun-side fixtures live in `testing/bun-fixtures.ts`.

## Conformance rules

Grep-enforced:

- `bun:sqlite` imports: `services/database-bun.ts`, `services/auth-live.ts`, `auth/auth.ts`, `testing/bun-fixtures.ts` only. `node:sqlite`: `testing/layers.ts` only.
- No `new Date(`/`Date.now(` outside `lib/iso-time.ts`; use `Schema.fromJsonString` for new trust-boundary JSON decoding; no `as any`/ts-suppressions; `Redacted.value` only in approved external-boundary sites (`services/auth-live.ts`, `unsubscribe/token.ts`) and tests.
- `throw new` only for invariant defects and CLI usage errors (see gate table) — expected failures are tagged errors.
- Logging uses Effect's logger layer (`observability/effect-logger.ts`) plus sanitized `logCause` in `http/respond.ts`; do not introduce a bespoke logger service speculatively. When adding request/operations logs, log route patterns or redacted paths (for example `/unsubscribe/:token`), never raw token-bearing URLs, request bodies, API keys, auth headers, cookies, raw SNS JSON, or email payloads.

## Commands

```sh
pnpm check                                   # format:check + lint + typecheck + vitest
pnpm --filter @nusend/service db:migrate     # bun src/db/migrate.ts up
pnpm --filter @nusend/service auth:bootstrap # owner bootstrap CLI
pnpm --filter @nusend/service dev            # bun --hot src/main.ts
```
