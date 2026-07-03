# Plan: Add Protected Mailings Create API

## Summary

Add the first protected domain API slice for Nusend: `POST /api/mailings`. The endpoint will accept final email content, authenticate via Better Auth session or organization-owned API key, require `mailings:create`, snapshot recipients into `deliveries`, and enqueue `send_delivery` jobs. It will **not** send through SES yet.

The slice should stay narrow: no SES worker, no template rendering, no Markdown handling, no OpenAPI, no idempotency keys, no public signup changes, no `organization_id` schema expansion, and no new runtime dependencies unless implementation uncovers a hard need.

## Confirmed Requirements and Assumptions

- Endpoint: `POST /api/mailings`.
- Authentication: existing `requirePrincipal` middleware.
- Permission: `mailings:create` for sessions and API keys.
- Input content is final `subject`, `html`, and optional `text`; Nusend still does not accept/store Markdown source.
- Persist:
  - one `mailings` row
  - one `deliveries` row per recipient candidate
  - one queued `jobs` row per non-suppressed delivery
- No SES integration in this slice.
- Keep implementation lean: Bun SQLite, Hono, TypeScript, no ORM, no validation library.
- One workspace per deployment remains the assumption, so do not add `organization_id` columns to email-domain tables now.
- Suppression behavior follows `PROJECT.md`: marketing suppressions/unsubscribes must not block transactional mail; only `scope = 'all'` blocks transactional mail.

## Research and Current-State Findings

- `apps/service/src/app.ts`
  - Currently has health routes and mounts Better Auth at `/api/auth/*`.
  - `AppOptions.auth` is currently typed as `Pick<AuthInstance, "handler">`; mailings routes need `auth.api.getSession` and `auth.api.verifyApiKey`, so this type must be widened.
- `apps/service/src/main.ts`
  - Opens SQLite, creates Better Auth, and passes only `auth` plus `pingDatabase` into `createApp`.
  - It should pass `db` too.
- `apps/service/src/auth/middleware.ts`
  - Already resolves `x-api-key` or session principals.
  - Already enforces permission sets.
  - Stores `principal` in Hono context.
- `apps/service/src/auth/permissions.ts`
  - Already defines `mailings: ["create", "read", "update", "cancel", "send"]`; no permission vocabulary change needed.
- `apps/service/src/db/index.ts`
  - `openDatabase()` already enables `PRAGMA foreign_keys = ON`, `busy_timeout`, WAL, and related pragmas.
