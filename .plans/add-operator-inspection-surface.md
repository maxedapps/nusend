# Add Operator Inspection Surface Plan

## Summary

Add a small protected HTTP inspection surface so the self-hosted Nusend operator can validate real transactional SES sends without ad-hoc SQLite queries.

The v1 surface should answer:

- What is the current queue / delivery / attempt state?
- Which deliveries failed, are ambiguous, or were accepted by SES?
- For one delivery, what job and send-attempt history explains the outcome?

This is a read-only operational debugging feature, not an admin dashboard, not a queue mutation API, not a CLI, and not marketing-sending work.

## Clarification Status

No clarification is required before implementation. Assumptions:

- Use protected HTTP JSON endpoints because Nusend is API-first.
- Keep v1 read-only.
- Support session owners and API keys.
- Add a dedicated API-key permission: `operations:read`.
- Keep responses compact and avoid exposing email body HTML/text or recipient `vars_json`.
- Keep v1 intentionally smaller than a full query/admin API.

## Confirmed Requirements

- Add an inspection surface before manual SES setup and real transactional-send validation.
- The surface must help inspect jobs, deliveries, send attempts, and failed/ambiguous states.
- Preserve current architecture:
  - Hono routes are thin shells over Effect programs.
  - `runRoute` owns route error mapping.
  - auth middleware protects API routes.
  - queue runner owns job complete/fail behavior.
  - sending processor owns delivery/attempt domain state.
- Do not implement in this planning step.

## Current-State Findings

### App and route wiring

- `apps/service/src/app.ts`
  - Wires `/health`, `/health/db`, Better Auth passthrough, and `/api/mailings`.
  - New routes should mount under `/api/operations`.

### Auth and permissions

- `apps/service/src/auth/middleware.ts`
  - `requirePrincipal({ runtime, permissions })` protects routes.
  - Session principals bypass route permissions because this is single-user/self-hosted.
  - API keys require explicit permissions.
- `apps/service/src/auth/permissions.ts`
  - Current local permission surface is only `mailings: ["create"]`.
  - Add `operations: ["read"]`.
  - Note: this local map is used by Nusend permission checks; Better Auth API-key creation does not enforce a schema from it today.

### HTTP error handling

- `apps/service/src/http/respond.ts`
  - `RouteError` is a closed union and `runRoute` catches tags exhaustively.
  - New not-found behavior must add a typed error to `errors.ts`, include it in `RouteError`, and map it in `runRoute`.
  - Query validation can use existing `RequestValidationError`.

### State tables

From `apps/service/src/db/migrations/sql/0001_initial_schema.sql`:

- `jobs`: queue state, lease fields, `ref_id`, retry counts, `last_error`.
- `deliveries`: recipient, status, SES message ID, `last_error`.
- `send_attempts`: attempt number, status, SES message ID, error, timestamps.
- `mailings`: purpose/state/subject/schedule context.

### Existing route/test patterns

- `apps/service/src/mailings/routes.ts`
  - Route builds an Effect program, decodes boundary input, calls domain function, returns through `runRoute`.
- `apps/service/src/mailings/routes.test.ts`
  - Uses `withTestApp` and fake auth.
  - Freezes status codes and error envelopes.
- `apps/service/src/testing/layers.ts`
  - Provides real migrated in-memory SQLite for tests.

## Research and Review Findings

No new external dependency is needed. The plan relies on existing local Effect/Hono/SQLite patterns.

Important project-pattern findings from `.agents/skills/effect-v4/references/project-patterns.md`:

- Route handlers should run Effect programs through `runRoute`.
- Expected failures should be tagged errors.
- DB calls go through the `Database` service with operation labels.
- Boundary/user input must be decoded/validated.
- Runtime row decoding should be explicit where rows contain constrained enums.
- Do not call `Effect.run*` outside approved boundaries and tests.

Independent Claude review of the draft plan found valid issues that are incorporated here:

- Add runtime enum sources for delivery and attempt statuses instead of type-only unions.
- Specify the `NotFoundError` / `RouteError` / `runRoute` edits precisely.
- Decode read-model rows instead of passing untyped DB rows directly to JSON.
- Fix nullable/enum response typing.
- Reduce v1 scope: avoid a full filter matrix, standalone jobs list, standalone send-attempts list, and pagination until a real workflow demands them.

## Chosen Implementation Strategy

Add a compact `/api/operations` read-only API with three endpoints:

```txt
GET /api/operations/summary
GET /api/operations/deliveries
GET /api/operations/deliveries/:id
```

This still exposes all required operational concepts:

- `summary` reports counts for jobs, deliveries, and attempts plus recent failures/ambiguous attempts.
- `deliveries` lists delivery outcomes with associated job and latest attempt context.
- `deliveries/:id` returns one delivery with its mailing summary, associated job, and all send attempts.

Why not standalone `/jobs` and `/send-attempts` in v1?

- The immediate manual SES validation flow starts from a mailing/delivery and needs to understand what happened to that delivery.
- Delivery list/detail can include job and attempt context without adding two more top-level resources.
- Smaller v1 means fewer query combinations, less test burden, and lower privacy risk.
- Standalone jobs/attempts endpoints remain a natural v2 if operations work shows they are needed.

## API Design

### Route prefix

```txt
/api/operations
```

### Auth

All routes require:

```ts
requirePrincipal({ runtime, permissions: { operations: ["read"] } })
```

Behavior:

- Valid session principal: allowed as owner.
- API key with `operations:read`: allowed.
- API key with only `mailings:create`: `403 forbidden`.
- Missing auth: `401 unauthenticated`.

### Runtime enum sources

Add runtime status definitions instead of relying on type-only unions.

Recommended changes:

- In `apps/service/src/sending/schema.ts`:
  - export `DeliveryStatusValues` as a const tuple.
  - derive `DeliveryStatus` from it or keep type compatible.
  - optionally export `SendAttemptStatusValues` and `SendAttemptStatus`.
- In `apps/service/src/queue/schema.ts`:
  - add/export `JobStateValues` and use it to build `Schema.Literals` if practical.

These arrays should mirror SQLite `CHECK` constraints and be used for:

- query validation
- summary zero-fill
- row decoding schemas

### Query parameter conventions

Keep v1 bounded and simple:

- `limit`: optional integer `1..100`, default `50`.
- No cursor/pagination in v1.
  - Fetch at most `limit` rows.
  - If more rows are eventually needed, add pagination in a dedicated follow-up.
- `GET /deliveries` filters:
  - `status`
  - `mailingId`
  - `email`
  - `sesMessageId`
  - `issue=failed_or_ambiguous`
- `issue=failed_or_ambiguous` should include deliveries where:
  - delivery status is `failed`, or
  - delivery `last_error IS NOT NULL`, or
  - latest attempt status is `failed` or `ambiguous`.

Invalid query values return `400 invalid_request`.

### Row decoding

Add read-model row schemas for DB result rows.

Options:

- Use Effect `Schema.Struct` for rows that include constrained enum fields.
- Decode with `Schema.decodeUnknownEffect(...).pipe(Effect.orDie)` for impossible DB-shape defects, following `queue/jobs.ts`.
- Keep request/query validation failures as `RequestValidationError` rather than defects.

Do not return raw `db.get/all` rows directly from the API.

## Endpoint Details

## `GET /api/operations/summary`

Purpose: quick post-send overview.

Response shape:

```ts
type OperationsSummaryResponse = {
  jobs: Record<JobState, number>;
  deliveries: Record<DeliveryStatus, number>;
  sendAttempts: Record<SendAttemptStatus, number>;
  recentIssues: Array<{
    kind: "job" | "delivery" | "send_attempt";
    id: string;
    relatedId: string | null;
    status: string;
    message: string | null;
    updatedAt: string;
  }>;
};
```

Implementation notes:

- Fill missing state/status keys with `0` using runtime status arrays.
- Count grouped jobs by `state`.
- Count grouped deliveries by `status`.
- Count grouped send attempts by `status`.
- `recentIssues` should include:
  - jobs with `last_error IS NOT NULL`
  - deliveries with `last_error IS NOT NULL`
  - send attempts with `error_message IS NOT NULL` or `status = 'ambiguous'`
