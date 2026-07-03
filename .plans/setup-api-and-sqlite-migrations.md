# Set Up Basic API and SQLite Migration Foundation

## Implementation Progress

Started: 2026-07-03 13:51 CEST

Progress tracker retained in this plan file per `implement-plan` workflow.

### Decomposition

- [x] Step A: Add service package scripts/dependency, TypeScript config, env config, docs/env ignore baseline.
- [x] Step B: Add DB connection helper, migration parser, migration runner, and initial schema SQL.
- [x] Step C: Add minimal Hono app/server and tests.
- [x] Step D: Run formatter/lint/typecheck/tests and DB/API smoke validation.
- [x] Step E: Independent reviews after major implementation and final completion; incorporate feedback.

### Parallelism Decision

- Implementation will be sequential. The changes are tightly coupled around service config, DB wiring, migrations, and tests; parallel implementation would overlap on shared files and increase merge risk.
- Independent review passes will be performed with Claude CLI as required by the workflow.

### Work Log

- 2026-07-03 13:51 CEST: Read full implementation plan and relevant existing files. Current repo only has untracked plan artifacts.
- 2026-07-03 14:02 CEST: Installed `hono`, added service scripts, source tsconfig include, config/env docs, DB connection helper, migration parser/runner, initial schema SQL, Hono app/server, and Vitest tests for parser and health routes.
- 2026-07-03 14:03 CEST: Incorporated independent review feedback: repo-root anchoring for relative `NUSEND_DB_PATH`, config tests, and Bun subprocess migration integration test including checksum drift refusal.
- 2026-07-03 14:08 CEST: Incorporated final review's non-blocking test suggestion by asserting migrated and rolled-back table sets in the migration integration test.

### Validation Log

