# Aggressive Nusend Cleanup and Lean Reset Plan

## Summary

Reset Nusend to a deliberately lean, single-user/self-hosted service. Because the database will be deleted and recreated, merge migrations into one clean initial schema and remove roadmap-only tables, organization/workspace support, empty packages, generated artifacts, unused columns, and broad unused permission surface.

Keep current list-based mailing support, but make it bounded and safe. Then harden the real current boundaries: request/content limits, auth output decoding/log redaction, production trusted-origin validation, and focused tests. Track idempotency and marketing-send compliance as required pre-send-worker work rather than mixing too much forward-looking machinery into the cleanup pass.

## Implementation Progress

Tracker retained in this plan per `implement-plan` workflow.

- [x] Phase 0 — Preflight baseline
  - Analysis: baseline was clean except this new plan Markdown/HTML were untracked.
  - Verification: `git status --short`; `pnpm check` passed with existing `no-await-in-loop` warnings in `apps/service/src/main.integration.test.ts`.
  - DB reset note: local DB reset is expected/acceptable after the migration rewrite.
- [x] Phase 1 — Delete obvious repo artifacts
  - Changed: deleted `apps/cli/**` and `.plans/*.html`, removed `passWithNoTests`, added `.plans/*.html` to `.gitignore`, refreshed lockfile with `pnpm install --lockfile-only`.
  - Verification: `pnpm test` passed; `pnpm check` passed with existing `main.integration.test.ts` lint warnings.
- [x] Phase 2 — Atomic auth + migration reset
  - Changed: merged auth/domain SQL into `0001_initial_schema.sql`, deleted `0002_auth.sql`, removed Better Auth org plugin/hooks/config, made API keys user-owned, simplified principals/session auth, and simplified owner bootstrap.
  - Better Auth schema check: project `auth.ts` cannot be consumed directly by Better Auth CLI; a temporary config attempt with the current user-owned plugin failed because CLI schema generation does not support the memory adapter without a supported DB adapter. Manually checked retained auth tables/columns against the previous generated schema minus organization/active-org fields and validated through auth integration tests.
  - Verification: targeted migration/auth/mailings/queue tests passed; temp DB migrate/status smoke passed.
- [x] Phase 3 — Update tests and fixtures for lean schema
  - Changed: auth/middleware/bootstrap/migration/mailings fixtures no longer seed org/member rows or `attrs_json`; API-key tests assert `referenceId === userId` and `{ mailings: ["create"] }`.
  - Verification: targeted auth/migration/mailings tests passed.
- [x] Phase 4 — Keep list support but make it bounded
  - Changed: `maxListRecipients = 5000`, batched contact and suppression lookups, added `RecipientLimitExceededError` and `422 recipient_limit_exceeded`.
  - Verification: list-at-cap, list-over-cap, and suppression batching tests passed.
- [x] Phase 5 — Add request and content limits
  - Changed: Hono `bodyLimit` on `POST /api/mailings`, field/vars size caps, route/schema tests, README limits.
  - Verification: mailings schema/routes/create tests passed.
- [x] Phase 6 — Queue/domain schema consistency cleanup
  - Changed: removed `process_ses_event` from SQL, Effect schema, and queue tests.
  - Verification: `pnpm test apps/service/src/queue` passed.
- [x] Phase 7 — Effect/auth boundary hardening
  - Changed: schema decoders for Better Auth session/API-key outputs, sanitized internal logging, friendlier config handling in migrate/bootstrap CLIs.
  - Verification: auth decoder/respond tests passed; no raw secret/error-detail logging in tests.
- [x] Phase 8 — Production/auth route hardening
  - Changed: production trusted origins must be HTTPS; auth passthrough now supports DELETE/GET/PATCH/POST/PUT.
  - Verification: config/app tests passed.
- [x] Phase 9 — Docs and final dead-code sweep
  - Changed: README/PROJECT updated for single-user current scope, user-owned API keys, DB reset, current limits, and future CLI/templates/SES/send-attempts/event work.
  - Sweep: `rg "organization|organizationId|organization_members|organizationApiKeyConfigId|templates|ses_events|send_attempts|attrs_json|process_ses_event|apps/cli" apps README.md PROJECT.md`; remaining hits are negative test assertions or intentional roadmap docs.