- `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
  - Already has `mailings`, `deliveries`, `jobs`, `contacts`, `lists`, `list_memberships`, `suppressions`.
  - `mailings.state` allows `draft`, `scheduled`, `sending`, `paused`, `cancelled`, `completed`.
  - `deliveries.status` allows `scheduled`, `queued`, `sending`, `sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed`, `cancelled`.
  - `jobs.kind` allows `send_delivery`; `jobs.state` allows `queued`.
- Existing DB/auth tests run under root `vitest` on Node, so any test importing `bun:sqlite` directly must spawn a Bun subprocess. Existing patterns are in:
  - `apps/service/src/auth/middleware.test.ts`
  - `apps/service/src/auth/auth.integration.test.ts`
  - `apps/service/src/db/migrate.integration.test.ts`

## Chosen Implementation Strategy

Implement a small `mailings` feature module with pure validation, explicit SQL persistence, and a Hono route factory.

Rationale:

- Keeps domain logic testable without adding libraries.
- Reuses the existing auth middleware and permissions model.
- Preserves the current lean architecture and custom SQL schema.
- Validates the core `mailings -> deliveries -> jobs` flow before introducing SES complexity.

## API Design

### Route

```txt
POST /api/mailings
```

### Auth

Use:

```ts
requirePrincipal({
  auth,
  db,
  permissions: { mailings: ["create"] },
})
```

Accepted auth modes:

- session cookie/headers handled by Better Auth
- `x-api-key` organization-owned API key

### Request Body

```ts
type CreateMailingRequest = {
  purpose: "transactional" | "marketing";
  name?: string;
  subject: string;
  html: string;
  text?: string;
  scheduledAt?: string;
  recipients?: Array<{
    email: string;
    vars?: Record<string, unknown>;
  }>;
  listId?: string;
};
```

### Validation Rules

- Body must be a JSON object.
- `purpose` must be `transactional` or `marketing`.
- `subject` and `html` must be non-empty strings after trimming.
- `text`, if present, must be a string; blank string normalizes to `null`.
- `name`, if present, must be a string; blank string normalizes to `null`.
- `scheduledAt`, if present, must parse to a valid date; store as `new Date(value).toISOString()`.
- If `scheduledAt` is omitted, use `now` as the effective scheduled time.
- Exactly one recipient source is allowed:
  - `recipients`, or
  - `listId`.
- Transactional mailings must use `recipients` and must not use `listId`.
- Marketing mailings may use either `recipients` or `listId`.
- `recipients` must be a non-empty array when provided.
- Explicit `recipients` should have an initial maximum of `1000` to avoid accidental oversized requests; make this a module constant, not config yet.
- Normalize emails by trimming and lowercasing.
- Email validation should remain simple: require one `@`, non-empty local/domain, and no whitespace. Do not add an email validation package.
- Duplicate explicit recipients should return `400 invalid_request` because merging per-recipient `vars` is ambiguous.
- `vars`, if present, must be a non-array JSON object. Store `JSON.stringify(vars)` after ensuring serialization succeeds.

## Response Design

### Success: `201`

```json
{
  "mailing": {
    "id": "...",
    "purpose": "transactional",
    "state": "scheduled",
    "scheduledAt": "2026-07-03T12:00:00.000Z"
  },
  "counts": {
    "deliveries": 1,
    "queued": 1,
    "suppressed": 0
  }
}
```

### Errors

Keep the existing JSON error style:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "..."
  }
}
```

Use:

- `400 invalid_request` for malformed JSON and validation failures.
- `401 unauthenticated` from existing middleware.
- `403 forbidden` from existing middleware.
- `404 not_found` if `listId` does not exist.
- `422 empty_recipient_set` if a valid request resolves to no sendable recipients, including:
  - list exists but has no currently subscribed contacts
  - all recipient candidates are suppressed

`422` is preferred over `409` because this is a semantically valid request that cannot be processed into sendable work. Document this because transactional callers may see it when a single address is globally suppressed.

## Persistence Behavior

All read/resolve/write work should happen inside one SQLite `db.transaction` to guarantee atomicity and avoid partial mailings.

1. Parse, validate, and normalize request input before DB writes.
2. Compute `now = new Date().toISOString()`.
3. Compute `effectiveScheduledAt = input.scheduledAt ?? now`.
4. Inside one transaction:
   1. Resolve recipient candidates.
   2. Evaluate suppressions.
   3. Reject empty/all-suppressed sets with a domain error.
   4. Insert one `mailings` row.
   5. Insert `deliveries` rows.
   6. Insert `jobs` rows for queued deliveries only.
5. Return IDs/counts.

### Mailing Row

- `id = crypto.randomUUID()`.
- `purpose` from input.
- `state = 'scheduled'`.
- `name`, `subject`, `html`, `text` from normalized input.
- `list_id = listId ?? null`.
- `scheduled_at = effectiveScheduledAt`.

Use `scheduled_at = now` for immediate sends to avoid `state = 'scheduled'` with `scheduled_at IS NULL`.

### Explicit Recipient Resolution

For `recipients`:

- Normalize and reject duplicate emails.
- Do not auto-create contacts.
- Optionally look up matching contacts by email and set `contact_id` if present.
- Store explicit per-recipient vars in `deliveries.vars_json`.

### List Recipient Resolution

For `listId`:

- Require `purpose = 'marketing'`.
- Verify `lists.id` exists; otherwise return `404 not_found`.
- Load recipient candidates from `contacts` joined with `list_memberships` where:

```sql
list_memberships.list_id = $listId
AND list_memberships.unsubscribed_at IS NULL
```

- Use `contacts.email` and `contacts.id`.
- Set `vars_json = NULL` for now; do not automatically copy `contacts.attrs_json` into delivery vars in this slice.

### Suppression Rules

For each candidate recipient:

- `scope = 'all'` suppresses both transactional and marketing sends.
- For `purpose = 'marketing'`:
  - `scope = 'marketing'` suppresses.
  - `scope = 'list'` suppresses only when `suppressions.list_id` matches the mailing `listId`.
- For `purpose = 'transactional'`:
  - ignore `scope = 'marketing'`
  - ignore `scope = 'list'`

Implementation note:

- Prefer one suppression query per batch for candidate emails and relevant scopes, then evaluate in memory.
- Keep correctness and simplicity above clever SQL.
- Use the same normalized lowercase email values for contact/suppression lookup and delivery storage, even though DB columns also use `COLLATE NOCASE`.

### Delivery Rows

For each recipient candidate:

- `id = crypto.randomUUID()`.
- `mailing_id = mailing.id`.
- `email = normalized email`.
- `contact_id = contact ID or NULL`.
- `vars_json = JSON string or NULL`.
- `status = 'queued'` if not suppressed.
- `status = 'suppressed'` if suppressed.

### Job Rows

For each queued delivery only:

- `id = crypto.randomUUID()`.
- `kind = 'send_delivery'`.
- `state = 'queued'`.
- `run_at = effectiveScheduledAt`.
- `ref_id = delivery.id`.
- Prefer schema defaults for `attempts` and `max_attempts` unless explicit values improve clarity.

## Proposed File Changes

### New Files

- `apps/service/src/mailings/validation.ts`
  - request parsing/normalization helpers
  - validation result types
  - email normalization
  - recipient-source checks
- `apps/service/src/mailings/create-mailing.ts`
  - `createMailing(db, input)` domain service
  - SQL transaction
  - recipient resolution
  - suppression evaluation
  - delivery/job inserts
- `apps/service/src/mailings/routes.ts`
  - route factory
  - auth middleware wiring
  - JSON parsing and domain-error-to-HTTP mapping
- `apps/service/src/mailings/validation.test.ts`
  - pure Node/Vitest tests; no `bun:sqlite` import
- `apps/service/src/mailings/create-mailing.test.ts`
  - Bun-subprocess integration tests for DB behavior
- `apps/service/src/mailings/routes.test.ts`
  - Bun-subprocess route/auth integration tests
- Optional if duplication becomes noisy: `apps/service/src/testing/bun-scenario.ts`
  - shared `spawnSync("bun", [scriptPath])` helper for tests that need `bun:sqlite`

### Modified Files

- `apps/service/src/app.ts`
  - import `Database` type.
  - widen `AppOptions.auth` from `Pick<AuthInstance, "handler">` to either full `AuthInstance` or `Pick<AuthInstance, "handler" | "api">`.
  - add `db?: Database`.
  - mount mailings routes only when both `auth` and `db` are present.
  - keep health-only tests possible without auth/db.
- `apps/service/src/main.ts`
  - pass `db` into `createApp`.
- `README.md`
  - document `POST /api/mailings`, `x-api-key`, request/response shape, and `422 empty_recipient_set`.
- Possibly `PROJECT.md`
  - only if the finalized API contract should be captured there; avoid broad doc churn otherwise.

## Implementation Steps

1. Add pure validation module.
   - Define raw request and normalized input types.
   - Implement result helpers such as `{ ok: true, value } | { ok: false, code, message }`.
   - Keep it free of Hono and SQLite imports.
2. Add DB/domain service.
   - Export `createMailing(db, input)`.
   - Define domain errors for `list_not_found` and `empty_recipient_set`.
   - Keep all resolve/suppression/insert logic inside a single `db.transaction`.
3. Implement explicit recipient path.
   - Normalize emails.
   - Reject duplicates.
   - Look up existing contacts by email when straightforward.
   - Do not auto-create contacts.
4. Implement list recipient path.
   - Verify list exists.
   - Snapshot subscribed contacts only.
   - Do not copy `contacts.attrs_json` into `vars_json` yet.
5. Implement suppression evaluation.
   - Batch query candidate emails.
   - Apply `all`, `marketing`, and `list` rules in TypeScript.
6. Insert rows atomically.
   - Always set `mailings.scheduled_at` and `jobs.run_at` to `effectiveScheduledAt`.
   - Create jobs only for queued deliveries.
