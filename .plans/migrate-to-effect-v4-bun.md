# Migrate Nusend (Bun/VPS) to Effect v4 — Ground-Up Architecture

**Date:** 2026-07-07
**Status:** Independently reviewed (Claude Opus 4.8, high effort — verdict "strong plan, not yet executable as written"; all 11 findings incorporated, the two prescribed fixes probe-verified), ready for implementation
**Supersedes:** `.plans/migrate-to-effect-v4.md` (written for the reverted Cloudflare Workers codebase; deleted along with its `.html` when this plan was saved)
**Goal:** Re-express `apps/service` in Effect v4 (beta) so the final codebase reads as if built with Effect from day one — services/layers, Schema at every trust boundary, Effect `Config`/`Redacted`, tagged errors, a `ManagedRuntime` with a real disposal lifecycle — with **zero legacy patterns, fallbacks, or compatibility shims remaining**, and with the driver-agnostic `Database` service dissolving most of the bun-subprocess test machinery.

---

## 1. Summary

Nusend is now a pnpm monorepo targeting a self-hosted VPS: `apps/service` (Bun + Hono + `bun:sqlite` + Better Auth, ~2,000 LOC) and `apps/cli` (empty stub). The service has env-based config with real secrets, Google-only Better Auth with organizations and permission-scoped API keys, a hand-rolled SQLite migration runner, a synchronous lease-based job queue, and a transactional `createMailing`. Entry points: `src/main.ts` (Bun.serve + signal shutdown), `src/db/migrate.ts`, `src/auth/bootstrap.ts`. A `worker.ts` send loop is roadmapped but does not exist yet.

The migration runs in six phases (0–5), each ending with `pnpm check` fully green. The dependency graph is unusually clean (mailings and queue are independent; the queue has **no production callers yet**), so the Transitional Register is nearly empty. Phase 5 is a mechanical conformance sweep (grep-verified) proving nothing legacy survived — including the string-templated bun-scenario test scripts, which shrink to a small retained integration set.

## 2. Requirements, assumptions, and non-goals

### Confirmed requirements (from the user's request and prior ratified decisions)

- Final codebase must look ground-up Effect: no `ValidationResult`, no thrown `CreateMailingError`-style classes, no `src/queue/time.ts`, no `now?:`/`createId?:` option-param injection, no hand-rolled env parsing in `config.ts`, no `Effect.runPromise` inside reusable code.
- **Driver-agnostic `Database` service**: `bun:sqlite` live layer for production, `node:sqlite` layer for vitest — explicitly requested, replacing the bun-scenario subprocess machinery for domain tests.
- **Hono stays** as a thin HTTP shell (ratified in the previous plan cycle; nothing in the pivot changes the reasoning).
- **Phased execution**, green after every phase (ratified previously).
- Public HTTP contract (status codes, `error.code` values, response shapes, normalization semantics) frozen; validation message prose may change. `jobs.last_error` format may change.
- Better Auth behavior frozen: Google-only, signup disabled, org-scoped API keys via `x-api-key`, permission statements/roles unchanged.

### Non-goals

- No SES sender, SNS webhook, unsubscribe, templates, contacts/lists CRUD, R2 assets, or CLI implementation — later roadmap phases (they will be Effect-native from birth on this foundation; the future `worker.ts` loop is *designed for* here but not built).
- No schema/migration changes to SQLite tables.
- No replacement of Better Auth — it is a boundary library (like Hono) that owns its tables and receives the raw `bun:sqlite` handle.

## 3. Research findings (all verified against the installed packages, not memory)

Probes were compiled and executed against `effect@4.0.0-beta.93` under **Bun 1.3.14** and **Node 26.1.0** (scratchpad `effect-probe/`: `probe.ts`, `bun-probe.ts`, `lifecycle-probe.ts`).

| Concern | Verified v4 API / fact |
|---|---|
| Service keys | `Context.Service<Shape>("nusend/Name")`; layers via curried `Layer.succeed(Key)(impl)` and `Layer.effect(Key, effect)` |
| **Resourceful layer + disposal** | `Layer.effect(Database, Effect.acquireRelease(open, close))` — finalizer runs **exactly on `ManagedRuntime.dispose()`**, not before (verified: DB opened once, closed by finalizer on dispose) |
| CLI exit mapping | `runtime.runPromiseExit(effect)` returns `Exit`; tagged failures inspectable via `Exit.isFailure` + cause (verified) |
| Sync SQLite ops | `Effect.try({ try, catch })` around synchronous `db.query(...).run/get/all` (verified under Bun) |
| **Interactive transactions** | `Database.transaction(work)` = `BEGIN IMMEDIATE` → work → `COMMIT`, with `Effect.tapError(→ ROLLBACK)` — typed-failure rollback verified (row count restored) |
| Config | `Config<T>` **extends `Effect<T, ConfigError>`** in v4 — yield configs directly. `Config.nonEmptyString`, `Config.map(Redacted.make)`, `Config.option`, `Config.all` verified. Providers: `ConfigProvider.fromEnv()` (production), `ConfigProvider.fromUnknown(record)` (test fixtures — verified), `ConfigProvider.fromDotEnv`/`fromDotEnvContents` (available for VPS deployments) |
| Redacted | `Redacted.make`/`Redacted.value`; displays as `<redacted>` (verified) |
| Errors | `Data.TaggedError`, `Effect.catchTag`/`catchTags` (exhaustive mapping compiles), `Effect.catchCause`/`tapCause` |
| Schema | `Schema.Struct`/`Literals`/`optional`/`Array`; transforms via `Schema.decodeTo` + **`SchemaGetter`** (separate top-level import); custom checks via `Schema.makeFilter` (custom messages, path-targeted issues); `Schema.decodeUnknownResult(..., { errors: "all" })` aggregates field issues (verified); `Schema.decodeUnknownEffect` fails with catchable `SchemaError` |
| Clock | `Clock.currentTimeMillis`; `Clock.Clock` is a `Context.Reference` overridable via `Layer.succeed(Clock.Clock)({...})` (fixed-clock layer verified) |
| **TestClock** | `import { TestClock } from "effect/testing"`; provide `TestClock.layer()`, then `yield* TestClock.setTime(millis)` between steps — subsequent `Clock.currentTimeMillis` reads follow (verified). This is how multi-instant queue scenarios advance time within one program over one shared DB |
| **Multi-key resourceful layer + memoization** | `Layer.effectContext(acquireRelease(...).pipe(Effect.map(db => Context.make(Database, …).pipe(Context.add(SqliteHandle, db)))))` provides two services from ONE acquisition; reusing the same layer reference in `Layer.mergeAll(dbLayer, XLive.pipe(Layer.provide(dbLayer)))` is memoized — verified exactly one acquisition and finalizer run |
| Schedule | `Effect.retry`/`Effect.repeat` + `Schedule` exist — used ONLY for the future in-process worker poll loop and SES calls; durable per-job retry stays in SQL |
| **node:sqlite parity** | Stable on Node 26. The exact statement style this codebase uses — `$`-prefixed named placeholders with **bare** object keys, and `UPDATE ... RETURNING` — works identically on `node:sqlite` (verified). Same SQL text runs on both drivers |
| Known beta wart | `effect`'s internal `.d.ts` needs `skipLibCheck` (already set in `tsconfig.base.json:12`) |

Environment facts:

- `effect` dist-tags at planning time: `beta: 4.0.0-beta.93`. Pin exactly, as a **runtime dependency of `apps/service`** (root stays tool-only). `pnpm-workspace.yaml` here has no release-age gates.
- `tsconfig.base.json` sets `types: ["bun"]`. Verify `import { DatabaseSync } from "node:sqlite"` typechecks in the service package (bun-types pulls in Node types transitively); if not, add `@types/node` to root devDependencies. Do this in Phase 0.
- **Config.option pitfall (discovered in probing):** wrapping the whole auth group in `Config.option(Config.all({...}))` returns `None` when *any* required var is missing — silently disabling auth on a *partially* configured deployment. Current `config.ts:61-63` deliberately distinguishes all-unset (auth off) from partially-set (hard error). The plan preserves that (§5.2).
- Housekeeping confirmed stale: root `worker-configuration.d.ts` (leftover from the reverted CF pivot — delete); `.agents/skills/effect-v4/references/project-patterns.md` (rewritten for the CF layout — rewrite again in Phase 5); the `cloudflare-workers` skill is dormant for the service (R2 may revive parts later — keep the folder, note dormancy).

## 4. Current state → target mapping

| Current file | Pattern today | Target |
|---|---|---|
| `src/main.ts` | sequential startup, `process.on(SIGINT/SIGTERM)` closing db + exit | boundary: config read → layer stack → `ManagedRuntime.make` → `Bun.serve(app.fetch)`; signals stop server then `await runtime.dispose()` (closes DB via layer finalizer) |
| `src/config.ts` (127 lines) | hand-rolled env parsing, throws `Error` | **deleted**; `src/config.ts` reborn as Effect `Config` definitions + `Redacted` secrets + `AuthConfig` optional group (§5.2) |
| `src/db/index.ts` | `openDatabase`/`closeDatabase`/`pingDatabase` + pragmas | absorbed into `services/database-bun.ts` (acquireRelease + pragmas); `pingDatabase` becomes `Database.ping: Effect<boolean>` |
| `src/db/migrate.ts` | top-level script, sync fns, throws | Effect CLI boundary: command programs with typed `MigrationError`, `runtime.runPromiseExit` → exit code/message; `Cause` pretty-print only for defects |
| `src/db/migration-files.ts` | pure parser, throws on malformed | pure parser returning `Result`/typed errors (consumed by the migrate program); checksum helper unchanged |
| `src/auth/auth.ts` | `createAuth(config, db)` building `betterAuth` | unchanged construction, wrapped in the `Auth` live layer factory (§5.3); `findSingleOrganizationForUser` stays a sync helper used by the better-auth hook AND becomes a `Database`-service query for principal resolution |
| `src/auth/middleware.ts` | promise middleware, inline result unions, direct db | `resolvePrincipal: Effect<Principal, UnauthenticatedError \| ForbiddenError \| DatabaseError \| AuthError, Auth \| Database>`; thin Hono middleware runs it via the runtime |
| `src/auth/permissions.ts`, `src/auth/principal.ts` | pure | **unchanged** (pure TS is the correct ground-up form) |
| `src/auth/bootstrap.ts` | sync upserts, throws, `import.meta.main` block | Effect CLI boundary: `bootstrapOwner` program (Database + Clock + IdGenerator), `runPromiseExit` exit mapping; arg parsing stays plain |
| `src/mailings/validation.ts` (218 lines) | hand-rolled `ValidationResult` | **deleted**; `src/mailings/schema.ts` (Effect Schema, §5.4) |
| `src/mailings/create-mailing.ts` | throws `CreateMailingError`; `now?`/`createId?` options; `db.transaction(() => …)` | Effect program: read→decide→write inside `Database.transaction(...)`; tagged errors; `Clock`/`IdGenerator` |
| `src/mailings/routes.ts` | try/catch on error class, local `errorResponse` | Effect programs + exhaustive `catchTags` via `runRoute`; envelope + mapping in `src/http/respond.ts` |
| `src/queue/jobs.ts` | sync fns, `now?:` params, `{ok:false}` unions | Effects requiring `Database`; `JobNotLeasedError`; kinds/states from `Schema.Literals`; SQL text verbatim |
| `src/queue/runner.ts` | try/catch loop, `drainOnce` | `Effect.gen` loop with the nested stale-handling shape (§5.5); `drainOnce` as `Effect.iterate`-style loop |
| `src/queue/backoff.ts` | pure | **unchanged** (`RangeError` stays an invariant defect) |
| `src/queue/time.ts` | `nowIso`/`addSecondsIso` | **deleted**; pure ISO math → `src/lib/iso-time.ts`; "now" → `Clock` |
| `src/app.ts` | Hono wiring, optional deps | wiring unchanged in spirit; takes the runtime; `/api/auth/*` passthrough kept raw; health-db uses `Database.ping` |
| `src/testing/bun-scenario.ts` + 5 scenario-based test files | string-templated scripts spawned via `bun` subprocess | **shrunk** to a retained integration set (§5.6); domain tests become in-process vitest Effect tests on `node:sqlite` |
| `apps/cli` | empty stub | untouched (future Effect CLI over HTTP) |
| root `worker-configuration.d.ts` | untracked CF leftover | **deleted** (Phase 0) |

New files: `src/errors.ts`, `src/http/respond.ts`, `src/services/database.ts`, `src/services/database-bun.ts`, `src/services/ids.ts`, `src/services/auth.ts`, `src/lib/iso-time.ts`, `src/mailings/schema.ts`, `src/queue/schema.ts`, `src/testing/layers.ts` (includes `DatabaseNodeLive`).

## 5. Target architecture

### 5.1 `Database` service — driver-agnostic, synchronous, transactional

```ts
// src/services/database.ts — interface + key only (no driver imports here)
type SqlParams = Record<string, string | number | null>;
interface DatabaseService {
  readonly run:  (operation: string, sql: string, params?: SqlParams) => Effect.Effect<void, DatabaseError>;
  readonly get:  <T>(operation: string, sql: string, params?: SqlParams) => Effect.Effect<T | null, DatabaseError>;
  readonly all:  <T>(operation: string, sql: string, params?: SqlParams) => Effect.Effect<readonly T[], DatabaseError>;
  readonly exec: (operation: string, sql: string) => Effect.Effect<void, DatabaseError>; // multi-statement, no params
  readonly ping: Effect.Effect<boolean>;
  readonly transaction: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DatabaseError, R>;
}
export const Database = Context.Service<DatabaseService>("nusend/Database");
```

- `operation` is a non-sensitive label carried into `DatabaseError` (never SQL params — they contain emails).
- **`exec` exists because prepared statements don't reliably run multi-statement SQL** (bun's `query()` ignores trailing statements; node's prepared `.run()` silently part-executes — a partial-execution hazard). Migration up/down SQL (whole files with many `CREATE TABLE`/`CREATE INDEX` statements, e.g. `0001_initial_schema.sql`) goes through `exec`, backed by bun `db.run(sql)` / node `db.exec(sql)`. Everything else uses prepared `run/get/all` and must stay single-statement.
- **Driver divergence to normalize:** node:sqlite's no-row `.get()` returns `undefined`, bun's returns `null` — the node layer coalesces `?? null` to honor the `T | null` contract (covered by the driver-parity smoke).
- `transaction` issues `BEGIN IMMEDIATE;` → work → `COMMIT;`, with `tapError` → `ROLLBACK;` (ignore rollback failure, preserve the original error). Verified pattern. **Policy (enforced by review + a conformance grep):** transactional work performs DB-only effects — no fetch/timer/auth calls inside a transaction, since a suspended fiber would hold SQLite's write lock. All current call sites (createMailing, bootstrap upserts, migration apply) are DB-only, so this is a constraint on future code, not a change.
- `src/services/database-bun.ts`: `DatabaseBunLive(path)` = `Layer.effectContext(Effect.acquireRelease(open+pragmas, close).pipe(Effect.map(db => Context.make(Database, service(db)).pipe(Context.add(SqliteHandle, db)))))` — **one acquisition providing both keys** (`Database` for everyone, `SqliteHandle` — the raw `bun:sqlite` handle — consumed only by `AuthLive`, §5.3). Verified pattern incl. single-acquisition memoization when the same layer reference is reused (§3). Pragmas verbatim from `db/index.ts:37-43`.
- `src/testing/layers.ts`: `DatabaseNodeLive(":memory:")` over `node:sqlite`'s `DatabaseSync` — same interface, same SQL text (parity verified). Nuance: bun:sqlite `strict: true` accepts bare param keys; node:sqlite does too (verified) — keep `$name` placeholders + bare keys everywhere.
- `bun:sqlite` imports allowed only in `services/database-bun.ts`, `services/auth.ts` (raw handle for Better Auth), and retained bun-scenario fixtures — grep-gated.