- [x] Major-step independent reviews
  - Phase 1 reviewed by Claude session `6e6cc9b1-fca8-4b59-94d3-3da6972ba6ed`: clean; only `PROJECT.md` stale CLI reference was carried to docs phase and fixed.
- [x] Final validation and final independent review
  - Final validation: `pnpm check` passed (20 files / 114 tests; only existing `main.integration.test.ts` no-await-in-loop warnings), temp DB `db:migrate` + `db:status` passed, service boot smoke on temp DB returned `/health` OK.
  - Final Claude review in session `6e6cc9b1-fca8-4b59-94d3-3da6972ba6ed`: no blockers; suggested documenting the intentional session permission bypass, which was added in `apps/service/src/auth/middleware.ts`; session access is already pinned by middleware/mailings route tests.
  - Accepted/deferred reviewer notes: real session/accounts/verifications Better Auth round-trip remains manually mitigated by retained schema comparison plus API-key integration coverage; 5000-row transaction and idempotency remain deferred to send-worker/scale phases; raw `auth.handler` Promise passthrough remains low-value optional cleanup.

### Review / deviation log

- Deviation: Better Auth CLI schema generation could not complete with the project function export or a temporary memory-adapter config; used manual schema comparison plus integration/migration validation instead.
- Human checkpoints: no blocking ambiguity; destructive DB reset was already approved by the plan/user constraints.

## Confirmed decisions

- Remove Better Auth organizations/workspaces for now.
- Delete/recreate the DB; migrations may be merged and rewritten.
- Keep `listId` mailing support.
- Keep the implementation as lean as possible: only current working features in live schema/code.
- Address all audit findings, but stage future-send-specific work separately where appropriate.

## Important strategy correction from plan review

Schema and auth cleanup are coupled and must be treated as one atomic implementation boundary. Dropping organization tables/columns while old auth code still references them would break logins and tests. Therefore, the merged migration rewrite and Better Auth organization removal should land together, with full validation only after both are complete.

## Current-state findings

### Repo cleanup

- `apps/cli` is only a placeholder package with no source/tests.
- Root Vitest uses `passWithNoTests: true`, which hides accidental empty test runs.
- `.plans/*.html` are generated duplicates of Markdown plans.

### Auth/org cleanup

Current code uses Better Auth organizations even though the product is currently single-user per instance:

- `apps/service/src/auth/auth.ts` imports and configures `organization()`.
- `apps/service/src/auth/permissions.ts` defines broad org roles/resource permissions.
- `apps/service/src/auth/middleware.ts` resolves organizations and member roles.
- `apps/service/src/auth/bootstrap.ts` creates users, organizations, and members.
- `apps/service/src/auth/schema.ts` maps organization and active organization fields.
- `apps/service/src/db/migrations/sql/0002_auth.sql` creates organization tables.

Critical removal details:

- Remove the Better Auth session `databaseHooks.session.create.before` hook in `auth.ts`; it writes `activeOrganizationId` and queries organization members.
- Remove `findSingleOrganizationForUser()` and `singleOrganizationForUserSql` from `auth.ts`.
- Remove imports/usages of `singleOrganizationForUserSql` in middleware.
- Define the post-org session authorization rule explicitly: in a single-user instance, a valid session principal is the owner and is granted all implemented session permissions.
- API keys become user-owned Better Auth API keys. Their `referenceId` is the owning `userId`.
- API-key creation in tests/bootstrap utilities must explicitly grant `{ mailings: ["create"] }`, otherwise keys default to no permissions and protected mailings requests will 403.

### Schema cleanup

Currently there are two migrations:

- `0001_initial_schema.sql`
- `0002_auth.sql`

Current code actively needs only:

- Better Auth user/session/account/verification/API-key tables
- `lists`, `contacts`, `list_memberships`, `suppressions`
- `mailings`, `deliveries`, `jobs`

Roadmap-only or unused tables to remove from live schema:

- `templates`
- `send_attempts`
- `ses_events`
- `organizations`
- `organization_members`
- `organization_invitations`

Unused or misleading columns to remove:

- `contacts.attrs_json` unless list personalization is implemented now
- `sessions.active_organization_id`
- SES-specific columns from current tables if no current code uses them, e.g. `deliveries.ses_message_id`, `deliveries.last_error`

### List support risks

List sends are kept, but current implementation is unsafe at scale:

- list recipients are uncapped
- all list recipients are loaded into memory
- suppression lookup builds one large `IN (...)` query
- inserts happen per-row inside one transaction

### Auth/Effect boundary issues

- Better Auth API results are cast, not decoded.
- Raw third-party auth causes may be pretty-logged and leak sensitive details.
- `AuthService.handler` returns raw `Promise<Response>` while other methods return Effects.
- CLI config errors are less polished than service startup errors.

## Research findings

### Better Auth API-key ownership

Better Auth API Key plugin defaults to user-owned keys. Organization ownership only applies when `references: "organization"` is configured.

Sources:

- https://www.better-auth.com/docs/plugins/api-key
- https://www.better-auth.com/docs/plugins/api-key/advanced
- local package source for `@better-auth/api-key@1.6.23`

Implementation implication:

- Remove `references: "organization"`.
- Remove `organizationApiKeyConfigId` or replace with a non-org config only if there is a concrete reason.
- Treat verified key `referenceId` as `userId`.

### Hono body limits

Hono 4.12.27 includes `bodyLimit` middleware from `hono/body-limit` with `{ maxSize, onError }`.

Local evidence:

- `node_modules/.pnpm/hono@4.12.27/node_modules/hono/dist/types/middleware/body-limit/index.d.ts`

Implementation implication:

- Use `bodyLimit` on `POST /api/mailings` before parsing JSON.

## Chosen implementation strategy

Use a reset-clean strategy:

1. Remove empty/generated repo artifacts first.
2. Atomically rewrite auth + schema into one lean single-user design.
3. Keep list support, but add hard caps and batching.
4. Add request/content limits.
5. Harden auth/Effect boundaries.
6. Update docs/tests and perform a final dead-code sweep.
7. Track idempotency and marketing-send compliance as pre-send-worker phases.

## Alternatives considered

### Keep Better Auth organizations and enforce exactly one org

Rejected. The user approved removing orgs, and keeping them retains real complexity without current product value.

### Keep all roadmap tables because they are in `PROJECT.md`

Rejected. Roadmap belongs in docs and future migrations, not in current live schema.

### Remove list support temporarily

Rejected. The user wants list support kept. The plan instead adds a cap and batching.

### Add idempotency immediately in the cleanup wave

Deferred from the core cleanup wave. Idempotency is important before real email delivery, but with no SES sender yet it protects future double-send behavior more than current cleanup. It should be planned now and implemented before/with the send worker unless the user wants it in this cleanup wave too.

### Narrow every lifecycle enum to only values used today

Partially rejected. Removing tables/columns/indexes is valuable leanness. Over-narrowing lifecycle vocabularies that the near-term send worker will immediately need may create churn. The plan removes enum values tied to removed features, but keeps near-term lifecycle states where they are part of the mail/queue domain and expected soon.

## Target architecture after cleanup

### Single-user auth model

Principal types:

```ts
type SessionPrincipal = {
  kind: "session";
  userId: string;
};

type ApiKeyPrincipal = {
  apiKeyId: string;
  kind: "api_key";
  permissions: Record<string, string[]>;
  userId: string;
};
```

Authorization:

- session principal = owner = allowed for implemented session-protected operations
- API key principal = checked through stored API-key permissions
- current implemented permission surface: `mailings:create`

API keys:

- user-owned Better Auth API keys
- `referenceId` = `userId`
- generated prefix remains `nusend_`
- API keys used for `POST /api/mailings` must include `{ mailings: ["create"] }`

### Lean migration model

One SQL migration:

`apps/service/src/db/migrations/sql/0001_initial_schema.sql`

Remove:

- `apps/service/src/db/migrations/sql/0002_auth.sql`

Keep current-feature tables:

- `users`
- `sessions`
- `accounts`
- `verifications`
- `api_keys`
- `lists`
- `contacts`
- `list_memberships`
- `suppressions`
- `mailings`
- `deliveries`
- `jobs`