7. Add route factory.
   - Parse JSON safely.
   - Run validation.
   - Use `requirePrincipal({ auth, db, permissions: { mailings: ["create"] } })`.
   - Map validation/domain errors to documented HTTP responses.
8. Wire route into `createApp` and `main.ts`.
9. Add tests using the correct runtime strategy.
10. Update README.
11. Run formatting and validation.

## Testing Plan

Run:

```sh
pnpm format
pnpm check
```

### Important Test Harness Constraint

Root `pnpm test` runs `vitest` on Node. Tests that import `bun:sqlite` directly will fail at import time. Therefore:

- `validation.test.ts` can run in-process under Vitest.
- DB and route integration tests must spawn a Bun subprocess, following the existing pattern in `apps/service/src/auth/middleware.test.ts` and related tests.
- Scenario scripts should apply `0001_initial_schema.sql` and `0002_auth.sql` where needed using `parseMigrationFile`.

### Validation Tests

- Missing body fields fail.
- Invalid `purpose` fails.
- Empty `subject`/`html` fails.
- Transactional with `listId` fails.
- Both `recipients` and `listId` fail.
- Neither `recipients` nor `listId` fails.
- Duplicate explicit recipient fails.
- Invalid `scheduledAt` fails.
- Array/non-object `vars` fails.
- Blank optional `name`/`text` normalize to `null`.

### Direct DB Integration Tests

Use Bun subprocess scripts to verify:

- Transactional explicit recipient creates:
  - one `mailings` row
  - one `deliveries` row with `queued`
  - one `jobs` row with `send_delivery`
- `mailings.scheduled_at` and `jobs.run_at` equal `now`/effective time when `scheduledAt` omitted.
- Provided `scheduledAt` is stored on `mailings.scheduled_at` and `jobs.run_at`.
- Explicit recipient matching existing contact stores `contact_id`.
- Marketing list send snapshots only subscribed contacts.
- Unsubscribed list members are excluded.
- `scope = all` suppresses transactional and marketing.
- `scope = marketing` suppresses marketing only.
- `scope = list` suppresses matching-list marketing only.
- Partial suppression creates suppressed delivery rows and jobs only for queued rows.
- All-suppressed request returns domain error and writes zero rows.
- Missing list returns domain error and writes zero rows.
- Simulated mid-transaction failure leaves zero `mailings`/`deliveries`/`jobs` rows.

### HTTP/Auth Route Tests

Use Bun subprocess scripts to verify:

- No auth returns `401`.
- Invalid API key returns `401`.
- API key without `mailings:create` returns `403`.
- API key with `mailings:create` returns `201` and writes rows.
- Session principal with `mailings:create` role returns `201` and writes rows.
- Malformed JSON returns `400`.
- Invalid payload returns `400`.
- Missing list returns `404`.
- Empty/all-suppressed recipient set returns `422`.
- Response includes mailing ID/state/scheduledAt and counts.

## Manual Smoke Test

After migrating and creating an organization API key with `mailings:create`:

```sh
curl -i http://localhost:3000/api/mailings \
  -H 'content-type: application/json' \
  -H 'x-api-key: nusend_...' \
  --data '{
    "purpose": "transactional",
    "subject": "Reset your password",
    "html": "<p>Reset your password</p>",
    "text": "Reset your password",
    "recipients": [{ "email": "user@example.com" }]
  }'
```

Inspect SQLite:

```sql
SELECT id, purpose, state, scheduled_at FROM mailings ORDER BY created_at DESC LIMIT 1;
SELECT mailing_id, email, status FROM deliveries ORDER BY created_at DESC LIMIT 5;
SELECT kind, state, run_at, ref_id FROM jobs ORDER BY created_at DESC LIMIT 5;
```

## Risks and Mitigations

