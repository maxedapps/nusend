# Add Contact, List, and Suppression Management APIs Plan

## Summary

Implement one milestone that makes Nusend's recipient-management model usable through the HTTP API, while doing the small cleanup discovered during the `PROJECT.md` review.

The milestone should add protected JSON APIs for:

- contact CRUD
- list CRUD
- list membership import/subscribe/unsubscribe/resubscribe
- manual suppression listing/creation/deletion

It should also clean up current documentation/test fragility:

- fix `PROJECT.md` route/repository-shape drift
- clarify SES feedback wording so it does not imply delivery status updates
- add missing unsubscribe env vars to `.env.example`
- make migration integration tests reliable under `pnpm check`

Do not add templates, assets/R2, OpenAPI, CLI/SDK, admin UI, analytics, queue mutation APIs, or schema-level contact attributes in this milestone.


## Implementation Progress

Started: 2026-07-08T16:45:23+02:00

Tracker rules: retained in this plan per `implement-plan`; update after each loop with analysis, planned action, changed files, verification, browser/manual status, review feedback, deviations, and checkpoints.

### Overall Status

- [x] Read full plan before editing source files.
- [x] Created retained progress tracker.
- [x] Phase 1 — cleanup foundation.
- [x] Phase 2 — shared validation and permissions.
- [x] Phase 3 — contacts domain and routes.
- [x] Phase 4 — lists and memberships domain/routes.
- [x] Phase 5 — suppressions domain/routes.
- [x] Phase 6 — integration and docs polish.
- [x] Final validation (`pnpm check`).
- [x] Independent final review complete.

### Loop Log

#### Loop 0 — Intake / decomposition

- **Analyze:** Full plan read from `.plans/add-contact-list-suppression-management.md`. Current git status shows the plan file is untracked; source tree otherwise initially clean. This is an API-only milestone, so browser/UI verification is not applicable unless implementation unexpectedly adds browser-visible behavior.
- **Plan:** Use sequential implementation for tightly-coupled route/domain work; use subagents for safe parallel read-only analysis and independent review passes. Track any deviations here before/after they happen.
- **Implement:** Tracker section added to the plan.
- **Verify planned:** inspect current modules/tests, then implement Phase 1 with targeted validation.
- **Human checkpoint:** none required; plan says no open questions and no destructive/production actions.
- **Browser/manual verification:** skipped for Loop 0; no UI/browser-visible changes.
- **Review:** pending after first major step.

## Clarification Status

No clarification is required before implementation. The agreed next step is contact/list/suppression management plus the small cleanup items in one milestone.

Implementation assumptions:

- Keep the API lean and operator-focused.
- Use existing SQLite schema; no migration is expected unless implementation discovers a true schema gap.
- Keep contact personalization out of scope; `contacts` still only have `email`, timestamps, and memberships.
- Use session-owner access plus new scoped API-key permissions.
- Prefer idempotent behavior for repeated imports/subscriptions/suppressions where existing unique constraints make that natural.
- Keep all route handlers thin and Effect-based, following existing `mailings`, `operations`, and `ses` patterns.

## Confirmed Requirements

### Product/API requirements

- Operators and agents must be able to manage contacts/lists without direct SQLite access.
- Marketing mailings using `listId` should become usable end-to-end through public API calls.
- Manual suppressions should be manageable through protected endpoints.
- APIs must remain single-user/self-hosted, not organization/workspace scoped.
- API keys must be permission-scoped; session principals remain instance-owner principals and bypass per-route permissions.
- Responses should be machine-readable and compact.

### Cleanup requirements

- Update docs to match implemented routes and directories.
- Clarify that SES feedback currently writes audit rows/suppressions but does not mutate `deliveries.status`.
- Make local validation reliable without needing ad-hoc `--testTimeout=20000`.
- Keep cleanup separate from feature logic where practical, but deliver in the same milestone.

## Current-State Findings

### Existing route and runtime shape

Relevant files:

- `apps/service/src/app.ts`
  - Wires `/health`, `/health/db`, `/api/auth/*`, `/unsubscribe`, `/api/webhooks`, `/api/mailings`, `/api/operations`.
  - New routes should mount here as `/api/contacts`, `/api/lists`, and `/api/suppressions`.
- `apps/service/src/http/respond.ts`
  - `runRoute` owns JSON error mapping for app routes.
  - Expected route failures must be tagged errors included in `RouteError`.