Remove current-roadmap tables:

- `templates`
- `send_attempts`
- `ses_events`
- all organization tables

Recommended enum/check approach:

- Drop `jobs.kind = 'process_ses_event'` because SES event processing table/code is removed.
- Keep `jobs.kind = 'send_delivery'`.
- For states/statuses, prefer a balanced approach:
  - remove clearly unused/cancel-only values if no current or next-step code uses them
  - keep near-term delivery lifecycle values if the send worker is expected soon and tests/docs already model them
  - do not over-narrow if it guarantees an immediate follow-up migration for no behavioral win

## Implementation phases

## Phase 0 — Preflight baseline

Tasks:

1. Run:
   - `git status --short`
   - `pnpm check`
2. Confirm local DB reset expectation in implementation notes.
3. If local `.data/nusend.sqlite` exists, plan to delete it after migration rewrite.

Acceptance:

- Baseline result is known before cleanup begins.

## Phase 1 — Delete obvious repo artifacts

Tasks:

1. Delete empty CLI package:
   - `apps/cli/package.json`
   - `apps/cli/tsconfig.json`
   - `apps/cli/`
2. Update workspace references if needed:
   - `pnpm-workspace.yaml`
   - `pnpm-lock.yaml` after install/update if package removal affects lockfile
3. Remove `passWithNoTests: true` from `vitest.config.ts`.
4. Delete generated HTML plan artifacts:
   - `.plans/*.html`
5. Decide whether to ignore future generated plan HTML in `.gitignore`.

Validation:

- `pnpm test` still discovers service tests after removing `passWithNoTests`.
- `pnpm check` after package/workspace cleanup.

Acceptance:

- No empty CLI package remains.
- Empty test runs no longer pass silently.
- Generated HTML artifacts are not tracked project source.

## Phase 2 — Atomic auth + migration reset

This phase must be one implementation boundary. Intermediate states are expected to fail until both schema and auth code are updated.

### 2A. Rewrite migrations

Tasks:

1. Replace `0001_initial_schema.sql` with a single merged initial schema.
2. Delete `0002_auth.sql`.
3. Include only current tables listed above.
4. Remove organization tables and active organization column.
5. Remove roadmap tables:
   - `templates`
   - `send_attempts`
   - `ses_events`
6. Remove unused columns:
   - `contacts.attrs_json`
   - `deliveries.ses_message_id` if no current code uses it
   - `deliveries.last_error` if no current code uses it
7. Keep indexes only for current query paths:
   - contacts unique email
   - list memberships by list/subscription and contact
   - suppression lookup/uniqueness
   - mailing lookup/scheduling indexes if current/near-term tests query them
   - delivery mailing/status/email indexes if useful for current route assertions or near-term send worker
   - job claim/release indexes
   - Better Auth API-key lookup indexes

### 2B. Remove Better Auth org integration

Tasks:

1. `apps/service/src/auth/auth.ts`
   - remove `organization` plugin import and config
   - remove `databaseHooks.session.create.before`
   - remove `findSingleOrganizationForUser()`
   - remove `singleOrganizationForUserSql`
   - remove `organizationApiKeyConfigId`
   - configure user-owned `apiKey({ defaultPrefix: "nusend_", ... })`
2. `apps/service/src/auth/schema.ts`
   - remove `organizationSchema`
   - remove `activeOrganizationId` mapping from session schema
3. `apps/service/src/auth/permissions.ts`
   - remove `createAccessControl`, `authRoles`, org role permissions
   - define only implemented API-key permissions, currently `mailings:create`
4. `apps/service/src/auth/principal.ts`
   - simplify to user/session and API-key/user principals
5. `apps/service/src/auth/middleware.ts`
   - remove DB dependency for auth/session principal resolution
   - remove organization/member lookup
   - session principal: valid session => owner access
   - API-key principal: verify key, require `mailings:create` for mailing route
6. `apps/service/src/services/auth.ts`
   - remove `activeOrganizationId` from session data type
   - keep `referenceId` in API-key verification as user id
7. `apps/service/src/services/auth-live.ts`
   - call `verifyApiKey` without org config id
   - update imports