- 2026-07-03 13:55 CEST: Initial `pnpm format:check` failed; ran `pnpm format` and fixed resulting Oxlint shadow warnings in `apps/service/src/db/migrate.ts`.
- 2026-07-03 13:55 CEST: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` passed.
- 2026-07-03 13:56 CEST: DB smoke passed: `db:status` pending, `db:migrate`, `db:status` applied, `db:rollback`, `db:migrate`.
- 2026-07-03 13:56 CEST: Verified SQLite tables exist in `.data/nusend.sqlite` via Bun SQLite query.
- 2026-07-03 13:56 CEST: API smoke passed on port 3400: `GET /health` and `GET /health/db` returned 200.
- 2026-07-03 13:56 CEST: `pnpm check` passed.
- 2026-07-03 14:02 CEST: After review fixes, `pnpm format && pnpm check` passed; Vitest now has 4 files / 13 tests.
- 2026-07-03 14:03 CEST: Re-ran DB status/rollback/migrate/status and table verification successfully after config path fix.
- 2026-07-03 14:03 CEST: Re-ran API smoke on port 3400 successfully after config path fix.
- 2026-07-03 14:08 CEST: After final review test enhancement, `pnpm format && pnpm check` passed.

### Review Log

- 2026-07-03 13:59 CEST: First Claude review session `ba405de8-4fbf-4ccd-afdf-a5d3db1c7598`; `timeout` command unavailable on macOS, used bash tool timeout instead. Findings: (1) documented relative `NUSEND_DB_PATH` could resolve differently from code default under `pnpm --filter`; (2) migration runner lacked automated coverage for checksum/status/down branches; (3) minor `/health/db` 503 when no pinger supplied. Accepted and fixed findings 1 and 2. Finding 3 intentionally left as acceptable because `main.ts` always supplies a DB pinger and tests cover configured success/failure.
- 2026-07-03 14:07 CEST: Final Claude review session `82b2546f-23cc-4803-a2bd-a370a2ebecf0`; reviewer independently ran `pnpm check`, exercised migrations/schema constraints/server, and found no material blockers. Accepted non-blocking suggestion to assert schema reality in the migration integration test. Deferred non-blocking notes: `db:status` creates SQLite files because opening the DB applies WAL; source-relative repo-root anchor assumes direct TS execution; migration integration test assumes Bun is on PATH.
- 2026-07-03 14:09 CEST: Final review follow-up confirmed the schema table assertions are correct, `pnpm check` passes, and final verdict remains: no material blockers.

## Summary

Implement Nusend's first concrete service foundation: a minimal Hono API, Bun SQLite connection helpers, a custom same-file `up`/`down` migration runner, and one initial SQL migration containing the currently planned core schema from `PROJECT.md`.

This phase intentionally does **not** implement auth, send flows, SES, SNS signature verification, queue workers, unsubscribe handling, CLI commands, or domain CRUD APIs beyond health checks.

## Confirmed Requirements

- Build on the existing pnpm monorepo skeleton.
- Add a very basic API starting point in `apps/service`.
- Use Hono for HTTP routing.
- Use Bun runtime and Bun's built-in `bun:sqlite` client.
- Add DB connection logic.
- Add a migrations folder with a nested `sql` folder.
- Add a custom migration script.
- Migration SQL files must support `UP` and `DOWN` migrations in the same file.
- Add one `.sql` file containing migrations for all currently planned core tables.
- Do not add auth yet. Auth will follow soon and is intentionally out of scope.
- Keep implementation lean: no ORM, no migration package, no unused runtime dependencies, no premature shared packages.

## Assumptions and Scope Decisions

- Runtime commands may use `bun`; package/workspace management remains `pnpm`.
- This phase can add concrete `apps/service/src/` files; the earlier “no `src/`” rule only applied to the base skeleton setup.
- “All tables we'll need” is interpreted as the core table set already described in `PROJECT.md`:
  - `templates`
  - `mailings`
  - `deliveries`
  - `contacts`
  - `lists`
  - `list_memberships`
  - `suppressions`
  - `jobs`
  - `send_attempts`
  - `ses_events`
- The implementation should keep these in one initial migration file because the user explicitly asked for “a `.sql` file”. Tradeoff: rolling back migration `0001` drops all initial tables. Future migrations should be smaller and per concern.
- No `users`, `api_keys`, `sessions`, or permission tables are added yet.
- Asset/R2 tables are deferred because `PROJECT.md` describes asset handling conceptually but does not define a required schema yet.
- IDs should be opaque `TEXT` IDs generated by app code, not sequential public IDs. Use `crypto.randomUUID()` later rather than adding an ID package.
- Emails should be trimmed/lowercased by application code before writes, and email columns involved in matching/suppression should use `COLLATE NOCASE` as a DB-level defense against case-only mismatches.

## Research Findings

### Bun SQLite

Sources:

- <https://bun.sh/docs/runtime/sqlite>
- <https://www.sqlite.org/pragma.html>
- <https://www.sqlite.org/wal.html>

Findings:

- Bun exposes SQLite through built-in `bun:sqlite`; no npm package is needed.
- `new Database(path, { create: true, strict: true })` is appropriate:
  - `create: true` creates missing DB files.
  - `strict: true` makes named binding safer by throwing on missing params and allowing unprefixed bind keys.
- `db.run()` / `db.exec` can execute multi-statement SQL, so migration sections can be executed without fragile semicolon splitting.
- `db.transaction(fn)` wraps synchronous work and rolls back on thrown errors; `.immediate()` is available for immediate writer-lock acquisition.
- WAL is recommended by Bun docs and enabled with `PRAGMA journal_mode = WAL;`.
- `PRAGMA foreign_keys = ON;` is connection-scoped and is a no-op inside a transaction, so it must run immediately after opening the DB and before migration transactions.
- `PRAGMA busy_timeout = <ms>;` helps with lock contention.
- SQLite docs recommend `PRAGMA trusted_schema = OFF;` for most applications.
- SQLite `PRAGMA user_version` exists, but same-file up/down migrations with checksums and named files are better served by a small `schema_migrations` table.

Plan impact:

- Add a small DB module that opens the DB, creates parent directories, applies pragmas, and returns a Bun `Database` instance.
- Use explicit migration metadata instead of an external migration tool.
- Execute each migration inside a synchronous transaction after connection pragmas are applied.

### Hono on Bun

Sources:

- <https://hono.dev/docs/getting-started/bun>
- <https://hono.dev/docs/api/hono>
- <https://bun.sh/docs/runtime/http/server>

Findings:

- Hono supports Bun directly.
- A minimal app uses `new Hono()` and route handlers like `app.get('/health', ...)`.
- Hono apps can be exercised via `app.fetch(request)` without starting a network listener.
- Bun can serve the app explicitly via `Bun.serve({ port, fetch: app.fetch })`.

Plan impact:

- Add `apps/service/src/app.ts` exporting `createApp()`.
- Add `apps/service/src/main.ts` as the Bun server entrypoint using `Bun.serve()`.
- Keep the API intentionally small: health endpoints only.

### Vitest and Bun-specific modules

Sources:

- <https://vitest.dev/guide/>
- <https://bun.sh/docs/runtime/sqlite>

Findings:

- Vitest remains the project test tool, but the current repo config runs tests in a Node environment.
- Node-based Vitest cannot directly import Bun-only modules such as `bun:sqlite`.

Plan impact:

- Keep Vitest for pure logic and Hono `app.fetch()` tests that do not import Bun-only DB modules.
- Factor the migration file parser into a pure module and test it with Vitest.
- For DB/migration integration behavior, either:
  - use Vitest to spawn Bun subprocesses against a temp DB, or
  - use explicit Bun smoke commands in the verification step.
- Do not silently add Bun-only tests that are picked up by the existing Vitest glob.

## Current Codebase Findings

- Root tooling exists:
  - `package.json`
  - `pnpm-workspace.yaml`
  - `tsconfig.base.json`
  - `.oxlintrc.json`
  - `.oxfmtrc.json`
  - `vitest.config.ts`
- Current service package is intentionally minimal:
  - `apps/service/package.json` only has `typecheck`.
  - `apps/service/tsconfig.json` currently has `files: []` and must be changed now that source files are added.
- `PROJECT.md` Phase 1 calls for Hono server, config/env loading, SQLite connection, migrations, and a health endpoint.
- Existing `.gitignore` ignores SQLite files and sidecars, but not a dedicated local data directory.

## Chosen Strategy

Use a small hand-written service foundation:

- Add only `hono` as a runtime dependency for `@nusend/service`.
- Use Bun's built-in `bun:sqlite`; no DB driver package, ORM, schema builder, or migration framework.
- Add a custom migration runner under `apps/service/src/db/`.
- Store migration SQL files under `apps/service/src/db/migrations/sql/`.
- Use migration file markers:

```sql
-- migrate:up
-- SQL statements for applying the migration