- Cap recent issues at 10.

Suggested SQL approach:

- Use three simple grouped queries for counts.
- Use one `UNION ALL` query for recent issues.

## `GET /api/operations/deliveries`

Purpose: inspect recent deliveries and quickly find failures/ambiguous sends.

Response shape:

```ts
type DeliveriesListResponse = {
  items: Array<{
    id: string;
    mailingId: string;
    mailingPurpose: "transactional" | "marketing";
    email: string;
    status: DeliveryStatus;
    sesMessageId: string | null;
    lastError: string | null;
    job: {
      id: string;
      state: JobState;
      attempts: number;
      maxAttempts: number;
      runAt: string;
      lockedUntil: string | null;
      lastError: string | null;
    } | null;
    latestAttempt: {
      id: string;
      attemptNo: number;
      status: SendAttemptStatus;
      sesMessageId: string | null;
      errorMessage: string | null;
      startedAt: string;
      finishedAt: string | null;
    } | null;
    createdAt: string;
    updatedAt: string;
  }>;
};
```

Supported filters:

- `status`
- `mailingId`
- `email`
- `sesMessageId`
- `issue=failed_or_ambiguous`
- `limit`

Default ordering:

```sql
ORDER BY deliveries.created_at DESC, deliveries.id DESC
```

SQL notes:

- Join `mailings` for `mailingPurpose`.
- Left join `jobs` by `jobs.kind = 'send_delivery' AND jobs.ref_id = deliveries.id`.
- Left join latest send attempt by max `attempt_no` for the delivery.
- Omit `vars_json`, mailing `html`, and mailing `text` from list response.

## `GET /api/operations/deliveries/:id`

Purpose: one-stop inspection for a specific delivery.

Response shape:

```ts
type DeliveryDetailResponse = {
  delivery: {
    id: string;
    mailingId: string;
    email: string;
    contactId: string | null;
    status: DeliveryStatus;
    sesMessageId: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  };
  mailing: {
    id: string;
    purpose: "transactional" | "marketing";
    state: "draft" | "scheduled" | "sending" | "paused" | "cancelled" | "completed";
    name: string | null;
    subject: string;
    scheduledAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  job: {
    id: string;
    state: JobState;
    attempts: number;
    maxAttempts: number;
    lockedBy: string | null;
    lockedUntil: string | null;
    runAt: string;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  attempts: Array<{
    id: string;
    attemptNo: number;
    status: SendAttemptStatus;
    sesMessageId: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
};
```

Not-found behavior:

- Add a generic tagged `NotFoundError`:
  ```ts
  export class NotFoundError extends Data.TaggedError("NotFoundError")<{
    readonly message: string;
  }> {}
  ```
- Add it to `RouteError` in `apps/service/src/http/respond.ts`.
- Add `NotFoundError` to `Effect.catchTags` with `404 not_found`.
- Detail endpoint fails with `new NotFoundError({ message: "Delivery not found." })`.

Privacy notes:

- Do not return `vars_json` in v1.
- Do not return mailing HTML/text body.
- Returning recipient email, SES message ID, and operational errors is acceptable behind owner/API-key auth.

## Detailed Implementation Steps

## Step 1 — Add runtime state/status definitions

Files:

- `apps/service/src/queue/schema.ts`
- `apps/service/src/sending/schema.ts`

Tasks:

- Export runtime arrays for job states, delivery statuses, and send-attempt statuses.
- Derive or align TypeScript types from those arrays.
- Keep comments stating they mirror SQLite `CHECK` constraints.
- Use these arrays for query validation and summary zero-fill.

Validation:

- Existing queue/sending tests still typecheck and pass.

## Step 2 — Add generic not-found error mapping

Files:

- `apps/service/src/errors.ts`
- `apps/service/src/http/respond.ts`
- `apps/service/src/http/respond.test.ts`

Tasks:

- Add `NotFoundError` with a stable message field.
- Add it to the `RouteError` union.
- Map it to `404` with envelope:
  ```json
  { "error": { "code": "not_found", "message": "..." } }
  ```