8. `apps/service/src/auth/bootstrap.ts`
   - create/update owner user only
   - remove `--workspace` and `--slug`
   - new command: `auth:bootstrap --email <email> --name <name> [--force]`
   - optional: add `--create-api-key --api-key-name <name>` if desired, but do not add if it complicates the cleanup
9. Test helpers:
   - replace `seedOwner` with `seedUser`
   - remove organization/member seed code
   - API-key integration tests create user-owned key with `userId` and permissions `{ mailings: ["create"] }`

### 2C. Verify Better Auth schema compatibility

Tasks:

1. Run Better Auth schema generation for the current config if available, e.g. `npx @better-auth/cli generate` or the project-appropriate Better Auth CLI command.
2. Diff generated expected auth tables against the hand-written merged `0001` schema.
3. Ensure no required Better Auth columns were accidentally removed from:
   - `users`
   - `sessions`
   - `accounts`
   - `verifications`
   - `api_keys`

Validation:

- delete/recreate temp DB
- `pnpm --filter @nusend/service db:migrate`
- migration integration tests
- auth tests
- mailings route tests
- `pnpm check`

Acceptance:

- Exactly one migration remains.
- Fresh DB schema is lean and org-free.
- Better Auth login/session/API-key paths still work.
- Protected mailings route works with session and user-owned API key.

## Phase 3 — Update tests and fixtures for lean schema

Tasks:

1. Update migration tests expected table list and column assertions.
2. Remove test inserts into deleted org tables.
3. Remove `attrs_json` from contact seed inserts.
4. Update auth middleware tests:
   - no auth => 401
   - invalid API key => 401
   - valid API key without `mailings:create` => 403
   - valid API key with `mailings:create` => allowed
   - valid session => allowed as owner
5. Update auth integration test:
   - migrated Bun DB
   - seed user
   - create user-owned API key
   - verify user-owned API key
6. Update bootstrap tests:
   - creates user only
   - refuses duplicate owner unless force if that invariant remains
   - no org/member assertions
7. Update mailing route tests to use simplified auth fake and/or user-owned API-key behavior.

Validation:

- targeted auth/migration/mailings tests
- `pnpm check`

Acceptance:

- Tests assert the simplified design, not deleted org behavior.

## Phase 4 — Keep list support but make it bounded

Tasks:

1. Add constants:
   - `maxExplicitRecipients = 1000` remains
   - `maxListRecipients`, choose a clear initial cap such as 5000 or 10000
   - `suppressionBatchSize`, safely below SQLite variable limits, e.g. 500 or 1000
2. In list recipient resolution:
   - query `LIMIT maxListRecipients + 1`
   - if more than max, fail with a typed `RecipientLimitExceededError`
   - return stable HTTP error: recommend `422 recipient_limit_exceeded`
3. Batch suppression lookup for all recipient sources:
   - split emails into chunks
   - run suppression query per chunk
   - merge into a single `Set`
4. Batch explicit contact lookup if simple, even though explicit recipients are capped.
5. Keep per-row inserts for now after capping; set-based insertion can be a later performance optimization.
6. Add tests:
   - list at cap succeeds
   - list over cap fails with `422 recipient_limit_exceeded`
   - suppression batching works across multiple chunks
   - explicit recipient behavior unchanged

Validation:

- `pnpm test apps/service/src/mailings`
- driver parity if affected
- `pnpm check`

Acceptance:

- List sends cannot exceed configured cap.
- Large suppression lookups cannot exceed SQLite bind limits.

## Phase 5 — Add request and content limits

Tasks:

1. Add Hono `bodyLimit` middleware to `POST /api/mailings`.
2. Return stable `413 request_too_large` error envelope on overflow.
3. Add schema max lengths:
   - `subject`
   - `name`
   - `html`
   - `text`
   - `email`
   - `listId`
   - serialized `vars`
4. For `vars`, validate post-`JSON.stringify` size.
5. Add route/schema tests:
   - body too large => 413
   - oversized subject/html/text/name/vars => 400 invalid_request
   - valid existing requests still pass
6. Document limits in README.

Validation:

- mailings schema/route tests
- `pnpm check`

Acceptance:

- Oversized requests are rejected before expensive processing.
- Oversized fields are rejected at the schema boundary.