### 5.2 Config — Effect `Config` + `Redacted` (replaces `config.ts` wholesale)

- **Empty-as-missing normalization is the foundation** (finding from review): today's `env.X?.trim() || fallback` treats empty/whitespace values as *absent*, and Effect `Config` does not (`""` is a present value; `Config.withDefault` fires only on missing; `Config.orElse` falls through on *any* failure, which would silently swallow invalid values). Define one helper — `trimmedOption(name): Config<Option<string>>` = `Config.option(Config.string(name))` mapped so `""`/whitespace → `None`, otherwise `Some(trimmed)` — and build everything on it.
- **Port:** presence-based fallback chain (NOT `Config.orElse`): first `Some` of [`NUSEND_PORT`, `PORT`], else `"3000"`, **then** parse + validate integer 1–65535 as a terminal check that fails hard. `NUSEND_PORT="abc"` or `"70000"` must fail with today's error, never fall through to `PORT`/default. Host default "0.0.0.0"; `NUSEND_DB_PATH` empty-as-missing → default, with the repo-root-relative resolution (`config.ts:122-126`) kept as a pure helper.
- **Auth group with all-or-nothing semantics preserved exactly** (`config.ts:55-94`): read all five auth vars via `trimmedOption`. "Anything set?" = any of the **five** is `Some` (trusted-origins counts — setting only it is an error today, `config.ts:61-66`). The **required** set is the four: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; `NUSEND_AUTH_TRUSTED_ORIGINS` is **optional-within-enabled** (falls back to the base-URL origin, `config.ts:92,110-119`). All five `None` → `Option.none()` (auth disabled); anything set but a required var missing → **fail with a descriptive `ConfigError` naming the missing required vars**. Do NOT wrap the whole group in one `Config.option` — that silently disables auth on partial configuration (probe-verified pitfall, §3). Validation rules ported exactly: secret **min-32 validated on the plain string, then wrapped** (`Redacted.make` last — a redacted value can't be length-checked), absolute http(s) URL, **HTTPS required when `NODE_ENV=production`**, trusted-origins parse → origins → dedupe → fallback. Secrets (`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`) are `Redacted`; unwrapped only inside the `Auth` live layer where `betterAuth()` needs raw strings.
- Providers: production/CLIs use `ConfigProvider.fromEnv()`; tests use `ConfigProvider.fromUnknown(fixture)` (verified). `config.test.ts` is rewritten against fixtures — same cases plus explicit fixtures for `""`, whitespace-only, invalid, and out-of-range values asserting today's outcomes; no `process.env` mutation.
- `requireAuthConfig` disappears: `main.ts` requires `Option.getOrThrowWith`-style handling? No — it fails with a typed `ConfigError`-derived message at the boundary exactly as today ("Auth is not configured. Set …"), because `main.ts` refuses to start without auth (current behavior, `main.ts:8`).

### 5.3 `Auth` service — Better Auth stays a boundary library

```ts
interface AuthService {
  readonly handler: (request: Request) => Promise<Response>;   // raw passthrough for /api/auth/*
  readonly getSession: (headers: Headers) => Effect.Effect<SessionData | null, AuthError>;
  readonly verifyApiKey: (key: string) => Effect.Effect<ApiKeyVerification, AuthError>;
}
```

- `AuthLive(authConfig)` is a `Layer.effect` that takes the raw bun:sqlite handle from the database layer (expose it via a second internal service key `SqliteHandle` provided by `DatabaseBunLive`, consumed only by `AuthLive` — keeps `bun:sqlite` types out of everything else) and builds `betterAuth({...})` exactly as `auth.ts:15-90` (signup-disabled hook, session-org hook, organization + apiKey plugins, schema mappings). `getSession`/`verifyApiKey` wrap `auth.api.*` in `Effect.tryPromise` → `AuthError`.
- Principal resolution (`middleware.ts:43-127`) becomes `resolvePrincipal(headers, required?: PermissionSet): Effect<Principal, UnauthenticatedError | ForbiddenError | AuthError | DatabaseError, Auth | Database>` — same decision tree: `x-api-key` → verify + `hasPermissions`; else session → active-org fallback query → membership check → role permissions. `permissions.ts` helpers stay pure and untouched.
- The Hono middleware becomes a thin shell: run the program via the runtime, on success `context.set("principal", …)`, on typed failure map to the exact current envelopes (`unauthenticated` 401 / `forbidden` 403, messages preserved verbatim — they are asserted in `routes.test.ts:16-31` and are part of the frozen contract).
- The better-auth `databaseHooks.session.create.before` hook keeps calling the **sync** `findSingleOrganizationForUser(db, …)` helper with the raw handle (it runs inside Better Auth's machinery, not ours). The same query also exists as a `Database`-service call for principal resolution. One SQL string, two call forms — keep the SQL in one exported constant to avoid drift.

### 5.4 Schema at trust boundaries

- **`src/mailings/schema.ts` — `CreateMailingRequest`**: `purpose` via `Schema.Literals`; `subject`/`html` trim→nonEmpty (`Schema.decodeTo` + `SchemaGetter.transform` + `Schema.isMinLength(1)`); `name`/`text` optional trim→`null`; `scheduledAt` optional **lenient** date (helper `parseLenientDateToIso` in `lib/iso-time.ts` using `new Date` + NaN check — same acceptance as today, and the only allowed `new Date(input)` site); `recipients` (1–1000, cap from `validation.ts:1`) of `{ email, vars? }` with email trim/lowercase + shape check (`Schema.makeFilter`, same regex-free rules as `validation.ts:86-105`) and `vars` object→JSON-string transform; duplicate detection on **normalized** emails as a struct-level filter (pin with a `[" A@x.com ", "a@x.com"]` test).
- **Recipient-source presence rules validated on the RAW input** before Schema decode: today's `Object.hasOwn(value, "recipients") && value.recipients !== undefined` semantics (`validation.ts:54-63`) make `{recipients: null, listId: "x"}` → 400 and cannot be reproduced post-normalization. `decodeCreateMailingRequest` = raw presence check (exactly-one-source; transactional-forbids-listId) → `Schema.decodeUnknownResult(..., { errors: "all" })`. Required tests: `{recipients: null, listId}`, `{recipients: undefined}`, `{recipients: null}`, `{listId: null}` each asserting today's status/code.
- **`src/queue/schema.ts`**: `JobKind`/`JobState` as `Schema.Literals` (replacing the type unions in `jobs.ts:6-7`); `QueueJob` row schema matching the aliased `RETURNING` shape verbatim (`jobs.ts:59-72`), nullable `lockedBy`/`lockedUntil`/`lastError`, tested against a real returned row from each transition (claim→leased, complete→succeeded, fail→queued and dead, release→queued/dead). Note: unlike the CF version, this schema's kinds/states are ALSO CHECK-constrained in SQLite (`0001_initial_schema.sql:97-98`) — a decode failure is a true defect.
- Future Schema targets (not in scope, but the module layout anticipates them): SNS event bodies, SES responses, unsubscribe token payloads.

### 5.5 Tagged errors and HTTP mapping

`src/errors.ts`: `DatabaseError{operation, cause}` · `AuthError{operation, cause}` · `UnauthenticatedError{message}` · `ForbiddenError{message}` · `RequestValidationError{message}` · `ListNotFoundError{listId}` · `EmptyRecipientSetError{reason}` · `JobNotLeasedError{jobId}` · `MigrationError{version, reason}` · `BootstrapError{reason}`. No speculative SES/SNS errors yet. No `Logger` service yet (default Effect logging + a sanitized `logCause` helper cover today's needs; documented deviation from the skill's candidate list so Phase 5's skill rewrite doesn't reintroduce it).

`src/http/respond.ts`: the `{ error: { code, message } }` envelope (moved from `routes.ts:54-59`), one exhaustive `catchTags` → status/code table (`UnauthenticatedError`→401 `unauthenticated`; `ForbiddenError`→403 `forbidden`; `RequestValidationError`→400 `invalid_request`; `ListNotFoundError`→404 `not_found`; `EmptyRecipientSetError`→422 `empty_recipient_set`; `DatabaseError`/`AuthError`/defects→500 `internal_error` + sanitized `logCause`), and `runRoute(context, program)` executing via the app runtime. The compiler proves every route handles its full error set — replacing the convention-based catch in `routes.ts:37-47`.

**Queue runner control flow** (unchanged logic from `runner.ts:64-93`, tricky to port — specify the nested shape):

```
processor(job) →
  on success:  completeJob(...)            → succeeded
                 .catchTag(JobNotLeased)   → skippedStale        // never call failJob here
  on failure:  failJob(errorMessage(err))  → failed | dead (by returned job.state)
                 .catchTag(JobNotLeased)   → skippedStale        // caught INSIDE the failure branch
```

A flat `catchTag`+`catchAll` chain mis-routes `failJob`'s own stale error — the ported `runner.test.ts` must assert all five counter paths (succeeded / failed / dead / stale-complete / stale-fail; the existing scenarios already cover them — port assertions 1:1). Processor failures route to `failJob` (retryable); infrastructure `DatabaseError` from claim/release/complete/fail propagates out of `runOnce`. `drainOnce` keeps its `maxIterations` defect guard.

### 5.6 Runtime boundaries — the only `run*` sites

1. **`src/main.ts`** — read `serviceConfig` (one boundary `Effect.runPromise` with `ConfigProvider.fromEnv()`), then wire layers **explicitly** (plain `Layer.mergeAll` would NOT feed `SqliteHandle` into `AuthLive`): `const dbLayer = DatabaseBunLive(path); const appLayer = Layer.mergeAll(dbLayer, IdGeneratorLive, AuthLive(authConfig).pipe(Layer.provide(dbLayer)))` — reusing the same `dbLayer` reference is memoized to one connection/acquisition (probe-verified, §3). Then `ManagedRuntime.make(appLayer)`, `Bun.serve({ fetch: app.fetch, ... })`. Shutdown: `server.stop()` → `await runtime.dispose()` (runs the DB-close finalizer — verified) → `process.exit(0)`. Startup failures (ConfigError, DB open failure) print a clean message and exit non-zero.
2. **`src/http/respond.ts`** — `runRoute`; also the only place detached work would be scheduled if ever needed (none today — the CF poke pattern has no equivalent here yet).
3. **`src/db/migrate.ts`** — builds `DatabaseBunLive` runtime, runs the selected command program with `runPromiseExit`; typed `MigrationError` → `console.error(message)` + exit 1; defects → `Cause` pretty-print + exit 1; disposes runtime in `finally`. Command semantics (up/down/status, checksum validation, `.immediate()`-equivalent via `transaction`, multi-statement migration SQL via `Database.exec` — never prepared statements) preserved exactly, including console output shapes (`migrate.integration.test.ts` asserts them).
4. **`src/auth/bootstrap.ts`** — same pattern; `bootstrapOwner` becomes a program (upserts inside one `Database.transaction` — an improvement over today's non-transactional upserts, note as an intentional change); plain arg parsing kept.
5. **Future `src/worker.ts`** (designed-for, not built): `runOnce` repeated with `Schedule.spaced(pollInterval)`, graceful shutdown via fiber interruption + `runtime.dispose()`. In-process repetition is `Schedule`'s job; durable per-job retry stays in SQL (`jobs.run_at` + backoff CASE) — never converted to `Effect.retry`.
6. **Tests** — `runTest(effect, opts?) = Effect.runPromise(effect.pipe(Effect.provide(testLayer(opts))))` from `src/testing/layers.ts`. `Effect.provide`, not per-test `ManagedRuntime`s — except tests that specifically exercise layer lifecycle (one dispose test). **Each `runTest` call builds a fresh layer stack (fresh `:memory:` DB)** — by design; a multi-step scenario is therefore ONE `Effect.gen` program (seed → act → act → assert) run once, with `TestClock.setTime` advancing time between steps (§5.7).

### 5.7 Test architecture (the biggest win)

`src/testing/layers.ts`: `DatabaseNodeLive(":memory:")` (runs migrations by applying `parseMigrationFile(...)` upSql via `exec` — same files as production; **foreign-key enforcement enabled** via node:sqlite's constructor option so FK/cascade behavior matches the bun layer's `PRAGMA foreign_keys = ON`; no-row `.get()` coalesced `?? null`), **`TestClock.layer()`** as the default clock (from `effect/testing`; scenarios call `yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"))` at the start and between steps — verified that `Clock.currentTimeMillis` follows), `sequentialIdsLayer(prefix)`, `FakeAuthLive(behavior)` (replaces the `createAuth({...})` template-string fakes in scenario scripts), and `testLayer(...)` composing them.

**Multi-instant scenarios** (the queue tests claim at 12:00, complete/fail at 12:01, release later — over one shared DB): the removal of `now?:` params means time moves via `TestClock.setTime`, so each scenario becomes a single program over a single layer build. The **assertion values** (expected rows, lease timestamps, backoff `run_at`s) are copied 1:1 from the current scenario bodies — they are the golden fixtures — while the **driving code** is restructured from `fn(db, { now })` calls into one Effect program with clock advances. Do not re-derive expected values.

Migration of test files:

| Test file | Today | Target |
|---|---|---|
| `queue/jobs.test.ts`, `queue/runner.test.ts` | bun-scenario subprocess | in-process vitest on `DatabaseNodeLive` + `TestClock` (one program per scenario, `setTime` between steps); **assertion values copied 1:1 from the scenario bodies** (they ARE the golden fixtures; driving code restructured per §5.7) |
| `mailings/create-mailing.test.ts` | bun-scenario | in-process on `DatabaseNodeLive` + fixed clock + sequential ids |
| `mailings/routes.test.ts` | bun-scenario with fake auth template | in-process: real Hono app + `FakeAuthLive` + `DatabaseNodeLive`, `app.fetch(new Request(...))` directly in vitest |
| `auth/middleware.test.ts` | hand-rolled spawn variant | in-process with `FakeAuthLive` |
| `mailings/validation.test.ts` | pure vitest | rewritten as `mailings/schema.test.ts` (normalization + rejection **codes**, not prose; plus the presence-semantics and duplicate-normalization cases from §5.4) |
| `config.test.ts` | pure vitest mutating env | rewritten against `ConfigProvider.fromUnknown` fixtures (same cases incl. HTTPS-in-prod, partial-auth-config error, trusted-origins parsing) |
| `backoff.test.ts`, `migration-files.test.ts` | pure vitest | unchanged (backoff verbatim; migration-files updated only for the typed-error return shape) |
| `time.test.ts` | pure vitest | replaced by `lib/iso-time.test.ts` (addSecondsIso cases ported + `parseLenientDateToIso` + fixed-clock `currentIso`) |
| **Retained bun-scenario set** | — | `auth/auth.integration.test.ts` (real Better Auth against real tables — genuinely needs Bun), `db/migrate.integration.test.ts` (real CLI invocation), one new `db/driver-parity.test.ts` bun-scenario smoke running a representative claim/complete/fail cycle on real `bun:sqlite` to guard node/bun driver drift, and a `main.ts` boot smoke (serve → `/health` + `/health/db` → SIGTERM → clean exit) |
| `app.test.ts` | pure vitest (health/404 only) | unchanged in spirit; extended to run against the runtime-wired app |

`testing/bun-scenario.ts` survives only for the retained set; the ~200 lines of per-file template-string helper prologues (`scenarioScript`, inline `seedJob`, `assertEqual`, `stableJson`, fake-auth literals) are deleted.

## 6. Strategy and alternatives

**Chosen: six phases, bottom-up, green per phase, with a Transitional Register.** The dependency graph makes this cheap: queue has no production callers (no worker yet), mailings and queue are independent, config's consumers are the three entry points. Only one genuinely transitional artifact exists (the Phase 0 smoke test).

Rejected alternatives:

- **One atomic rewrite** — no benefit given the clean graph; loses reviewability.
- **`@effect/sql` family** — v3-era packages; the thin sync wrapper matches the skill's house pattern and this codebase's synchronous driver; an async pool abstraction would be a worse fit than 60 lines of `Effect.try`.
- **Statements-as-pure-data (the old CF plan's centerpiece)** — deliberately NOT ported. It existed because D1's `batch()` was the only transaction primitive. bun:sqlite has real interactive transactions; forcing statement lists here would prevent the natural read→decide→write shape of `createMailing` and be cargo culting.
- **Replacing vitest with `bun test`** — would let `bun:sqlite` load in tests directly, but abandons the vitest ecosystem the repo standardizes on (root scripts, watch mode), and the `node:sqlite` layer achieves in-process testing with a smaller change while ALSO proving the driver-agnostic service boundary. Revisit only if node/bun SQLite drift ever becomes a real cost (the parity smoke guards it).
- **Effect-izing Better Auth internals or `permissions.ts`** — boundary library and pure functions respectively; wrapping them adds ceremony, not safety.
- **Effect HttpApi replacing Hono** — unchanged reasoning from the previous cycle: unstable namespace, no current pain.

## 7. Implementation phases

Every phase ends with `pnpm check` green (format:check + lint + per-package `tsc` + vitest).

### Phase 0 — Dependency spike + housekeeping

1. Delete root `worker-configuration.d.ts` (untracked CF leftover).
2. `pnpm view effect dist-tags`; if newer than `4.0.0-beta.93`, re-run the probes (10 min) before pinning — specifically re-confirm: `SchemaGetter` transform-before-filter ordering, `Layer.succeed(Clock.Clock)` override, `Layer.effectContext` finalizer-on-dispose + same-reference memoization, `TestClock.setTime` driving `Clock` reads, and `ConfigProvider.fromUnknown` (an unusual name that could churn in the beta).
3. `pnpm --filter @nusend/service add effect@4.0.0-beta.93` (exact pin).
4. Typecheck spike: confirm `import { DatabaseSync } from "node:sqlite"` compiles under the service tsconfig (`types: ["bun"]`); if not, add `@types/node` to root devDependencies.
5. Dual-runtime smoke test `src/effect-smoke.test.ts`: one tiny program (Clock + `Layer.succeed` service + `Schema.decodeUnknownResult`) running in vitest/Node, plus a bun-scenario running the same program under Bun. **Deleted in Phase 1** (Transitional Register T1).
6. `pnpm check`.

### Phase 1 — Foundation (additive) + queue tests as the safety net

1. `src/errors.ts` (§5.5 family), `src/lib/iso-time.ts` (`toIso`, `addSecondsIso` moved from `queue/time.ts`, `parseLenientDateToIso`, `currentIso` from Clock).
2. `src/services/database.ts` (interface + key), `src/services/database-bun.ts` (`DatabaseBunLive` with acquireRelease + pragmas + `SqliteHandle` export), `src/services/ids.ts`.
3. `src/testing/layers.ts`: `DatabaseNodeLive` (applies real migration files' upSql via `exec`; FK enforcement on; `?? null` coalescing), `TestClock.layer()` default, `sequentialIdsLayer`, `runTest`.
4. Service tests: `database.test.ts` — run/get/all/ping/transaction commit + typed-failure rollback on **both** layers (node in-process; bun via one scenario), `DatabaseError` carries `operation`; a lifecycle test asserting `ManagedRuntime.dispose()` closes the DB.
5. Delete `src/effect-smoke.test.ts` (T1 closed).

### Phase 2 — Config + CLI boundaries

1. Rewrite `src/config.ts` per §5.2 (Effect Config, Redacted, all-or-nothing auth group with the partial-config failure, path resolution helper kept pure). Rewrite `config.test.ts` on `ConfigProvider.fromUnknown` fixtures.
2. `src/db/migration-files.ts`: typed-error return (pure `Result` or thrown→`Effect.try` at the caller — pick `Result`, matching the skill's parser-style guidance); update `migration-files.test.ts`.
3. `src/db/migrate.ts` as an Effect CLI (§5.6.3) using `Database.exec` for migration up/down SQL; it stops importing `src/db/index.ts` — but **`db/index.ts` is NOT deleted yet** (`main.ts`/`app.ts` still consume it until Phase 4; deleting it here would break the green-per-phase rule). `migrate.integration.test.ts` (bun-scenario, retained) must pass with **unchanged console output assertions**.
4. `src/auth/bootstrap.ts` as an Effect CLI (§5.6.4); `bootstrap.test.ts` ported to in-process `DatabaseNodeLive` where it tests `bootstrapOwner` logic, bun-scenario retained only if it exercises the real CLI entry.
5. `src/main.ts` interim update: read the new `serviceConfig` via one boundary `Effect.runPromise`, otherwise unchanged wiring (this boundary read survives into the final design — not a shim).

### Phase 3 — Queue engine

1. `src/queue/schema.ts` (kinds/states literals + `QueueJob` row schema per §5.4).
2. `src/queue/jobs.ts` → Effects requiring `Database` (+Clock for default `now`); `JobNotLeasedError`; SQL text **verbatim** (`claimJobs` subquery ordering `run_at, created_at, id` — no priority column in this version; kind-filter builder; retry CASE ladder as-is); `now?:` params removed.
3. `src/queue/runner.ts` → `runOnce`/`drainOnce` per §5.5 nested shape.
4. Delete `src/queue/time.ts` + `time.test.ts` (pure parts already in `lib/iso-time.ts` since Phase 1).
5. Port `jobs.test.ts` + `runner.test.ts` scenario bodies to in-process tests per §5.7: one Effect program per scenario, `TestClock.setTime` between multi-instant steps, assertion **values** 1:1 (exact lease timestamps, backoff `run_at` sequence, claim ordering, all five runner counter paths — succeeded / failed / dead / stale-complete / stale-fail).

### Phase 4 — Auth, mailings, HTTP, and the main lifecycle

1. `src/services/auth.ts` (`AuthService` + `AuthLive` per §5.3), `resolvePrincipal` program, thin Hono middleware; `middleware.test.ts` in-process with `FakeAuthLive` (same status/message assertions).
2. `src/mailings/schema.ts` per §5.4 (raw presence check + Schema decode); `schema.test.ts` replaces `validation.test.ts` (normalized values + codes, presence cases, duplicate-normalization case).
3. `src/http/respond.ts` (envelope, `catchTags` table, `runRoute`).
4. `src/mailings/create-mailing.ts` as a transactional Effect program: `Database.transaction(resolve recipients → suppression check → insert mailing/deliveries/jobs)`, `Clock`/`IdGenerator`, tagged errors; the per-recipient loop stays sequential (sync driver — no concurrency to preserve, unlike the CF version). `create-mailing.test.ts` in-process.
5. `src/mailings/routes.ts` via `runRoute`; `routes.test.ts` in-process (frozen envelopes incl. exact auth messages).
6. `src/app.ts` takes the runtime; `/api/auth/*` passthrough via `Auth.handler`; `/health/db` via `Database.ping`.
7. `src/main.ts` final form (§5.6.1) — ManagedRuntime, signal-driven `dispose()`. Manual smoke: `pnpm --filter @nusend/service dev`, run the README curl flow (`/health`, `/health/db`, 401 without key, mailing create with a bootstrapped key), Ctrl-C exits cleanly.
8. Deletions: `src/mailings/validation.ts`, `validation.test.ts`, `CreateMailingError`, and `src/db/index.ts` (its last consumers — `main.ts`, `app.ts` — were ported in this phase).

### Phase 5 — Test consolidation, conformance sweep, docs

1. Shrink `testing/bun-scenario.ts` usage to the retained set (§5.7); add `db/driver-parity.test.ts` and the `main.ts` boot smoke; delete all template-string helper prologues.
2. **Conformance gates** — all must return zero hits outside the allowed files (run over `apps/service/src`):

| Gate | Allowed hits (as amended during implementation — see Deviations) |
|---|---|
| `runPromise\|runSync\|runFork\|runPromiseExit` | `main.ts`, `http/respond.ts`, `auth/middleware.ts` (requirePrincipal is an HTTP boundary), `db/migrate.ts`, `auth/bootstrap.ts`, `testing/`, `*.test.ts` |
| `new Date(\|Date.now(` | `lib/iso-time.ts` only (non-test files) |
| `bun:sqlite` imports | `services/database-bun.ts`, `services/auth-live.ts`, `auth/auth.ts` (Better Auth construction + sync session hook), `testing/bun-fixtures.ts` |
| `node:sqlite` imports | `testing/layers.ts` only |
| `process.env` | `main.ts`, `db/migrate.ts`, `auth/bootstrap.ts` (provider wiring only); test files may pass env to spawned processes |
| `ValidationResult\|CreateMailingError\|nowIso\|queue/time\|scenarioScript` (beyond retained set) | none |
| `now?:\|createId?:` option params | none |
| `JSON.parse` | none in non-test files (`vars` uses stringify; future payload decoding uses `Schema.fromJsonString`); test files may parse spawned-process/HTTP output |
| `as any\|@ts-expect-error\|@ts-ignore` | none |
| `throw new` | invariant defects and CLI usage errors only: `queue/backoff.ts`, `queue/jobs.ts` (`normalizeLimit` RangeError), `queue/runner.ts` (`maxIterations`), `db/migrate.ts` (`parseCommand` usage), `auth/bootstrap.ts` (arg-parse usage), `auth/auth.ts` (`throw new APIError` — Better Auth's documented hook-rejection convention for the signup-disabled hook); test-internal assertion helpers |
| `TRANSITIONAL` | none |
| `Redacted.value` | `services/auth-live.ts`, `config.test.ts` (assertion-only) |

3. Docs: README (unchanged commands verified; env section gains a note that config errors are aggregated), PROJECT.md Core Stack gains Effect; **rewrite `.agents/skills/effect-v4/references/project-patterns.md`** for this layout (services map, transaction policy, test layers, boundary list); add a dormancy note to the `cloudflare-workers` skill reference (R2 phase may revive it).
4. Full `pnpm check`; boot smoke again.

### Transitional Register (must be empty after Phase 4; Phase 5 grep-verifies)

| # | Introduced | Artifact | Deleted |
|---|---|---|---|
| T1 | Phase 0 | `src/effect-smoke.test.ts` (+ companion `src/effect-smoke.ts`) dual-runtime smoke | Phase 1 ✅ |
| T2 | Phase 2 | `main.ts` unwraps `Redacted` for `createAuth` (`TRANSITIONAL(phase-4)`) | Phase 4 ✅ |

(Yes, just one — the dependency graph allows it. Any additional adapter an implementer needs must be added to this table with a deletion phase, marked `// TRANSITIONAL(phase-N)`.)

## 8. Behavioral contract

**Frozen (any diff is a bug):**

- HTTP: all status codes and `error.code` values (`unauthenticated`, `forbidden`, `invalid_request`, `not_found`, `empty_recipient_set`, `internal_error`); the exact auth middleware messages (asserted in `routes.test.ts`); success shapes (`mailing` + `counts`, `counts.deliveries = queued + suppressed`); 201 on create.
- Normalization: trim subject/html/name/text; empty-optional→null; email trim+lowercase; duplicate rejection; 1000-recipient cap; `vars`→JSON string; `scheduledAt` lenient-`new Date` acceptance → ISO; recipient-source presence semantics (`Object.hasOwn`-equivalent).
- Auth: Google-only, signup disabled (hook), org-limit 1, API keys `nusend_`-prefixed with `configId: "organization"`, permission statements/roles verbatim, session active-org fallback query, membership check.
- Queue: claim ordering `run_at ASC, created_at ASC, id ASC` (+ post-sort); lease 300s / claim 10 / release 100 defaults; backoff 60·2^(n−1) capped 3600; dead-letter at `attempts >= max_attempts`; `last_error` 2000-char cap; kind-filter semantics (empty/undefined kinds = all kinds — note: **differs from the CF version**, where empty meant none); all SQL text verbatim.
- Mailings: one interactive transaction per create (reads included); suppressed recipients still get delivery rows; suppression scope predicates (marketing: all/marketing/list-with-id; transactional: all only); list recipients ordered by email; `empty_recipient_set` when zero candidates or all suppressed.
- Config: default host/port/db-path; `PORT` fallback; port bounds; HTTPS-in-prod; auth all-or-nothing incl. partial-config hard failure; trusted-origins dedupe + fallback.
- Migrations: up/down/status semantics, checksum change detection, missing-file errors, console output shapes; `BEGIN IMMEDIATE`-equivalent transactionality per migration.
- Process: SIGINT/SIGTERM → server stop → DB close → exit 0.

**Allowed to change (documented):** validation error prose (Schema-derived, aggregated via `errors: "all"`); config error prose (Config-derived, possibly aggregated); `jobs.last_error` text format; `bootstrapOwner` upserts becoming transactional; internal module structure and unit-test shape.

## 9. Testing & verification plan

- **Safety net:** the scenario bodies of `jobs`/`runner`/`create-mailing`/`routes`/`middleware` tests are exact-value assertions under fixed clocks — port them **1:1** (they are the golden fixtures; do not re-derive expectations). The retained bun-scenario integration set (Better Auth E2E, migrate CLI, driver parity, boot smoke) guards everything the node layer can't see.
- **New tests:** database service (both drivers, transaction rollback, dispose lifecycle), config fixtures (incl. partial-auth failure), schema presence/duplicate/lenient-date cases, route error-mapping exhaustiveness (each tag → status/code, defect → 500).
- **Per phase:** `pnpm check`. Phase 4 additionally: manual boot + README curl flow + clean Ctrl-C.
- **Watch item:** vitest runs Effect programs under Node — fine (verified via probes and Phase 0 smoke); Bun-specific behavior is covered by the retained scenarios.

## 10. Risks, edge cases, mitigations

| Risk | Mitigation |
|---|---|
| Effect v4 beta churn | exact pin; re-run probes on any bump (Phase 0.2 lists the three riskiest claims) |
| node:sqlite / bun:sqlite behavioral drift (param binding, RETURNING, type coercion, no-row `.get()` `undefined` vs `null`, FK enforcement, multi-statement handling) | parity verified for the forms used; `?? null` coalescing + FK constructor option + `exec`-only multi-statement rule specified; permanent `driver-parity.test.ts` bun-scenario smoke; identical SQL text enforced by the shared service |
| Fiber suspension inside a transaction holding the write lock | DB-only-inside-transaction policy (§5.1); all current call sites comply; review rule + no async services injected into transactional programs |
| Partial auth config silently disabling auth | per-var `Config.option` + explicit mixed-state failure (§5.2, probe-verified pitfall) |
| Better Auth needs the raw handle while everything else uses the service | `SqliteHandle` internal key provided by `DatabaseBunLive`, consumed only by `AuthLive`; grep gate on `bun:sqlite` imports |
| Silent queue behavior drift | verbatim-SQL rule + 1:1 ported assertions |
| Lock-step test rewrites hiding drift | scenario assertions ported verbatim, not re-authored; retained integration set unchanged |
| `dispose()` not running on hard kill (SIGKILL) | unavoidable; WAL + `busy_timeout` pragmas make SQLite crash-safe — same exposure as today |
| Secrets/PII in logs | `DatabaseError` carries `operation` only; `Redacted` for secrets; `logCause` reviewed in Phase 5; `Redacted.value` grep-gated to `services/auth.ts` |
| `types: ["bun"]` vs `node:sqlite` typings | Phase 0.4 verifies; add `@types/node` if needed |

## Implementation Progress

Tracker for the implementation run started 2026-07-07. Reviews via Pi CLI (per implement-plan skill preference), session IDs recorded per step.

**Status: COMPLETE — all six phases implemented, per-phase reviews (14 findings, all incorporated and re-verified) plus a final cumulative independent review with explicit approval and zero findings. `pnpm check` fully green: format, oxlint, tsc (both packages), vitest 18 files / 95 tests.**

| Phase | Status | Notes |
|---|---|---|
| 0 — Dependency spike + housekeeping | **done** | beta still `4.0.0-beta.93` (no probe re-run); `worker-configuration.d.ts` deleted; effect pinned exactly in @nusend/service; node:sqlite typechecks under `types:["bun"]` (no @types/node needed); dual-runtime smoke (`effect-smoke.ts` + `.test.ts`, TRANSITIONAL T1) green on Node+Bun; `pnpm check` green (68 tests) |
| 1 — Foundation + database service | **done** | `errors.ts`, `lib/iso-time.ts`, `services/{database,database-bun,ids}.ts`, `testing/layers.ts` (+ shared `testing/database-contract.ts` exercising run/get/all/exec/ping/tx-commit/typed-rollback/operation-label on BOTH drivers), `database.test.ts` + `testing/layers.test.ts`; dispose-closes-DB verified on both drivers; effect-smoke deleted (T1 closed); `pnpm check` green (72 tests) |
| 2 — Config + CLI boundaries | **done** | `config.ts` reborn as Effect Config (trimmedOption, presence-based port chain, all-or-nothing auth group w/ aggregated missing-vars failure, Redacted secrets); `config.test.ts` on `fromUnknown` fixtures (16 cases); `migration-files.ts` → `Result<MigrationFile, MigrationError>`; `migrate.ts` + `bootstrap.ts` as Effect CLIs (`runPromiseExit`, catchTags exit mapping, transactional bootstrap); `bootstrap.test.ts` in-process (5 cases incl. `--force` + unmigrated-schema via `migrate:false` layer option); `main.ts` interim boundary read; scenario templates consolidated onto new `testing/bun-fixtures.ts` (`createMigratedBunDatabase`, `seedOwner`); `pnpm check` green (84 tests incl. migrate CLI integration w/ unchanged output assertions) |
| 3 — Queue engine | **done** | `queue/schema.ts` (Literals kinds/states + `QueueJob` row schema, decode failures = defects via `orDie`); `queue/jobs.ts` → Effects on Database+Clock, `JobNotLeasedError`, SQL verbatim, `now?:` removed; `queue/runner.ts` → §5.5 nested shape (`Effect.exit` around processor, `Cause.squash` → errorMessage, stale caught inside each branch); `queue/time.ts` + `time.test.ts` deleted, `lib/iso-time.test.ts` added; `jobs.test.ts`/`runner.test.ts` ported in-process with TestClock multi-instant steps, assertion values 1:1 (all five runner counter paths); new `testing/queue-fixtures.ts` (`seedJob` effect); `pnpm check` green (88 tests) |
| 4 — Auth, mailings, HTTP, main | **done** | `services/auth.ts` (key/types, driver-neutral) + `services/auth-live.ts` (Better Auth layer, only Redacted.value + bun:sqlite site); `resolvePrincipal` program + thin `requirePrincipal` shell (frozen envelopes); `mailings/schema.ts` (probe-verified Schema transforms, raw presence checks, normalized-email duplicates, errors:"all") replaces deleted `validation.ts`; `http/respond.ts` (envelope + exhaustive catchTags table + `runRoute`); transactional `createMailing` Effect (SQL verbatim); routes/app take the runtime; `main.ts` final (ManagedRuntime, memoized dbLayer, fail-fast ping, dispose-on-signal — T2 closed); `db/index.ts` deleted; middleware/routes/create-mailing/app tests in-process (FakeAuthLive, withTestApp, listIdsLayer rollback collision); manual smoke: migrate→bootstrap→real API key→201 create→SIGTERM exit 0; `pnpm check` green (93 tests, suite ~3.5s vs ~14s) |
| 5 — Consolidation, conformance, docs | **done** | Retained bun-scenario set finalized (Better Auth E2E consolidated onto shared helper; new `db/driver-parity.test.ts` — identical node/bun snapshots via shared `testing/driver-parity.ts` cycle incl. exec-applied migrations; new `main.integration.test.ts` boot smoke: migrate → serve → /health → /health/db → 401 envelope → SIGTERM exit 0); all 12 conformance gates pass against the amended allow-lists (2 reconciled hits: comment-only `node:sqlite` mentions; `throw new APIError` = Better Auth hook convention, added to gate table); README (config-validation + aggregated-errors notes), PROJECT.md Core Stack + Effect, `project-patterns.md` fully rewritten for this layout, cloudflare-workers skill dormancy note; `pnpm check` green (18 files / 95 tests) |

### Log

- 2026-07-07: **Post-completion cleanup pass (user-requested; own deep scan + fresh Pi second opinion).** Own scan found + fixed: MISSING §9 test — route error-mapping exhaustiveness → added `http/respond.test.ts` (every RouteError tag → frozen status/code, infra failure + defect → sanitized 500 with `logCause` called, onSuccess path); dead export `AuthInstance` removed; `findSingleOrganizationForUser` / `CreateMailingRequest` / `maxExplicitRecipients` made private; `app.ts` notFound reuses `errorEnvelope`. Pi pass found + fixed: `steppingClockLayer` now throws on over-read (proves runOnce reads the clock exactly twice); missing test for the frozen "Session is not a member of the active organization." path added; migration-file listing/parsing consolidated into one shared `readMigrationFiles()` in `db/migration-files.ts` (was duplicated in migrate.ts + 3 test helpers); `listIdsLayer` fallback covered; stale comment fixed. Kept deliberately: option/result types on exported functions, `resolvePrincipal` export (named §5.3 program), `checksum`/`authStatements` (plan-unchanged files). Surfaced to owner: `.claude/skills` symlinks are untracked (commit-vs-ignore decision). Reviewer verified all fixes on disk; no further findings. `pnpm check` green (19 files / 106 tests).
- 2026-07-07: **FINAL review (Pi, fresh session): explicit approval, zero findings.** Reviewer independently walked Phases 0–5 against the repo, spot-checked the §8 frozen contract (HTTP mapping, auth messages, queue SQL semantics, normalization, config semantics, migration output, lifecycle), confirmed the Transitional Register is clean (T1/T2 closed, no TRANSITIONAL markers, all legacy files deleted), confirmed the golden 1:1 assertions exist in the new tests, and re-ran `pnpm check` itself (18 files / 95 tests, all green).
- 2026-07-07: Plan read in full. Execution is sequential (phases are tightly coupled; shared files); no implementation subagents. Reviewer: Pi CLI first pass per major phase.
- 2026-07-07: **Phase 4 review (Pi):** 4 findings, all incorporated — (1) main.ts fail-fast ignored a `false` ping → now exits non-zero on unhealthy ping; (2) `auth/middleware.ts` run-site + second (auth-only) mapping documented and added to the gate table; (3) gate-table amendments recorded pre-sweep (bun:sqlite sites incl. `auth/auth.ts`, test-file exceptions for JSON.parse/run*/throw-new); (4) config failures now print `Invalid configuration: <message>` + exit 1 (manually verified). Reviewer confirmed all resolved; no frozen-contract regressions found in the Phase 4 logic.
- 2026-07-07: **Phase 3 review (Pi):** 2 findings, both incorporated — (1) BEHAVIOR DRIFT: old runOnce shared ONE `now` across release+claim; ported code read the Clock per call → added exported snapshot variants `claimJobsAt`/`releaseExpiredLeasesAt` (public forms read Clock once and delegate), runOnce snapshots once; (2) cadence not pinned by tests → added `steppingClockLayer` (Clock.Clock override walking an instant list) + regression test proving a job due between snapshot and next read is NOT claimed and completion reads fresh later time. Reviewer re-verified: resolved; non-blocking note recorded (steppingClockLayer repeats last instant rather than failing on over-read). `pnpm check` green (89 tests).
- 2026-07-07: **Phase 2 review (Pi):** 4 findings, all incorporated — (1) bootstrap error precedence restored (schema → owner → email, matching pre-Effect order; precedence test added); (2) IdGenerator non-suspending constraint documented at the interface (ids are generated inside write transactions; pre-generation not viable and plan's Phase 4 design does the same — policy, not type-enforced); (3) `seedOwner` email normalization aligned (trim+lowercase); (4) migrate integration test extended with `missing` status / up-with-missing-file / down-with-missing-file assertions. Reviewer re-verified on disk: resolved, no remaining material issues. `pnpm check` green (85 tests).
- 2026-07-07: **Phases 0+1 review (Pi, session recorded in scratchpad):** 4 findings, all incorporated — (1) CRITICAL `makeTransaction` armed ROLLBACK around BEGIN, so a failed nested BEGIN rolled back the caller's transaction → rollback now armed only after BEGIN succeeds; (2) HIGH rollback only fired on typed failures, not defects/interruption → now `Effect.onExit` on every non-success exit; (3) MEDIUM open-handle leak when pragmas/migrations failed during acquire → bare handle acquired first (finalizer registered), pragmas/migrations in a following `Effect.tap`; (4) contract gap → shared contract extended with defect-rollback and nested-BEGIN cases, run on both drivers. Reviewer re-verified on disk + reran the test file: concerns resolved, no remaining material issues. `pnpm check` green (72 tests).

### Deviations

- Phase 0 housekeeping not in the plan: `pnpm-workspace.yaml` gained `allowBuilds: { msgpackr-extract: false }` (pnpm 11 build-script gate on a transitive effect dep; native accelerator with pure-JS fallback — build not needed). `.gitignore` gained `.pi-subagents/` (review-session workspace files were failing the root `format:check` glob; pre-existing, unrelated to plan content).
- Review cadence: Phases 0+1 reviewed together (Phase 0 is housekeeping); then per-phase.
- Phase 0 smoke needed a companion module `src/effect-smoke.ts` (the shared program imported by both vitest and the bun-scenario) — covered by Register entry T1, deleted with the test in Phase 1.
- Phase 2: `Config.fail` requires a `ConfigProvider.SourceError` in the beta (plain strings pass at runtime but not tsc) — wrapped in a `configFailure(message)` helper in `config.ts`.
- Phase 2: new shared fixture module `src/testing/bun-fixtures.ts` (`createMigratedBunDatabase`, `seedOwner`) replaces per-template migration/seeding prologues in the bun-scenario tests (jobs/runner/create-mailing/routes/middleware/auth.integration) — needed because `parseMigrationFile` now returns `Result` and templates can't import bare `effect`; also permanently serves the retained scenario set (§5.7). `seedOwner` replaces the auth.integration template's direct `bootstrapOwner(db, ...)` call (bootstrap is now an Effect program).
- Phase 2: `bootstrap.ts` CLI block lazy-imports `DatabaseBunLive` (`await import` inside `import.meta.main`) so vitest/Node can import `bootstrapOwner` without loading bun:sqlite.
- Phase 2: partial-auth-config failure message is now aggregated ("Auth is partially configured. Missing: …" naming every missing required var) per §5.2, replacing first-missing-var prose — covered by §8 "allowed to change".
- Gate amendment for Phase 5: `Redacted.value` also allowed in `config.test.ts` (assertion that the parsed secrets round-trip; test-only).
- Register entry T2 added: `main.ts` interim unwraps Redacted for `createAuth` (marked `TRANSITIONAL(phase-4)`); the unwrap moves into the Auth layer in Phase 4.

## 11. Open questions / recorded assumptions

1. **Hono stays; phased execution** — carried over from the previously ratified decisions; nothing in the pivot changes them.
2. Validation/config **message prose** changes and transactional `bootstrapOwner` are assumed acceptable (§8 "allowed").
3. The future `worker.ts` design (Schedule-spaced `runOnce`, interruption-based shutdown) is described so this migration's shapes anticipate it, but building it is out of scope.
4. Re-check `pnpm view effect dist-tags` at implementation start; the plan is verified against `4.0.0-beta.93`.