- **All-suppressed transactional requests return `422`**: document this for API clients; it is expected when a single recipient has `scope = all` suppression.
- **Large list sends in one transaction can become slow**: acceptable for this slice; later work can chunk list sends or move expansion to a worker.
- **No idempotency key**: duplicate client retries can create duplicate mailings. Accept now; add idempotency later.
- **No `organization_id` on domain tables**: matches the current one-workspace decision; future true multi-workspace support will need migrations.
- **No unsubscribe-link enforcement before SES sending**: creation can be allowed because this slice does not send; the future SES sender must enforce marketing unsubscribe link policy before actual delivery.
- **Duplicate recipients are rejected**: safer for personalization vars but may be friction for batch clients; can revisit later.
- **Contact lookup for explicit recipients is optional value**: useful for linking history, but if it complicates implementation, it can be skipped without breaking core behavior.

## Alternatives Considered

1. **Add SES worker now**
   - Rejected: too large. Persist/queue/auth should be proven independently.
2. **Add `organization_id` to `mailings`/`deliveries` now**
   - Rejected: conflicts with current one-workspace-per-deployment simplification.
3. **Use a validation library**
   - Rejected: current project intentionally avoids unnecessary dependencies; hand-written validation is sufficient.
4. **Silently de-duplicate recipients**
   - Rejected: ambiguous when duplicates have different `vars`.
5. **Auto-create contacts for explicit recipients**
   - Rejected: transactional recipients should not pollute contact/list data.
6. **Create audit-only all-suppressed mailings**
   - Rejected for now: produces no runnable work and adds clutter. Partial suppression still creates audit rows for the mailing.
7. **Leave `scheduled_at = NULL` for immediate sends**
   - Rejected: `state = scheduled` plus `scheduled_at = NULL` is ambiguous for future worker queries. Store the effective scheduled time consistently.

## Review Notes

This plan incorporates independent Claude review feedback, especially:

- DB/route tests must use Bun subprocesses under the current Vitest-on-Node setup.
- `AppOptions.auth` must be widened for `requirePrincipal`.
- `scheduled_at` and `job.run_at` should always be populated consistently.
- Add session-route and transaction-rollback tests.

## Implementation Progress

Status legend: `[ ]` not started, `[~]` in progress, `[x]` complete.

- [x] Read full plan before editing implementation files.
- [x] Created implementation progress tracker in this plan.
- [x] Decomposed work and inspected relevant repo context.
- [x] Used read-only subagent context/review where safe.
- [x] Implement validation module and validation tests.
- [x] Implement create-mailing domain service and DB integration tests.
- [x] Implement route factory and wire into app/main.
- [x] Add route integration tests.
- [x] Update README API docs.
- [x] Run formatting and full validation.
- [x] Perform independent review pass after major implementation.
- [x] Incorporate review feedback or document rejected/deferred feedback.
- [x] Perform final validation and final independent review.

### Implementation Notes

- Progress tracker created before implementation edits.
- Work decomposition: validation first, DB service second, route/app wiring third, docs/tests/validation last.
- Parallelism decision: implementation edits are tightly coupled, so main agent implemented sequentially. Safe read-only scout subagent ran in parallel and confirmed code context/test constraints.
- Added optional `CreateMailingOptions` test seam (`createId`, `now`) to make scheduling and rollback tests deterministic.
- Focused validation: `pnpm --filter @nusend/service typecheck` passed; `pnpm test -- apps/service/src/mailings` passed with 52 tests.
- Full validation: `pnpm format && pnpm check` passed with 52 tests.
- Independent review session `16059f2f-f9ae-4350-b87e-fe8407b41fb4` found no blockers. Addressed useful low-severity feedback by removing redundant suppression filtering logic, avoiding unused transactional query params, rewriting a suppression matrix test to use a reachable list-send input shape, and documenting persisted suppressed deliveries. Reviewer follow-up confirmed all concerns resolved. Deferred: conditional mailings route mounting when `auth + db` are present (intentional for health-only app construction); `vars: null` remains invalid because the plan requires vars, if present, to be an object.
- Final validation: `pnpm check` passed with 10 test files and 52 tests.
- Final independent review session `09b997c3-c8a0-4a07-ae71-78dd1f0b686c` found no blockers and approved shipping. Non-blocking notes: explicit marketing recipients have no list context for list-scoped unsubscribes; `vars: null` is rejected; simple email validation accepts dotless domains. These are consistent with the plan and deferred/future sender responsibilities.