## Phase 6 — Queue/domain schema consistency cleanup

Tasks:

1. Update `apps/service/src/queue/schema.ts` to match the merged migration.
2. Remove `process_ses_event` kind from code/tests because SES event table/code is removed.
3. Decide state vocabulary carefully:
   - remove only values that are definitely not current or near-term
   - avoid churn from removing lifecycle values that the send worker will immediately need
4. Update queue tests to match retained states/kinds.
5. Keep `queue/runner.ts` because queue primitives are current implemented foundation and already tested.

Validation:

- queue tests
- driver parity test
- `pnpm check`

Acceptance:

- Runtime schema, Effect schemas, and tests agree.

## Phase 7 — Effect/auth boundary hardening

Tasks:

1. Decode Better Auth outputs in `AuthLive`:
   - minimal `Schema` for consumed session fields
   - minimal `Schema` for consumed API-key verification fields
   - decode only app-relevant fields
   - map decode failures to `AuthError`
2. Sanitize auth error logging:
   - avoid `Cause.pretty` of raw third-party auth causes in production paths
   - log operation and safe message/class only
   - ensure raw API key values are not logged
3. Optional cleanup: convert `AuthService.handler` to return `Effect.Effect<Response, AuthError>` and update `app.ts` passthrough.
4. Improve config error handling in CLIs:
   - `db/migrate.ts`
   - `auth/bootstrap.ts`
   - use same friendly style as `main.ts`
5. Add tests:
   - malformed auth API shape becomes controlled internal error
   - raw API key is not logged on auth failure
   - CLI invalid config produces friendly error if practical

Validation:

- auth tests
- HTTP/respond tests
- config/migrate/bootstrap tests
- `pnpm check`

Acceptance:

- Auth boundary is typed and redacted.

## Phase 8 — Production/auth route hardening

Tasks:

1. In config validation, reject non-HTTPS `NUSEND_AUTH_TRUSTED_ORIGINS` in production, with explicit localhost/loopback exception only if desired.
2. Reconsider Better Auth passthrough methods:
   - current route exposes `GET` and `POST`
   - Better Auth integrations commonly expose `GET`, `POST`, `PATCH`, `PUT`, `DELETE`
   - after org plugin removal, method coverage is lower risk, but forwarding all standard methods is simple and future-safe
3. Add config tests for trusted origins in production.
4. Add passthrough test if route method list changes.

Validation:

- config tests
- app/auth route tests
- `pnpm check`

Acceptance:

- Production auth origin config cannot accidentally trust plain HTTP origins.

## Phase 9 — Docs and final dead-code sweep

Tasks:

1. Update README:
   - remove CLI docs if CLI is deleted
   - update bootstrap command signature
   - explain single-user per instance
   - explain user-owned API keys
   - document mailings limits
   - document DB reset after migration rewrite
2. Update `PROJECT.md`:
   - distinguish current implementation from roadmap
   - mark templates, SES events, send attempts, CLI, unsubscribe, SES sending as future phases
   - ensure removed current schema is not described as already implemented
3. Run dead-code/concept searches:
   - `rg "organization|organizationId|organization_members|organizationApiKeyConfigId|templates|ses_events|send_attempts|attrs_json|process_ses_event" apps README.md PROJECT.md`
4. For remaining hits:
   - remove if stale implementation references
   - keep only intentional roadmap docs
5. Trim exported internal-only types where simple:
   - `AuthOptions` if not imported elsewhere
   - `ErrorBody` if not imported elsewhere
   - principal subtypes if only used through union
   - option/result types that are implementation-local