-- migrate:down
-- SQL statements for rolling the migration back
```

- Track applied migrations in a `schema_migrations` table.
- Apply migrations lexicographically by filename.
- Roll back the latest applied migration by default.
- Keep the API unauthenticated and low-risk: only `/health` and `/health/db` for now.

Why this strategy:

- It matches the project's lean direction.
- It satisfies the custom migration requirement without package sprawl.
- It leaves clear seams for soon-to-follow auth middleware without designing auth prematurely.
- It keeps the CLI separate and avoids shared packages.

## Intentional Deviations / Deferrals from `PROJECT.md`

- `PROJECT.md` shows `db/schema.sql`; this plan uses migrations as the schema source of truth and does not add a duplicate `schema.sql` yet.
- `PROJECT.md` shows `db/migrations/`; this plan uses `db/migrations/sql/` to keep SQL migration files separated from migration TypeScript code.
- `PROJECT.md` mentions pnpm catalogs as useful when dependencies are shared. Since `hono` is initially used only by `apps/service`, do not introduce catalogs yet.
- `apps/cli` remains unchanged in this phase; CLI commands come after service APIs exist.

## Alternatives Considered

### External migration tool

Rejected. Tools like Drizzle Kit, Kysely migrations, or Knex would add dependencies and conventions before Nusend needs them. The user explicitly asked for a custom migration script.

### `PRAGMA user_version` only

Rejected as the primary migration tracker. `user_version` is useful for a single integer schema version, but same-file up/down migrations with checksums and named files are more robust with a tiny `schema_migrations` table.

### ORM or query builder

Rejected. This phase only needs connection setup and migrations. An ORM would be premature.

### Auto-run migrations on API startup

Rejected. Migrations should be explicit (`pnpm --filter @nusend/service db:migrate`) so production startup does not unexpectedly mutate schema.

### Add auth placeholders now

Rejected. The user explicitly said auth follows soon and is not part of this step. Do not add fake `users`, `api_keys`, or no-op auth middleware yet.

### Split the initial schema into several migration files

Technically cleaner, but rejected for this phase because the user explicitly asked for a `.sql` file containing all needed tables. Future changes should be split into smaller migration files.

## Implementation Plan

### Step 1: Add service runtime dependency and scripts

Update `apps/service/package.json`:

- Add dependency:
  - `hono`
- Add scripts:
  - `dev`: `bun --hot src/main.ts`
  - `start`: `bun src/main.ts`
  - `db:migrate`: `bun src/db/migrate.ts up`
  - `db:rollback`: `bun src/db/migrate.ts down`
  - `db:status`: `bun src/db/migrate.ts status`
  - Keep `typecheck`: `tsc --noEmit -p tsconfig.json`

Install with pnpm from repo root:

```sh
pnpm --filter @nusend/service add hono
```

### Step 2: Update service TypeScript config

Update `apps/service/tsconfig.json` from `files: []` to:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

Do not add build output settings yet because the app runs directly on Bun.

### Step 3: Add minimal service config module

Create `apps/service/src/config.ts`.

Responsibilities:

- Read env from `process.env` / `Bun.env`.
- Provide local-development defaults.
- Validate simple values manually without adding Zod/Valibot yet.
- Export `loadConfig()`.

Suggested config:

```ts
type ServiceConfig = {
  host: string;
  port: number;
  databasePath: string;
};
```

Env vars:

- `NUSEND_HOST`, default `0.0.0.0`
- `NUSEND_PORT`, fallback to `PORT`, default `3000`
- `NUSEND_DB_PATH`, default `.data/nusend.sqlite`

Validation:

- Port must be an integer from `1` to `65535`.
- DB path must be non-empty.

Also:

- Add `.data/` to `.gitignore`.
- Add a minimal `.env.example` now that env vars are concrete.

### Step 4: Add DB connection helper

Create `apps/service/src/db/index.ts`.

Responsibilities:

- Import `Database` from `bun:sqlite`.
- Ensure the parent directory for file-backed DB paths exists.
- Open DB with:

```ts
new Database(databasePath, { create: true, strict: true })
```

- Apply connection pragmas immediately after opening and before transactions:

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA trusted_schema = OFF;
```