- Keep existing `ListNotFoundError` behavior unchanged.

Validation:

- Add/adjust respond tests proving generic not-found mapping.

## Step 3 — Add operations module

Create:

- `apps/service/src/operations/query.ts`
- `apps/service/src/operations/read-model.ts`
- `apps/service/src/operations/routes.ts`
- `apps/service/src/operations/routes.test.ts`

Responsibilities:

- `query.ts`
  - parse `limit` as integer `1..100`, default `50`.
  - parse delivery `status` using runtime delivery statuses.
  - parse `issue=failed_or_ambiguous`.
  - parse string filters with max lengths:
    - `mailingId`, `sesMessageId`: 200 chars
    - `email`: 320 chars
  - fail invalid input with `RequestValidationError`.
- `read-model.ts`
  - implement summary, delivery list, and delivery detail Effects.
  - use read-only SQL and row decoding schemas.
  - explicitly alias DB columns to camelCase.
- `routes.ts`
  - protect all routes with `operations:read`.
  - call query decoders and read-model Effects.
  - return JSON via `runRoute`.

Implementation rules:

- No writes.
- No queue state transitions.
- No raw `SELECT *`.
- No `Effect.run*` in operations modules.
- No response fields containing message HTML, text, auth data, API keys, or recipient `vars_json`.

## Step 4 — Wire permissions and app routes

Files:

- `apps/service/src/auth/permissions.ts`
- `apps/service/src/app.ts`

Tasks:

- Add `operations: ["read"]` to `authStatements`.
- Mount operations routes:
  ```ts
  app.route("/api/operations", createOperationsRoutes({ runtime: options.runtime }));
  ```

Tests:

- Operations route auth test cases:
  - missing auth -> 401
  - invalid API key -> 401
  - API key with only `mailings:create` -> 403
  - session owner -> allowed
  - API key with `operations:read` -> allowed

## Step 5 — Implement summary endpoint

Tasks:

- Count all job states.
- Count all delivery statuses.
- Count all send-attempt statuses.
- Fill missing keys with zero.
- Return recent issues capped at 10.

Tests:

- Empty database returns all zero counts.
- Seed mixed states and assert counts.
- Seed recent job/delivery/attempt issues and assert ordering/cap.

## Step 6 — Implement deliveries list endpoint

Tasks:

- Return recent deliveries with mailing purpose, job context, latest attempt context.
- Support bounded filters:
  - `status`
  - `mailingId`
  - `email`
  - `sesMessageId`
  - `issue=failed_or_ambiguous`
  - `limit`

Tests:

- Lists deliveries newest first.
- Includes associated job and latest attempt.
- Filters by `status`.
- Filters by `issue=failed_or_ambiguous` including ambiguous attempt cases.
- Rejects invalid status/limit/issue.

## Step 7 — Implement delivery detail endpoint

Tasks:

- Fetch delivery + mailing summary.
- Fetch associated job if present.
- Fetch all send attempts ordered by `attempt_no ASC`.
- Return generic not-found for missing delivery.

Tests:

- Detail returns delivery, mailing, job, and all attempts.
- Detail omits `vars_json`, HTML, and text body.
- Missing delivery returns `404 not_found` with `Delivery not found.`.
- Orphan/corrupt job absence is represented as `job: null` where relevant.

## Step 8 — Documentation

Update `README.md`:

- Add “Operations inspection” section.
- Document auth:
  - session owner allowed
  - API keys need `operations:read`
- Document endpoints:
  ```txt
  GET /api/operations/summary
  GET /api/operations/deliveries
  GET /api/operations/deliveries/:id
  ```
- Add curl examples:
  ```sh
  curl -H 'x-api-key: ...' http://localhost:3000/api/operations/summary
  curl -H 'x-api-key: ...' 'http://localhost:3000/api/operations/deliveries?issue=failed_or_ambiguous'
  curl -H 'x-api-key: ...' http://localhost:3000/api/operations/deliveries/<delivery-id>
  ```