6. Run final validation:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm check`
   - fresh DB migrate smoke
   - service boot smoke

Acceptance:

- Deleted concepts are absent from code except intentional roadmap docs.
- Full validation passes.

## Phase 10 — Pre-send-worker required work

This phase addresses important audit findings that become critical once real SES sending exists. It can be separate from the cleanup PR/implementation wave, but should happen before sending email.

### 10A. Idempotency

Tasks:

1. Add mailing creation idempotency before real send worker is active.
2. Use `Idempotency-Key` header.
3. Add table such as:

```sql
CREATE TABLE mailing_idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (...)
);
```

4. Same key + same normalized request returns existing mailing result.
5. Same key + different normalized request returns `409 idempotency_conflict`.
6. Handle concurrency explicitly:
   - if concurrent insert loses primary-key race, catch conflict, re-read stored row, compare hash, and return/conflict accordingly
   - do not surface DB uniqueness error as 500
7. Consider not storing `response_json`; re-derive response from `mailing_id` if simple.
8. Tests:
   - retry same key/body does not duplicate rows/jobs
   - same key/different body conflicts
   - concurrent same-key behavior if practical

### 10B. Marketing send compliance

Tasks:

1. Before actual SES delivery, implement send-time guard for marketing mailings.
2. Marketing delivery requires:
   - generated unsubscribe URL
   - unsubscribe processing route/page
   - suppression update on unsubscribe
   - `List-Unsubscribe` header where applicable
3. Do not rely only on create-mailing validation; enforce at send worker boundary.
4. Tests:
   - marketing delivery without unsubscribe support refuses to send
   - transactional delivery unaffected

Acceptance:

- API retries cannot cause duplicate real sends.
- Marketing delivery cannot happen without unsubscribe safety.

## Files likely to change

### Delete

- `apps/cli/**`
- `.plans/*.html`
- `apps/service/src/db/migrations/sql/0002_auth.sql`

### Rewrite/substantial changes

- `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
- `apps/service/src/auth/auth.ts`
- `apps/service/src/auth/schema.ts`
- `apps/service/src/auth/permissions.ts`
- `apps/service/src/auth/principal.ts`
- `apps/service/src/auth/middleware.ts`
- `apps/service/src/auth/bootstrap.ts`
- `apps/service/src/services/auth.ts`
- `apps/service/src/services/auth-live.ts`
- `apps/service/src/mailings/schema.ts`
- `apps/service/src/mailings/create-mailing.ts`
- `apps/service/src/mailings/routes.ts`
- `apps/service/src/queue/schema.ts`
- `apps/service/src/errors.ts`
- `apps/service/src/http/respond.ts`
- `apps/service/src/testing/*`
- `apps/service/src/**/*.test.ts`
- `README.md`
- `PROJECT.md`
- `vitest.config.ts`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml` if package graph changes

## Validation checklist

Run at the final boundary:

```sh
git status --short
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service db:status
```

Also run targeted checks during implementation:

```sh
pnpm test apps/service/src/db
pnpm test apps/service/src/auth
pnpm test apps/service/src/mailings
pnpm test apps/service/src/queue
```

## Risks and mitigations

### Risk: hand-written Better Auth schema drifts from expected schema

Mitigation:

- run Better Auth schema generation and diff against merged migration
- keep all required Better Auth columns for configured plugins

### Risk: session auth becomes under-authorized after removing roles

Mitigation:

- explicitly define session principal as owner/all-current-permissions
- test session access to `POST /api/mailings`

### Risk: API keys default to no permissions

Mitigation:

- update bootstrap/test key creation to grant `{ mailings: ["create"] }`
- test valid key with permission succeeds and missing permission fails

### Risk: schema/auth phases fail mid-way

Mitigation:

- implement schema rewrite and auth org removal atomically
- validate only after combined phase

### Risk: cleanup removes roadmap clarity

Mitigation:

- move roadmap details to `PROJECT.md`
- future features add their own migrations when implemented

### Risk: list support remains internally seeded only

Mitigation:

- keep list support because requested
- document that list/contact management APIs are future work
- cap list size to avoid unsafe behavior now

## Recommended implementation order

1. Repo artifact/package cleanup.
2. Atomic migration rewrite + org removal.
3. Test/fixture repair for lean schema/auth.
4. List cap and suppression batching.
5. Body/content limits.
6. Queue/domain schema consistency.
7. Auth/Effect boundary hardening.
8. Production trusted-origin and auth method hardening.
9. Docs and dead-code sweep.
10. Pre-send-worker idempotency and marketing compliance.

## Open questions

None blocking.

Implementation defaults assumed:

- user-owned API keys
- session principal is the instance owner
- no organization tables or active organization fields
- keep list support with a hard cap
- defer idempotency to pre-send-worker unless the user wants it in the cleanup wave