Notes:

- Do not assert that `journal_mode` always becomes `wal`; `:memory:` databases remain in memory journal mode.
- Keep this module small and synchronous; Bun SQLite is synchronous by design.
- Export helpers such as:
  - `openDatabase(configOrPath): Database`
  - `closeDatabase(db): void`
  - `pingDatabase(db): boolean`

Do not create repository/domain query modules yet.

### Step 5: Add migration modules and SQL folder

Create:

```txt
apps/service/src/db/migration-files.ts
apps/service/src/db/migrate.ts
apps/service/src/db/migrations/sql/0001_initial_schema.sql
```

Use this SQL file format:

```sql
-- migrate:up
-- create core tables and indexes

-- migrate:down
-- drop core tables and indexes in reverse dependency order
```

Recommendation:

- The runner creates `schema_migrations` itself before reading applied migrations.
- The initial SQL file contains product/operational tables, not the migration metadata table.

### Step 6: Add migration file parser

Create pure parsing/checksum helpers in `migration-files.ts` so they can be tested with Vitest without importing `bun:sqlite`.

Parser rules:

- Require exactly one `-- migrate:up` marker.
- Require exactly one `-- migrate:down` marker.
- `up` must come before `down`.
- Both sections must contain non-empty SQL.
- Missing/duplicate markers are errors.
- Down migrations are required for now; intentionally irreversible migrations are not supported yet.

### Step 7: Initial migration DDL details

The initial migration should create the following domain/operational tables.

Use `TEXT` timestamps with UTC defaults:

```sql
strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
```

Use `TEXT` opaque IDs generated by application code.

Use `COLLATE NOCASE` on email columns used for recipient/contact/suppression matching.

#### `templates`

Columns:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing'))`
- `subject TEXT NOT NULL`
- `html TEXT NOT NULL`
- `text TEXT`
- `created_at TEXT NOT NULL DEFAULT (...)`
- `updated_at TEXT NOT NULL DEFAULT (...)`

Indexes:

- `templates_purpose_idx` on `purpose`

No template version table and no Markdown source column.

#### `lists`

Columns:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `created_at TEXT NOT NULL DEFAULT (...)`

Indexes:

- `lists_name_idx` on `name`

Do not add `updated_at` unless list editing is implemented later.

#### `contacts`

Columns:

- `id TEXT PRIMARY KEY`
- `email TEXT NOT NULL COLLATE NOCASE`
- `attrs_json TEXT`
- `created_at TEXT NOT NULL DEFAULT (...)`
- `updated_at TEXT NOT NULL DEFAULT (...)`

Indexes:

- unique `contacts_email_idx` on `email`

Notes:

- App code still trims/lowercases emails before writes.
- Do not add contact `status`; subscription and suppression state live elsewhere.

#### `list_memberships`

Columns:

- `list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE`
- `contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE`
- `subscribed_at TEXT NOT NULL DEFAULT (...)`
- `unsubscribed_at TEXT`
- `PRIMARY KEY (list_id, contact_id)`

Indexes:

- `list_memberships_contact_id_idx` on `contact_id`
- `list_memberships_subscribed_idx` on `(list_id, unsubscribed_at)`

No separate status column.

#### `mailings`

Columns:

- `id TEXT PRIMARY KEY`
- `purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing'))`
- `state TEXT NOT NULL CHECK (state IN ('draft', 'scheduled', 'sending', 'paused', 'cancelled', 'completed'))`
- `name TEXT`
- `subject TEXT NOT NULL`
- `html TEXT NOT NULL`
- `text TEXT`
- `list_id TEXT REFERENCES lists(id) ON DELETE SET NULL`
- `scheduled_at TEXT`
- `created_at TEXT NOT NULL DEFAULT (...)`
- `updated_at TEXT NOT NULL DEFAULT (...)`

Indexes:

- `mailings_purpose_state_idx` on `(purpose, state)`
- `mailings_scheduled_at_idx` on `scheduled_at`
- `mailings_list_id_idx` on `list_id`

Notes:

- No Markdown source column.
- No `template_id` initially; template content is copied into mailings.
- Do not require `list_id` for all marketing mailings at schema level; enforce marketing policy in service logic later.

#### `deliveries`

Columns:

- `id TEXT PRIMARY KEY`
- `mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE`
- `email TEXT NOT NULL COLLATE NOCASE`
- `contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL`
- `vars_json TEXT`
- `status TEXT NOT NULL CHECK (status IN ('scheduled', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'cancelled'))`
- `ses_message_id TEXT`
- `last_error TEXT`
- `created_at TEXT NOT NULL DEFAULT (...)`
- `updated_at TEXT NOT NULL DEFAULT (...)`

Indexes:

- `deliveries_mailing_id_idx` on `mailing_id`
- `deliveries_mailing_status_idx` on `(mailing_id, status)`
- `deliveries_email_idx` on `email`
- `deliveries_contact_id_idx` on `contact_id`
- unique partial `deliveries_ses_message_id_idx` on `ses_message_id WHERE ses_message_id IS NOT NULL`

#### `suppressions`

Columns:

- `id TEXT PRIMARY KEY`
- `email TEXT NOT NULL COLLATE NOCASE`
- `scope TEXT NOT NULL CHECK (scope IN ('all', 'marketing', 'list'))`
- `list_id TEXT REFERENCES lists(id) ON DELETE CASCADE`
- `reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual'))`
- `created_at TEXT NOT NULL DEFAULT (...)`
- `CHECK ((scope = 'list' AND list_id IS NOT NULL) OR (scope IN ('all', 'marketing') AND list_id IS NULL))`

Indexes:

- `suppressions_email_idx` on `email`
- unique partial `suppressions_email_global_scope_idx` on `(email, scope) WHERE list_id IS NULL`
- unique partial `suppressions_email_list_idx` on `(email, list_id) WHERE scope = 'list'`

Notes:

- This supports the policy that marketing unsubscribes/complaints need not block transactional email.
- Case-insensitive matching is important here because suppression misses can cause unwanted marketing sends.

#### `jobs`

Columns:

- `id TEXT PRIMARY KEY`
- `kind TEXT NOT NULL CHECK (kind IN ('send_delivery', 'process_ses_event'))`
- `state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'failed', 'dead', 'cancelled'))`
- `run_at TEXT NOT NULL DEFAULT (...)`
- `attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)`
- `max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts > 0)`
- `locked_by TEXT`
- `locked_until TEXT`
- `ref_id TEXT NOT NULL`
- `last_error TEXT`
- `created_at TEXT NOT NULL DEFAULT (...)`
- `updated_at TEXT NOT NULL DEFAULT (...)`

Indexes:

- `jobs_state_run_at_idx` on `(state, run_at)`
- `jobs_locked_until_idx` on `locked_until`
- `jobs_kind_ref_id_idx` on `(kind, ref_id)`

Notes:

- No separate DLQ table; `state = 'dead'` is the DLQ.
- Do not add generic JSON payload; jobs reference domain rows via `kind + ref_id`.

#### `send_attempts`

Columns:

- `id TEXT PRIMARY KEY`
- `delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE`
- `job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE`
- `attempt_no INTEGER NOT NULL CHECK (attempt_no > 0)`
- `status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'ambiguous'))`
- `ses_message_id TEXT`
- `error_message TEXT`
- `started_at TEXT NOT NULL DEFAULT (...)`
- `finished_at TEXT`

Indexes:

- `send_attempts_delivery_id_idx` on `delivery_id`
- `send_attempts_job_id_idx` on `job_id`
- unique `send_attempts_delivery_attempt_no_idx` on `(delivery_id, attempt_no)`

#### `ses_events`

Columns:

- `id TEXT PRIMARY KEY`
- `sns_message_id TEXT NOT NULL`
- `ses_message_id TEXT`
- `event_type TEXT NOT NULL`
- `delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL`
- `raw_json TEXT NOT NULL`
- `processed_at TEXT`
- `created_at TEXT NOT NULL DEFAULT (...)`

Indexes:

- unique `ses_events_sns_message_id_idx` on `sns_message_id`
- `ses_events_ses_message_id_idx` on `ses_message_id`
- `ses_events_delivery_id_idx` on `delivery_id`
- `ses_events_event_type_idx` on `event_type`

Notes:

- Store raw JSON for audit/reprocessing.
- Do not add recipient email; mapping should use `ses_message_id` to `deliveries.ses_message_id`.

### Step 8: Add migration runner

Create `apps/service/src/db/migrate.ts`.

Responsibilities:

1. Load config.
2. Open DB with the same connection helper as the app.
3. Ensure migration metadata table exists:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

4. Read `.sql` files from `src/db/migrations/sql` in lexicographic order.
5. Parse migration sections via `migration-files.ts`.
6. Compute a checksum for the full file contents using built-in crypto APIs.
7. Commands:
   - `up`: apply all pending migrations in order.
   - `down`: roll back the latest applied migration by default.
   - `status`: print applied/pending status.
8. On `up`:
   - Refuse if an already-applied migration file's checksum changed.
   - Run the `up` SQL section in a transaction.
   - Insert into `schema_migrations` in the same transaction.
9. On `down`:
   - Find latest applied migration by filename/version order.
   - Run the `down` SQL section in a transaction.
   - Delete the metadata row in the same transaction.
10. Close DB on exit.

Hard constraints:

- All file reads and checksum work must happen outside the `db.transaction()` callback.
- The transaction callback must remain synchronous.
- Use `db.exec(sectionSql)` / `db.run(sectionSql)` for multi-statement migration SQL; verify this in implementation with a small migration smoke test.
- Exit with non-zero status on parse errors, checksum mismatch, missing files, or SQL failures.

### Step 9: Add minimal Hono app

Create `apps/service/src/app.ts`.

Responsibilities:

- Export `createApp(options?)`.
- Add health endpoints:

```txt
GET /health
GET /health/db
```

Suggested behavior:

- `GET /health` returns `200`:

```json
{ "ok": true, "service": "nusend" }
```

- `GET /health/db` runs `SELECT 1` and returns `200` if healthy, `503` if not.

Auth note:

- These endpoints are intentionally unauthenticated.
- Do not add auth middleware or placeholder auth config in this phase.

### Step 10: Add Bun server entrypoint

Create `apps/service/src/main.ts`.

Responsibilities:

- Load config.
- Open database.
- Create app with DB dependency.
- Start Bun server:

```ts
Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
```

- Log a concise startup message.

Do not auto-run migrations in `main.ts`.

### Step 11: Add tests where they fit

Use Vitest for test files picked up by the current root setup.

Recommended tests:

- `migration-files.test.ts` for marker parsing:
  - valid up/down parsing
  - missing marker
  - duplicate marker
  - empty section
  - down before up
- `app.test.ts` for `GET /health` via `app.fetch()` if `app.ts` does not import `bun:sqlite` directly.