- Add a short manual transactional SES validation checklist:
  1. create transactional mailing
  2. run worker once
  3. inspect summary
  4. inspect delivery detail
  5. verify SES message ID or failure/ambiguous reason

Update `PROJECT.md`:

- Add read-only operations inspection to current implemented scope/interface.
- Keep standalone jobs/attempts endpoints, queue mutation, and admin UI as future work.

## Testing and Verification Plan

Targeted validation:

```sh
pnpm test apps/service/src/operations/routes.test.ts
pnpm test apps/service/src/http/respond.test.ts
pnpm test apps/service/src/mailings/routes.test.ts
pnpm test apps/service/src/sending/process-delivery.test.ts
pnpm --filter @nusend/service typecheck
pnpm format:check
pnpm lint
```

Full validation:

```sh
pnpm check
```

Expected lint caveat:

- Existing `apps/service/src/main.integration.test.ts` `no-await-in-loop` warnings may remain.

Manual smoke after implementation:

```sh
rm -f .data/nusend.sqlite .data/nusend.sqlite-shm .data/nusend.sqlite-wal
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service db:status
pnpm --filter @nusend/service worker:send:once
```

Then, once auth/API-key setup is available:

```sh
curl -H 'x-api-key: ...' http://localhost:3000/api/operations/summary
```

## Files Likely to Change

- `apps/service/src/app.ts`
- `apps/service/src/auth/permissions.ts`
- `apps/service/src/errors.ts`
- `apps/service/src/http/respond.ts`
- `apps/service/src/http/respond.test.ts`
- `apps/service/src/queue/schema.ts`
- `apps/service/src/sending/schema.ts`
- `apps/service/src/operations/query.ts` new
- `apps/service/src/operations/read-model.ts` new
- `apps/service/src/operations/routes.ts` new
- `apps/service/src/operations/routes.test.ts` new
- `README.md`
- `PROJECT.md`

## Data / Schema Changes

No database schema changes are planned.

All endpoints read existing tables only:

- `jobs`
- `deliveries`
- `send_attempts`
- `mailings`

## Security and Privacy Considerations

- Every endpoint must be protected with `requirePrincipal`.
- API keys need distinct `operations:read` permission.
- Do not return message HTML/text bodies.
- Do not return recipient `vars_json` in v1.
- Do not return auth/session/API-key data.
- Recipient emails, SES IDs, delivery statuses, and truncated operational errors are acceptable behind owner/API-key auth because they are necessary for delivery debugging.
- Keep v1 read-only to avoid accidental queue/admin mutation risk.

## Risks and Mitigations

### Risk: Inspection API becomes an accidental admin API

Mitigation:

- V1 has only read endpoints.
- No retry, cancel, release, or state mutation endpoints.
- Docs call it “Operations inspection,” not “Admin control.”

### Risk: PII exposure

Mitigation:

- Auth required.
- Dedicated API-key permission.
- Omit bodies and vars.
- Return only operational metadata needed for debugging.

### Risk: Runtime enum drift from SQLite CHECK constraints

Mitigation:

- Add runtime status arrays near existing schema/type definitions.
- Comment that they mirror migration CHECK constraints.
- Use them in query validation, summary zero-fill, and row decoding.

### Risk: Offset/pagination complexity creep

Mitigation:

- No cursor in v1.
- Default `limit=50`, max `100`.
- Add pagination later only when operational data volume requires it.

### Risk: Read-model row shape bugs

Mitigation:

- Use explicit aliases.
- Decode row schemas.
- Test representative seeded states.
- Prefer a few simple queries over one highly complex query.

## Acceptance Criteria

- `GET /api/operations/summary` returns job, delivery, and send-attempt counts with zero-filled statuses.
- `GET /api/operations/summary` returns recent issues, including ambiguous attempts.
- `GET /api/operations/deliveries` returns delivery outcomes with job and latest-attempt context.
- `GET /api/operations/deliveries?issue=failed_or_ambiguous` finds failed/ambiguous outcomes.
- `GET /api/operations/deliveries/:id` returns delivery, mailing summary, associated job, and all attempts.
- Missing delivery detail returns `404 not_found` with `Delivery not found.`.
- Session owner can access operations endpoints.
- API key with `operations:read` can access operations endpoints.
- API key with only `mailings:create` receives `403 forbidden`.
- Missing auth receives `401 unauthenticated`.
- Invalid query params receive `400 invalid_request`.
- No endpoint mutates queue, delivery, or attempt state.
- Responses do not include `vars_json`, mailing HTML, mailing text, auth session data, or API keys.
- `pnpm check` passes with only known lint warnings if still present.