- `apps/service/src/auth/middleware.ts`
  - `requirePrincipal({ permissions })` enforces API-key permissions and session auth.
- `apps/service/src/auth/permissions.ts`
  - Current resources are `mailings: ["create"]` and `operations: ["read"]`.

### Existing data model already supports this milestone

From `apps/service/src/db/migrations/sql/0001_initial_schema.sql`:

- `lists(id, name, created_at)`
- `contacts(id, email, created_at, updated_at)` with unique `contacts_email_idx`
- `list_memberships(list_id, contact_id, subscribed_at, unsubscribed_at)` with primary key `(list_id, contact_id)`
- `suppressions(id, email, scope, list_id, reason, created_at)` with scope/list consistency checks and uniqueness constraints

No attrs/personalization column exists, so list-recipient personalization remains intentionally unsupported.

### Existing list consumption

- `apps/service/src/mailings/create-mailing.ts`
  - `listId` marketing creation loads subscribed memberships where `unsubscribed_at IS NULL`.
  - Returns `varsJson: null` for list recipients.
  - Checks list existence and list-recipient limit.
  - Suppression lookup already supports global, marketing, and matching list scopes.

### Existing suppression consumers

- Mailing creation checks suppressions at create time.
- Sending policy re-checks suppressions immediately before sending.
- Unsubscribe creates `scope='marketing' reason='unsubscribe'` suppressions and marks originating memberships unsubscribed.
- SES feedback creates `scope='all' reason='bounce'|'complaint'` suppressions for reputation-critical feedback.

Manual suppression APIs must preserve those semantics and not weaken automated suppression behavior.

### Existing test patterns

- `apps/service/src/mailings/routes.test.ts`
  - Uses `withTestApp`, fake auth, real in-memory SQLite, and direct HTTP requests.
- `apps/service/src/testing/layers.ts`
  - Provides `DatabaseNodeLive`, `TestClock`, `FakeAuthLive`, id generators, and route test app helpers.
- `apps/service/src/testing/contact-fixtures.ts`
  - Seeds list/contact/membership data directly for current tests.

New tests should use the same in-process route/domain patterns.

## Independent Review Findings Incorporated

Claude reviewed the draft plan with project context. The review found the plan broadly sound and called out several implementation details now incorporated:

- duplicate contact/suppression creates must use explicit `INSERT ... ON CONFLICT ... DO NOTHING` / read-back paths, not raw SQLite error catching
- suppression idempotency must respect the two partial unique indexes separately and return existing automated rows honestly when they already occupy the key
- collection APIs need `limit` + `offset` pagination so records beyond the first 100 remain reachable
- list collection counts should avoid N+1 query shapes
- contact update conflict checks must exclude the target row so current-email/case-only no-ops succeed
- suppression deletion should default to the safer manual-only policy for this milestone

## Chosen Implementation Strategy

Add three small route areas, backed by separate domain/read-model/schema modules:

```txt
apps/service/src/contacts/
  schema.ts
  write.ts
  read-model.ts
  routes.ts
  *.test.ts

apps/service/src/lists/
  schema.ts
  write.ts
  read-model.ts
  routes.ts
  *.test.ts

apps/service/src/suppressions/
  schema.ts
  write.ts
  read-model.ts
  routes.ts
  *.test.ts
```

Shared helpers can be added only where they reduce duplication without over-abstracting, for example:

```txt
apps/service/src/lib/email.ts       # normalize + validate with current simple semantics
apps/service/src/http/query.ts      # optional, only if query parsing duplication becomes large
```

Keep route handlers as shells:

1. body/query/path validation
2. `requirePrincipal(...)`
3. call Effect domain/read-model program
4. return through `runRoute`

Use DB transactions for multi-row writes only. Do not introduce new external dependencies.

## API Design

### Permissions

Update `apps/service/src/auth/permissions.ts`:

```ts
export const authStatements = {
  contacts: ["read", "write"],
  lists: ["read", "write"],
  mailings: ["create"],
  operations: ["read"],
  suppressions: ["read", "write"],
} as const;
```

Route permission rules:

- read endpoints require `<resource>:read`
- write endpoints require `<resource>:write`
- membership endpoints are list writes (`lists:write`) and may also expose contact data in responses; do not require `contacts:read` for write responses
- session principals bypass permission checks as they do today

### Common request/query limits

Use constants close to existing mailings/operations limits:

- request body: 1 MB for batch import endpoints, 64 KB for single-object endpoints
- email: 320 chars, normalized trim + lowercase, same simple validation as mailing recipients
- IDs: 200 chars
- list name: 120 chars
- query `limit`: default 50, max 100
- query `offset`: default 0, non-negative integer, used on collection endpoints so records beyond the first 100 remain reachable
- collection responses should include pagination metadata: `{ "limit": number, "offset": number, "nextOffset": number | null }`
- contact import batch: max 1,000 emails per request

Validation should aggregate body field errors where practical, using Effect Schema like `mailings/schema.ts`.

All JSON write routes should reuse Hono `bodyLimit` plus the existing `errorEnvelope("request_too_large", "Request body is too large.")` 413 pattern from `apps/service/src/mailings/routes.ts`.

### Contacts API

#### `POST /api/contacts`

Auth: `contacts:write`

Request:

```json
{ "email": "User@Example.com" }
```

Behavior:

- normalize email to lowercase
- create contact if new
- if email already exists, return existing contact instead of failing
- implement duplicate handling with `INSERT ... ON CONFLICT(email) DO NOTHING` followed by a `SELECT`, not by catching raw SQLite unique errors
- update neither timestamps nor memberships on duplicate create

Response:

- `201` when created
- `200` when already existed

```json
{
  "contact": {
    "id": "...",
    "email": "user@example.com",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "created": true
}
```

#### `GET /api/contacts`

Auth: `contacts:read`

Query:

- `email` optional exact normalized email filter
- `limit` optional, default 50, max 100

Response:

```json
{
  "items": [
    {
      "id": "...",
      "email": "user@example.com",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

Sort: newest first (`created_at DESC, id DESC`) unless an email filter is present. Support `limit` + `offset`; return `nextOffset` when `items.length === limit`, otherwise `null`.

#### `GET /api/contacts/:id`

Auth: `contacts:read`

Response includes list memberships for operational usefulness:

```json
{
  "contact": {
    "id": "...",
    "email": "user@example.com",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "memberships": [
    {
      "listId": "...",
      "listName": "Customers",
      "subscribedAt": "...",
      "unsubscribedAt": null,
      "status": "subscribed"
    }
  ]
}
```

Missing contact: `404 not_found` with message `Contact not found.`

#### `PATCH /api/contacts/:id`

Auth: `contacts:write`

Request:

```json
{ "email": "new@example.com" }
```

Behavior:

- normalize and validate email
- update `contacts.email` and `updated_at`
- if another contact already owns the email, return `409 conflict`
- conflict lookup must exclude the target row (`WHERE email = $email AND id <> $id`) so PATCH with the current email or a case-only normalization no-op returns `200`, not `409`
- historical deliveries keep snapshotted email unchanged
- suppressions are not automatically rewritten; document this in `PROJECT.md` or endpoint notes if needed

Response: updated contact.

#### `DELETE /api/contacts/:id`

Auth: `contacts:write`

Behavior:

- delete contact
- memberships cascade through FK
- existing deliveries keep `email` and set `contact_id` to null by FK behavior
- suppressions are not deleted because they are email-based safety records

Response: `204`.

Missing contact: `404 not_found`.

### Lists API

#### `POST /api/lists`

Auth: `lists:write`

Request:

```json
{ "name": "Customers" }
```

Response: `201`

```json
{
  "list": {
    "id": "...",
    "name": "Customers",
    "createdAt": "...",
    "counts": { "subscribed": 0, "unsubscribed": 0 }
  }
}
```

Duplicate names are allowed unless a concrete product need for uniqueness emerges; current schema does not enforce uniqueness.

#### `GET /api/lists`

Auth: `lists:read`

Query:

- `limit` optional, default 50, max 100
- `offset` optional, default 0

Response includes membership counts. Implement counts in one aggregate query using `LEFT JOIN list_memberships` plus `GROUP BY`, or one equivalent non-N+1 query shape:

```json
{
  "items": [
    {
      "id": "...",
      "name": "Customers",
      "createdAt": "...",
      "counts": { "subscribed": 123, "unsubscribed": 4 }
    }
  ]
}
```

#### `GET /api/lists/:id`

Auth: `lists:read`

Same shape as one list item. Missing list: `404 List not found.` using existing `ListNotFoundError` mapping.

#### `PATCH /api/lists/:id`

Auth: `lists:write`

Request:

```json
{ "name": "Customers 2026" }
```

Behavior: update `name`; no `updated_at` exists on `lists`, so do not invent one without migration.

Response: updated list item.

#### `DELETE /api/lists/:id`

Auth: `lists:write`

Behavior:

- delete list
- memberships cascade
- historical mailings keep working with `mailings.list_id` set null by FK
- list-scoped suppressions cascade delete because `suppressions.list_id REFERENCES lists(id) ON DELETE CASCADE`

Response: `204`.

This is acceptable for a single-owner API, but tests should lock this behavior in because deleting list-scoped suppressions is safety-relevant.

### List membership API

#### `GET /api/lists/:id/contacts`

Auth: `lists:read`

Query:

- `status=subscribed|unsubscribed|all`, default `subscribed`
- `email` optional exact normalized email filter
- `limit` optional, default 50, max 100
- `offset` optional, default 0

Response:

```json
{
  "items": [
    {
      "contact": {
        "id": "...",
        "email": "user@example.com",
        "createdAt": "...",
        "updatedAt": "..."
      },
      "subscribedAt": "...",
      "unsubscribedAt": null,
      "status": "subscribed"
    }
  ]
}
```

Missing list: `404 List not found.`

#### `POST /api/lists/:id/contacts`

Auth: `lists:write`

Request supports import/subscribe in one call:

```json
{
  "contacts": [
    { "email": "a@example.com" },
    { "email": "b@example.com" }
  ]
}
```

Behavior inside one DB transaction:

1. verify list exists
2. normalize and de-duplicate emails within request
3. create missing contacts
4. for each contact:
   - if no membership: insert subscribed membership
   - if membership exists with `unsubscribed_at IS NULL`: leave unchanged
   - if membership exists with `unsubscribed_at IS NOT NULL`: set `unsubscribed_at = NULL`, update `subscribed_at = now`

Response: `200`; a batch can mix new/existing/resubscribed rows. Use SQL `INSERT ... ON CONFLICT ... DO NOTHING` / targeted `UPDATE ... RETURNING` paths where practical so counts derive from actual write outcomes, not raw SQLite error handling.

```json
{
  "counts": {
    "submitted": 2,
    "accepted": 2,
    "contactsCreated": 1,
    "membershipsCreated": 1,
    "alreadySubscribed": 0,
    "resubscribed": 1
  },
  "items": [
    {
      "contactId": "...",
      "email": "a@example.com",
      "status": "subscribed",
      "action": "created"
    }
  ]
}
```

`accepted` is the number of unique normalized emails retained after de-duplicating the request.

`action` values: `created`, `subscribed`, `resubscribed`, `already_subscribed`.

Important: This endpoint should **not** remove existing marketing suppressions. If an email has a `scope='marketing'` suppression from unsubscribe, re-subscribing to a list should not silently re-enable marketing sends. Removing suppressions requires the suppression API.

#### `DELETE /api/lists/:id/contacts/:contactId`

Auth: `lists:write`

Behavior:

- verify list exists and membership exists
- set `unsubscribed_at = COALESCE(unsubscribed_at, now)`
- do not create a suppression row; this is a list membership unsubscribe only

Response: `204`.

Missing list: `404 List not found.`
Missing membership/contact in list: `404 Contact is not a member of this list.` via `NotFoundError`.

Resubscribe uses `POST /api/lists/:id/contacts` with the same email.

### Suppressions API

#### `POST /api/suppressions`

Auth: `suppressions:write`

Request:

```json
{
  "email": "user@example.com",
  "scope": "all",
  "listId": null
}
```

Behavior:

- normalize email
- allowed scopes: `all`, `marketing`, `list`
- `listId` required for `scope='list'`; forbidden for `all`/`marketing`
- verify list exists for `scope='list'`
- create `reason='manual'`
- if same suppression already exists by unique constraint, return the existing row instead of failing
- implement idempotency with explicit SQL paths, not raw unique-error catching:
  - global scopes (`all`, `marketing`): `INSERT ... ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING`, then select by normalized `email` + `scope`
  - list scope: `INSERT ... ON CONFLICT(email, list_id) WHERE scope = 'list' DO NOTHING`, then select by normalized `email` + `listId`
- if an automated row already exists for the same unique key, return that existing row honestly with its original `reason` and `created: false` (for example an existing `reason='bounce'` row is not converted to `manual`)

Response:

- `201` when created
- `200` when already existed

```json
{
  "suppression": {
    "id": "...",
    "email": "user@example.com",
    "scope": "all",
    "listId": null,
    "reason": "manual",
    "createdAt": "..."
  },
  "created": true
}
```

Do not allow callers to create fake `bounce`, `complaint`, or `unsubscribe` reasons through this manual API.

#### `GET /api/suppressions`

Auth: `suppressions:read`

Query:

- `email` optional exact normalized email
- `scope=all|marketing|list` optional
- `listId` optional, valid only with no scope or `scope=list`
- `reason=bounce|complaint|unsubscribe|manual` optional
- `limit` optional, default 50, max 100
- `offset` optional, default 0

Response:

```json
{ "items": [ /* suppression rows */ ] }
```

Sort newest first.

#### `DELETE /api/suppressions/:id`

Auth: `suppressions:write`

Behavior:

- delete one suppression by id only when `reason = 'manual'`
- response `204`
- missing id returns `404 Suppression not found.`
- non-manual suppression ids return `409 conflict` with a message such as `Only manual suppressions can be deleted through this API.`

Automated bounce, complaint, and unsubscribe suppressions are intentionally read-only in this milestone. Removing those remains out of scope and should require direct DB intervention or a later explicit recovery endpoint with stronger safeguards.

## Data and Schema Changes

Expected schema changes: none.

Reasons:

- current tables already represent contacts, lists, memberships, and suppressions
- unique constraints already support idempotent contact/suppression behavior
- mailing/list FK behavior already preserves historical sends where needed

Do not add `contacts.attrs_json` in this milestone. That belongs with a later personalization/templates plan.

Potential migration only if implementation finds a hard blocker:

- add `updated_at` to `lists` only if list update semantics genuinely need it; default plan avoids this migration
- add an audit table for suppression deletion only if product requirements change; default plan documents operator responsibility instead

## Error Handling Plan

Reuse existing errors where possible:

- `RequestValidationError` → `400 invalid_request`
- `ListNotFoundError` → `404 not_found`, `List not found.`
- `NotFoundError` → `404 not_found`
- `DatabaseError` → sanitized `500 internal_error`

Add one generic conflict error:

```ts
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly message: string;
}> {}
```

Map in `runRoute`:

```json
{ "error": { "code": "conflict", "message": "..." } }
```

Likely uses:

- `PATCH /api/contacts/:id` when another contact already owns the requested email
- `DELETE /api/suppressions/:id` when the row exists but is not manual-deletable

Wire it into both `RouteError` and `runRoute` catch tags in `apps/service/src/http/respond.ts`. `logCause` does not need special handling because it already summarizes tagged message errors. Avoid leaking raw SQLite constraint errors. Detect expected unique conflicts and return typed errors or idempotent existing rows.

## Implementation Tasks

### Phase 1 — Cleanup foundation

1. Update `PROJECT.md`:
   - include SES operations routes such as `GET /api/operations/ses/summary` in all operations route lists
   - update repository shape snippet to include `operations/`, `sending/`, `ses/`, `unsubscribe/`
   - clarify SES feedback roadmap wording: current feedback writes audit rows and suppressions, not delivery statuses
   - add this milestone as the next active phase before templates/assets/CLI
2. Update `.env.example`:
   - add `NUSEND_PUBLIC_BASE_URL`
   - add `NUSEND_UNSUBSCRIBE_SECRET`
   - add `NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET`
3. Fix validation timeout fragility:
   - preferred: add explicit longer timeout to the long migration integration test(s) in `apps/service/src/db/migrate.integration.test.ts`
   - avoid raising global timeout unless the focused fix is awkward
   - verify `pnpm check` passes without extra CLI flags

### Phase 2 — Shared validation and permissions

1. Add or update shared validation helpers:
   - introduce `apps/service/src/lib/email.ts` for current simple trim/lowercase/one-`@`/no-whitespace semantics
   - use in new contact/suppression schemas
   - optionally refactor `mailings/schema.ts` to use the helper only if it is a small no-behavior-change edit
2. Add API-key permissions in `apps/service/src/auth/permissions.ts`:
   - `contacts: ["read", "write"]`
   - `lists: ["read", "write"]`
   - `suppressions: ["read", "write"]`
3. Add `ConflictError` for contact update conflicts and protected non-manual suppression deletion.

### Phase 3 — Contacts domain and routes

Likely files:

- `apps/service/src/contacts/schema.ts`
- `apps/service/src/contacts/write.ts`
- `apps/service/src/contacts/read-model.ts`
- `apps/service/src/contacts/routes.ts`
- `apps/service/src/contacts/*.test.ts`

Tasks:

1. Implement request/query decoding:
   - create contact body
   - update contact body
   - list contacts query including `limit` and `offset`
   - path id normalization/validation helper if useful
2. Implement write functions:
   - create-or-get contact
   - update contact email
   - delete contact
3. Implement read functions:
   - list contacts
   - get contact detail with memberships
4. Implement routes and mount in `app.ts`.
5. Add tests:
   - auth required
   - API-key permissions enforced
   - session owner succeeds
   - create normalizes email
   - duplicate create returns existing
   - list filters by email, limit, and offset; records beyond the first page are reachable
   - detail includes memberships and omits unrelated sensitive data
   - update conflict returns 409, while no-op/current-email updates return 200
   - delete cascades memberships and nulls delivery contact references where applicable

### Phase 4 — Lists and memberships domain/routes

Likely files:

- `apps/service/src/lists/schema.ts`
- `apps/service/src/lists/write.ts`
- `apps/service/src/lists/read-model.ts`
- `apps/service/src/lists/routes.ts`
- `apps/service/src/lists/*.test.ts`

Tasks:

1. Implement list CRUD read/write functions.
2. Implement list counts in read model:
   - subscribed: `unsubscribed_at IS NULL`
   - unsubscribed: `unsubscribed_at IS NOT NULL`
3. Implement membership list endpoint.
4. Implement batch import/subscribe endpoint in one DB transaction:
   - verify list
   - de-dupe normalized emails
   - create missing contacts
   - insert/resubscribe memberships
   - return counts/actions
5. Implement membership unsubscribe endpoint.
6. Mount `/api/lists` in `app.ts`.
7. Add tests:
   - list create/list/detail/update/delete
   - list not found errors
   - list collection counts are computed without an N+1 query shape where practical
   - membership import creates contacts and memberships
   - import is idempotent for existing subscribed contacts
   - import resubscribes previously unsubscribed memberships
   - import does not remove marketing suppressions
   - membership delete unsubscribes but does not create suppression
   - `GET /api/lists/:id/contacts` filters by status/email/limit/offset; records beyond the first page are reachable
   - marketing mailing can use a list created and populated through these APIs

### Phase 5 — Suppressions domain/routes

Likely files:

- `apps/service/src/suppressions/schema.ts`
- `apps/service/src/suppressions/write.ts`
- `apps/service/src/suppressions/read-model.ts`
- `apps/service/src/suppressions/routes.ts`
- `apps/service/src/suppressions/*.test.ts`

Tasks:

1. Decode suppression create body and list query.
2. Implement create manual suppression:
   - validate scope/listId relationship
   - verify list exists for list-scoped suppressions
   - insert with `reason='manual'`
   - on uniqueness conflict, read and return existing row
3. Implement list suppressions with filters.
4. Implement manual-only suppression deletion by id.
5. Mount `/api/suppressions` in `app.ts`.
6. Add tests:
   - auth and permissions
   - create `all`, `marketing`, and `list` suppressions
   - invalid `scope/listId` combinations return 400
   - missing list for list scope returns 404
   - duplicate manual suppression returns existing/idempotent response
   - duplicate over an existing automated suppression returns the automated row unchanged with `created:false`
   - list filters by email/scope/listId/reason/limit/offset; records beyond the first page are reachable
   - delete manual suppression removes row
   - deleting bounce/complaint/unsubscribe suppression returns conflict and does not remove row
   - deleting nonexistent suppression returns 404
   - manual `all` suppression blocks transactional mailing creation
   - manual `marketing`/`list` suppression blocks marketing but not transactional

### Phase 6 — Integration and docs polish

1. Update `README.md`:
   - document new API groups briefly
   - document permissions
   - add minimal curl examples for list creation, contact import, suppression creation
   - document that automated bounce/complaint/unsubscribe suppressions are visible but not API-deletable in this milestone
2. Update `PROJECT.md`:
   - move contact/list/suppression APIs from missing/future to implemented/current once code is complete
   - keep templates/assets/CLI as future
3. Consider updating `apps/service/src/testing/contact-fixtures.ts`:
   - keep direct DB fixtures for low-level tests
   - optionally add helper functions matching new API semantics for integration tests

## Testing and Verification Plan

Required automated checks:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

Targeted tests to run during implementation:

```sh
pnpm test apps/service/src/contacts
pnpm test apps/service/src/lists
pnpm test apps/service/src/suppressions
pnpm test apps/service/src/mailings
pnpm test apps/service/src/db/migrate.integration.test.ts
```

Expected final result:

- `pnpm check` passes without needing custom timeout flags
- existing mailings/sending/suppression behavior remains unchanged unless explicitly documented
- all new route tests pass with session and API-key auth scenarios
- no migration required, unless a hard blocker was discovered and planned explicitly during implementation

Manual/API smoke test if running the service locally:

1. migrate DB
2. bootstrap owner or use API key
3. create list
4. import contacts into list
5. create marketing mailing using `listId`
6. create manual suppression
7. verify suppressed recipient is not queued in a new mailing
8. delete suppression and verify new mailing can queue recipient again where applicable

Browser/UI testing is not required because this milestone has no browser UI.

## Rollout and Backward Compatibility

- Existing API routes remain unchanged.
- Existing mailings, workers, SES feedback, unsubscribe, and operations behavior should keep working.
- No DB migration expected; existing development DBs should continue to work after code deploy.
- New API-key permissions do not automatically grant access to old API keys. Operators must create/update API keys with the new permission objects.
- Contact deletion can affect future list sends but should not mutate historical delivery email snapshots.
- List deletion removes list memberships and list-scoped suppressions; document this because it can affect future suppression behavior.

## Risks and Mitigations

### Risk: broad API surface increases milestone size

Mitigation:

- Keep endpoints CRUD-like and simple.
- Avoid pagination cursors, attrs, advanced search, bulk delete, segmentation, or import jobs.
- Use simple `limit` + `offset` pagination for v1 instead of cursor pagination; this is sufficient for the current SQLite-backed single-owner service and keeps records beyond the first page reachable.

### Risk: suppression deletion can hurt sender reputation

Mitigation:

- Require `suppressions:write`.
- Delete only by exact id, not bulk filters.
- Only `reason='manual'` rows are deletable through the API in this milestone.
- Automated bounce/complaint/unsubscribe rows remain visible but protected from API deletion.

### Risk: contact email updates do not update suppressions

Mitigation:

- Keep historical deliveries and suppressions email-snapshotted.
- Document that suppressions are email-based and must be managed separately.
- Tests should prove contact update does not silently rewrite suppression rows.

### Risk: imports accidentally re-enable unsubscribed users

Mitigation:

- Re-subscribing a list membership does not remove `marketing` or `all` suppressions.
- Sending policy still checks suppressions before send.
- Tests should cover reimport with existing marketing suppression.

### Risk: case/collation inconsistencies

Mitigation:

- Normalize emails at API boundaries.
- Use `COLLATE NOCASE` or `lower(email)` consistently in lookup queries where appropriate.
- Add mixed-case tests for contact create/import and mailing list use.

### Risk: route row decoding drift

Mitigation:

- Use Effect Schema or explicit row mappers for read-model rows with constrained enums.
- Treat impossible decode failures as defects, following operations read-model patterns.

## Alternatives Considered

### Alternative A: Only add list import endpoint, defer full CRUD

Rejected because it would still force direct DB access for contact inspection, suppression management, list renaming/deletion, and debugging. The agreed next step is broader recipient management.

### Alternative B: Add contact attributes now

Rejected because templates/personalization are a separate roadmap item. Adding attrs now would expand schema, validation, rendering, and privacy concerns before template requirements are clear.

### Alternative C: Use a generic admin CRUD router

Rejected because Nusend has explicit Effect/Hono route patterns, typed errors, and safety-sensitive suppression semantics. Generic CRUD would hide important business rules.

### Alternative D: Allow deletion of all suppression reasons

Rejected for this milestone after review. Bounce, complaint, and unsubscribe suppressions are safety/reputation records. The safer low-regret default is to allow API deletion of `reason='manual'` rows only and leave recovery/removal of automated suppressions to direct operator DB intervention or a later explicit recovery endpoint with stronger safeguards.

## Files Likely to Change

Cleanup/docs:

- `PROJECT.md`
- `README.md`
- `.env.example`
- `apps/service/src/db/migrate.integration.test.ts` or `vitest.config.ts`

Shared infrastructure:

- `apps/service/src/app.ts`
- `apps/service/src/auth/permissions.ts`
- `apps/service/src/errors.ts` for `ConflictError`
- `apps/service/src/http/respond.ts` for `ConflictError` route mapping
- `apps/service/src/lib/email.ts` if shared helper is added

New feature modules:

- `apps/service/src/contacts/*`
- `apps/service/src/lists/*`
- `apps/service/src/suppressions/*`

Tests:

- `apps/service/src/contacts/*.test.ts`
- `apps/service/src/lists/*.test.ts`
- `apps/service/src/suppressions/*.test.ts`
- selected `mailings` tests for API-created list/suppression integration

## Definition of Done

- Cleanup changes are complete and docs match current behavior.
- Contacts can be created, listed, read, updated, and deleted through protected API routes.
- Lists can be created, listed, read, renamed, deleted, and populated through protected API routes.
- List contacts can be listed, imported/subscribed, unsubscribed, and resubscribed through protected API routes.
- Manual suppressions can be created, listed, and deleted through protected API routes; automated suppressions can be listed but not deleted through this milestone API.
- New API-key permissions are enforced in route tests.
- List-created contacts can be used by `POST /api/mailings` with `purpose='marketing'` and `listId`.
- Manual suppressions affect mailing creation/sending according to existing suppression policy.
- `pnpm check` passes without custom timeout flags.

## Open Questions

None blocking. The plan chooses the safer default for `DELETE /api/suppressions/:id`: manual suppressions only.

#### Loop 1 — Phase 1 cleanup foundation

- **Analyze:** Phase 1 touches docs/env sample and the known migration-test timeout. Current `.env.example` lacked unsubscribe env vars. `PROJECT.md` had stale operations route and repository-shape details plus SES feedback wording that could imply delivery status mutation.
- **Plan:** Make targeted documentation/sample updates and add a per-test timeout to the long migration integration test. Verify with the focused migration test; full `pnpm check` remains final validation after feature work.
- **Implement:** Updated `PROJECT.md`, `.env.example`, and `apps/service/src/db/migrate.integration.test.ts`.
- **Verification run:** `pnpm test apps/service/src/db/migrate.integration.test.ts` → passed (2 tests, 4.31s) without custom CLI timeout.
- **Browser/manual verification:** skipped; API/docs/test-only changes, no browser UI.
- **Human checkpoint:** not needed.
- **Review:** independent review pending after broader implementation step to avoid reviewing transient docs before routes exist.


#### Loop 2 — Phases 2–6 API implementation, docs, validation, and review

- **Analyze:** Implemented the core milestone after read-only scout context. Work was tightly coupled around shared errors/query validation, app route mounting, and endpoint behavior, so implementation stayed sequential rather than using parallel writers.
- **Plan:** Add shared email/query helpers and permissions/conflict error, then contacts, lists/memberships, suppressions, docs, and tests. Verify with targeted suites, full `pnpm check`, and independent review.
- **Implement:** Added `apps/service/src/lib/email.ts`, `apps/service/src/http/query.ts`, `contacts/*`, `lists/*`, `suppressions/*`; mounted `/api/contacts`, `/api/lists`, `/api/suppressions`; added API-key permissions and `ConflictError`; updated docs/env sample and migration-test timeout.
- **Verification run:**
  - `pnpm test apps/service/src/contacts apps/service/src/lists apps/service/src/suppressions` → passed (3 files, 16 tests).
  - `pnpm test apps/service/src/mailings` → passed (4 files, 40 tests).
  - `pnpm test apps/service/src/contacts apps/service/src/lists apps/service/src/suppressions apps/service/src/mailings apps/service/src/db/migrate.integration.test.ts` → passed (8 files, 58 tests).
  - `git diff --check` → passed.
  - `pnpm check` → passed: format check, lint (only pre-existing `apps/service/src/main.integration.test.ts` no-await-in-loop warnings), typecheck, all tests (42 files, 268 tests).
- **Independent review:** Initial Pi reviewer subagent timed out, so I used the required fallback external Claude review. Claude found no blockers/majors and three minor issues: too-short `.env.example` unsubscribe secret placeholder, missing list-delete/list-suppression cascade test, and missing list-scoped suppression mailing-behavior test. All three were fixed. Follow-up Claude review confirmed all findings resolved and no new blockers/majors.
- **Browser/manual verification:** skipped; this milestone adds JSON APIs/docs/tests only, no browser UI or browser-visible flow. API behavior is covered by in-process HTTP route tests.
- **Human checkpoint:** not needed; plan had no open questions and no destructive/production actions.
- **Deviations:** No schema migration was added, as planned. Direct Claude CLI review was used as fallback because the Pi reviewer subagent timed out.