For migration runner integration, prefer a Vitest test that spawns Bun subprocesses against a temp DB if the complexity stays reasonable:

- migrate up
- assert table presence via a Bun subprocess
- status is idempotent
- rollback down
- assert core tables are gone

If this is too much for the first implementation pass, keep the subprocess integration as explicit manual verification commands and do not pretend the migration runner is fully covered.

### Step 12: Update docs

Update `README.md` with service commands:

```sh
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service db:status
pnpm --filter @nusend/service db:rollback
pnpm --filter @nusend/service dev
```

Document env vars:

- `NUSEND_DB_PATH=.data/nusend.sqlite`
- `NUSEND_HOST=0.0.0.0`
- `NUSEND_PORT=3000`

Add `.env.example` with only those known vars.

## Files Likely to Change

- `.env.example`
- `.gitignore`
- `README.md`
- `apps/service/package.json`
- `apps/service/tsconfig.json`
- `apps/service/src/config.ts`
- `apps/service/src/app.ts`
- `apps/service/src/main.ts`
- `apps/service/src/db/index.ts`
- `apps/service/src/db/migration-files.ts`
- `apps/service/src/db/migrate.ts`
- `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
- optional tests:
  - `apps/service/src/app.test.ts`
  - `apps/service/src/db/migration-files.test.ts`
- `pnpm-lock.yaml`

## Testing and Verification Plan

Run from repo root after implementation:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

Run service DB checks:

```sh
pnpm --filter @nusend/service db:status
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service db:status
pnpm --filter @nusend/service db:rollback
pnpm --filter @nusend/service db:migrate
```

Verify table creation:

```sh
bun -e "import { Database } from 'bun:sqlite'; const db = new Database('.data/nusend.sqlite'); console.log(db.query('select name from sqlite_schema where type=\'table\' order by name').all())"
```

Smoke-test API:

```sh
pnpm --filter @nusend/service dev
curl -i http://localhost:3000/health
curl -i http://localhost:3000/health/db
```

Expected:

- `/health` returns `200`.
- `/health/db` returns `200` after DB opens successfully.
- `db:migrate` is idempotent when no pending migrations remain.
- `db:rollback` drops the initial schema and removes the metadata row for `0001`.
- `pnpm check` passes.

## Migration / Rollout Notes

- This is the initial schema; no existing production data migration is needed.
- `0001` down migration is destructive because it drops all initial tables. That is acceptable for early development but must be clear in docs/review.
- Do not auto-migrate on API startup until deployment policy is decided.
- Keep SQLite files out of git through existing `*.sqlite` ignores and planned `.data/` ignore.

## Risks and Mitigations

### Risk: Full initial schema is committed before consuming code exists

Mitigation: This follows the user's request for one SQL file containing all needed tables, but future changes should be split into smaller migrations. Keep columns/indexes close to `PROJECT.md` and avoid extra speculative tables.

### Risk: Down migration destroys local data

Mitigation: Make `db:rollback` explicit and document that the first down migration drops all initial tables.

### Risk: Suppression lookup misses due to email case differences

Mitigation: Trim/lowercase emails in application code and use `COLLATE NOCASE` on email columns involved in contact/delivery/suppression matching.

### Risk: Migration SQL parser is too clever or fragile

Mitigation: Use simple unique markers and execute the entire section with Bun SQLite. Do not split on semicolons.

### Risk: Migration runner lacks enough automated coverage

Mitigation: Test pure parser logic with Vitest and add Bun subprocess integration verification if practical. At minimum, run the explicit up/status/down/up smoke checks.

### Risk: Schema over-design

Mitigation: Stick to `PROJECT.md` core tables and avoid auth/assets/template versions/idempotency tables until their phases require them.

### Risk: Auth is coming soon

Mitigation: Keep route creation compatible with adding middleware later, but do not add placeholder auth tables or config now.

## Review Notes

Claude review was completed before finalizing this plan. Accepted changes:

- Made the full-schema-in-one-file choice explicit and documented its rollback tradeoff.
- Added DB-level email case-insensitive safeguards for contact/delivery/suppression matching.
- Strengthened migration parser/testing guidance.
- Added migration runner constraints around synchronous transactions and multi-statement execution.
- Documented intentional deviations from `PROJECT.md` (`schema.sql`, `migrations/sql`, pnpm catalogs, CLI deferral).

## Open Questions

None blocking.