## Deferred Follow-Ups

- Standalone `GET /api/operations/jobs`.
- Standalone `GET /api/operations/send-attempts`.
- Cursor/keyset pagination.
- Queue mutation controls such as retry/cancel/release.
- Operator UI/dashboard.
- CLI inspection commands.
- Suppression inspection explaining `suppressed` outcomes.

## Open Questions

None blocking under the assumptions above.

Recommended defaults:

- Route prefix: `/api/operations`.
- Permission: `operations:read`.
- Endpoints: summary, deliveries list, delivery detail.
- Page size: default `50`, max `100`.
- No pagination in v1.
- Read-only only.
- Omit `vars_json`, `html`, and `text` from v1 responses.

## Implementation Progress

- Started: 2026-07-07
- Tracker location: this section
- Human checkpoints: none required by the plan; implementation is read-only API/code/test/docs work.
- Decomposition:
  - [x] Loop 1: runtime enum exports + generic `NotFoundError` mapping.
    - Files changed: `apps/service/src/queue/schema.ts`, `apps/service/src/sending/schema.ts`, `apps/service/src/errors.ts`, `apps/service/src/http/respond.ts`, `apps/service/src/http/respond.test.ts`.
    - Verification: `pnpm test apps/service/src/http/respond.test.ts` passed (12 tests).
  - [x] Loop 2: operations query/read-model/routes + route wiring/permission.
    - Files changed: `apps/service/src/operations/query.ts`, `apps/service/src/operations/read-model.ts`, `apps/service/src/operations/routes.ts`, `apps/service/src/auth/permissions.ts`, `apps/service/src/app.ts`.
    - Verification: `pnpm --filter @nusend/service typecheck` passed.
  - [x] Loop 3: operations route tests and endpoint behavior coverage.
    - Files changed: `apps/service/src/operations/routes.test.ts`.
    - Verification: first route-test run failed due seed FK (`contact_2`) and was fixed by seeding the contact; `pnpm test apps/service/src/operations/routes.test.ts` passed (9 tests); `pnpm --filter @nusend/service typecheck` passed.
  - [x] Loop 4: README/PROJECT documentation updates.
    - Files changed: `README.md`, `PROJECT.md`.
    - Verification: targeted tests passed; `pnpm --filter @nusend/service typecheck`, `pnpm format:check`, and `pnpm lint` passed with only the known pre-existing `main.integration.test.ts` warnings after formatting touched only new operations files.
  - [x] Loop 5: validation, independent reviews, and final fixes.
    - Validation: `pnpm test apps/service/src/operations/routes.test.ts apps/service/src/http/respond.test.ts apps/service/src/mailings/routes.test.ts apps/service/src/sending/process-delivery.test.ts` passed (41 tests); `pnpm check` passed (format, lint, typecheck, all tests: 25 files / 173 tests) with only known pre-existing `apps/service/src/main.integration.test.ts` `no-await-in-loop` warnings.
    - Independent review: Claude session `705c1b6b-f22a-4206-8a96-81ed333449a6` found no blockers; suggested adding sole latest-attempt issue-filter coverage and making job selection deterministic. Both were implemented. Follow-up reviews confirmed all findings resolved and no new blockers.
    - Manual smoke: destructive local DB reset / SES worker / live curl smoke from the plan was not run because it would delete `.data` and may require external SES/auth setup. Automated route/integration coverage exercised the API surface against migrated in-memory SQLite.
- Notes:
  - Plan was read completely before editing.
  - Recon subagent `scout` run `59f1a554-a71d-4712-aa42-6c9de9e422f5` was used before implementation and reported route/auth/SQL/test pitfalls.
