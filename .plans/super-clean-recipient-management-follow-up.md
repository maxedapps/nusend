# Super-Clean Recipient Management Follow-up Plan

## Summary

Tighten the recently added recipient-management APIs by addressing the review findings without changing the public API shape or broadening scope. The goal is a cleaner, more race-safe, better-tested implementation that preserves the current contacts/lists/suppressions semantics.

This plan covers:

- race-safe contact email updates that return `409 conflict` for expected unique-email conflicts instead of leaking as `500`
- stronger permission regression tests for read/write API-key separation
- explicit regression coverage that contact email updates do not rewrite historical delivery snapshots or suppressions
- cleanup of the committed trailing whitespace in the plan file
- optional, low-priority contact create/readback transaction hardening only if the implementer decides the narrow concurrent-delete window matters

No schema migration, API redesign, new endpoints, route-helper refactor, docs rewrite, admin UI, templates, or shared package work is planned.

## Confirmed Requirements

- Do not widen the recipient-management milestone.
- Keep the existing HTTP routes and response shapes.
- Preserve existing single-owner/session-owner semantics and API-key permission scopes.
- Preserve current data semantics:
  - `contacts.email` can be updated for future use.
  - `deliveries.email` remains a historical snapshot and is not rewritten.
  - `deliveries.contact_id` should remain linked to the contact after a contact email update.
  - suppressions are email-based safety records and are not rewritten by contact updates.
  - automated suppressions remain API-readable but not API-deletable.
- Keep implementation idiomatic for this repo: Effect programs, typed errors, thin Hono route shells, and DB writes through the `Database` service.
- Do not implement from this planning task alone; this document is the handoff plan.

## Relevant Codebase Findings

Relevant files from commit `6078fdd`:

- `apps/service/src/contacts/write.ts`
  - `createOrGetContact()` inserts with `ON CONFLICT(email) DO NOTHING`, then reads back by email.
  - `updateContactEmail()` does an existence read, conflict read, update, and readback outside a transaction.
  - `deleteContact()` checks existence then deletes.
- `apps/service/src/contacts/routes.test.ts`
  - covers auth/read permission denial, create normalization/idempotency, list filtering, detail, conflict/no-op update, delete preserving delivery/suppressions.
- `apps/service/src/lists/routes.test.ts`
  - covers read permission denial, list CRUD, import/idempotency/resubscribe, membership filtering/delete, API-created list to marketing-mailing integration.
- `apps/service/src/suppressions/routes.test.ts`
  - covers read permission denial, create validation, duplicate automated suppression honesty, filters, manual-only delete, mailing suppression behavior.
- `apps/service/src/http/respond.ts`
  - maps `ConflictError` to `409 conflict`.
- `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
  - `contacts.email` is `COLLATE NOCASE`, and `contacts_email_idx` is unique on `email`.
  - `deliveries.contact_id` references contacts with `ON DELETE SET NULL`.
  - `list_memberships.contact_id` references contacts with `ON DELETE CASCADE`.
- `.plans/add-contact-list-suppression-management.md`
  - has one trailing blank line at EOF flagged by `git diff --check 9f0e637..HEAD`.

Validation currently passes with `pnpm check`, but the commit-range whitespace check fails on the plan file.

## Key Implementation Assumptions

- All API contact email inputs remain normalized through `normalizeValidEmail()` / schema decoding before reaching write functions.
- The `contacts.email` database column and existing lookups rely on case-normalized email behavior. If a future path bypasses lowercase normalization, conflict guards and uniqueness expectations can diverge.
- `Database.transaction(...)` uses `BEGIN IMMEDIATE`, so wrapping the contact update check/update/readback sequence serializes SQLite writers on the connection and removes the check-then-update interleaving race.
- The production Bun SQLite connection has `PRAGMA busy_timeout = 5000` in `DatabaseBunLive`; contention can still fail as `DatabaseError` if the DB is busy beyond timeout, but the expected same-email conflict should be typed as `ConflictError` once the write lock is acquired.

## Chosen Strategy

Use a small, focused cleanup pass:

1. Make `updateContactEmail()` race-safe by wrapping the existing explicit existence check, conflict check, update, and readback in a single `db.transaction(...)`.
2. Do **not** rewrite the update into a new guarded `UPDATE ... WHERE NOT EXISTS ... RETURNING` SQL shape; the transaction is simpler and preserves the current readable typed-error flow.
3. Add route-level permission and persistence regression tests because the relevant behavior is externally observable HTTP/API behavior.
4. Remove only the trailing blank line in the existing milestone plan/progress file.

### Why this strategy

- It targets real correctness and regression risks without expanding the API surface.
- It preserves the current clean module split and avoids premature shared abstractions.
- It uses existing DB/service/error patterns.
- It avoids adding an ambiguous atomic SQL update that would need extra reads to distinguish not-found from conflict.

## Alternatives Considered

### Alternative A — Atomic `UPDATE ... WHERE NOT EXISTS ... RETURNING`

Rejected for this cleanup. It can work, but it is more complex than needed because it creates a no-row ambiguity: missing contact and conflicting email both look like “no row updated” until another read disambiguates them. A transaction-wrapped explicit check is easier to read and fits the current code.

### Alternative B — Catch SQLite unique constraint errors in `updateContactEmail()` only

Rejected as the primary approach because this repo generally avoids raw constraint-error control flow where a clear typed SQL path is feasible. It can remain a fallback if an implementation finds an unavoidable edge, but it should not be the first-choice design.

### Alternative C — Transaction-wrap `createOrGetContact()` by default

Not chosen as a default fix. `createOrGetContact()` already uses `ON CONFLICT(email) DO NOTHING`, so it should not leak a unique-constraint conflict as `500`. A transaction only closes a narrow concurrent-delete window between insert/no-op and readback. Keep it optional and only do it if the implementer values that extra robustness enough to accept the additional write-lock acquisition.

### Alternative D — Add contact audit/versioning or rewrite delivery/suppression data

Rejected. The issue is conflict mapping and test coverage, not missing audit semantics. Current product semantics deliberately keep delivery snapshots and suppressions independent from contact metadata edits.

### Alternative E — Refactor repeated route helpers

Rejected. The repeated `readJsonBody()` and decode helpers are small and local. Refactoring them does not address the review findings and could reduce route readability.

## Detailed Implementation Tasks

### Phase 1 — Contact update race hardening

File: `apps/service/src/contacts/write.ts`

1. Refactor `updateContactEmail()` so it gets `Database`, then runs a transaction around the current logic.
2. Keep the existing readable flow inside the transaction:
   - read target contact with `getContactRow(contactId)`
   - if absent, fail `NotFoundError({ message: "Contact not found." })`
   - check for a conflicting different contact:
     ```sql
     SELECT id
     FROM contacts
     WHERE email = $email COLLATE NOCASE
       AND id <> $contactId
     LIMIT 1;
     ```
   - if conflict exists, fail `ConflictError({ message: "Another contact already uses this email." })`
   - run the existing update
   - read back and return the contact
3. Keep no-op/current-email/case-normalization updates returning `200`.
4. Preserve the public function signature:
   ```ts
   Effect.Effect<ContactWriteResult, ConflictError | DatabaseError | NotFoundError, DatabaseService>
   ```
5. Keep transaction work DB-only. `currentIso` and synchronous DB calls are acceptable under this repo’s transaction rules; do not add promises, network calls, sleeps, or external effects inside the transaction.
6. After the refactor, ensure the existing update conflict test still returns `409 conflict`.

Suggested structure:

```ts
export function updateContactEmail(contactId: string, email: string) {
  return Effect.gen(function* () {
    const db = yield* Database;
    return yield* db.transaction(updateContactEmailRows(contactId, email));
  });
}
```

`updateContactEmailRows()` can stay private to `contacts/write.ts`.

### Phase 2 — Optional contact create hardening

File: `apps/service/src/contacts/write.ts`

Default recommendation: **skip unless the implementer wants extra robustness for concurrent delete/create churn**.

If implemented:

1. Wrap `createOrGetContact()`'s insert + readback in `db.transaction(...)`.
2. Keep `INSERT ... ON CONFLICT(email) DO NOTHING RETURNING id` unchanged.
3. Preserve response semantics:
   - `201` with `created: true` when inserted
   - `200` with `created: false` when already existed
4. Do not add extra locks or new behavior beyond the normal SQLite transaction.

If skipped, note in the implementation summary: create already uses `ON CONFLICT DO NOTHING`; the only uncovered window is concurrent deletion before readback.

### Phase 3 — Add inverse permission tests

Files:

- `apps/service/src/contacts/routes.test.ts`
- `apps/service/src/lists/routes.test.ts`
- `apps/service/src/suppressions/routes.test.ts`

Add focused assertions that read-only API keys cannot write. Use small valid bodies so the expected `403` is not masked by body validation or body-size middleware. The current middleware order is `bodyLimit` before `requirePrincipal`, so avoid oversized bodies in permission tests.

#### Contacts

Add a test or extend the existing auth test to assert API key with `{ contacts: ["read"] }` receives `403` for representative write endpoints:

- `POST /api/contacts`
- `PATCH /api/contacts/:id`
- `DELETE /api/contacts/:id` if keeping the test compact is still easy

The target row does not need to exist for a pure permission test because auth should deny before domain code runs, but use syntactically valid IDs and bodies.

#### Lists

Assert API key with `{ lists: ["read"] }` receives `403` for representative write endpoints:

- `POST /api/lists`
- `PATCH /api/lists/:id`
- `POST /api/lists/:id/contacts`
- `DELETE /api/lists/:id/contacts/:contactId`
- optionally `DELETE /api/lists/:id`

#### Suppressions

Assert API key with `{ suppressions: ["read"] }` receives `403` for:

- `POST /api/suppressions`
- `DELETE /api/suppressions/:id`

Keep the existing write-only-cannot-read tests; they remain valuable.

### Phase 4 — Add contact update snapshot/suppression regression test

File: `apps/service/src/contacts/routes.test.ts`

Add or extend a test to prove `PATCH /api/contacts/:id` does not rewrite historical data or safety records.

Recommended test shape:

1. Use the existing `seedContactScenario(runtime)` helper because it already creates:
   - `contact_1` with `User@Example.com`
   - a membership
   - a delivery snapshot with `email = 'user@example.com'` and `contact_id = 'contact_1'`
   - a suppression with `email = 'user@example.com'`
2. Send `PATCH /api/contacts/contact_1` with `{ "email": "new@example.com" }`.
3. Assert response contact email is `new@example.com`.
4. Query DB and assert:
   - `deliveries.email` for `delivery_1` is still `user@example.com`.
   - `deliveries.contact_id` for `delivery_1` is still `contact_1`.
   - suppression for `user@example.com` still exists.
   - no suppression for `new@example.com` was auto-created or rewritten.

This locks in the documented safety semantics from `README.md` and `PROJECT.md`.

### Phase 5 — Whitespace cleanup

File: `.plans/add-contact-list-suppression-management.md`

Remove the extra trailing blank line at EOF so the file ends immediately after the final tracker line, with exactly one terminal newline.

Do not rewrite the plan content.

### Phase 6 — Validation

Run focused checks first:

```sh
pnpm test apps/service/src/contacts
pnpm test apps/service/src/lists
pnpm test apps/service/src/suppressions
```

Then run broader checks:

```sh
pnpm test apps/service/src/mailings
git diff --check
pnpm check
```

For the whitespace finding specifically, validate the relevant committed range when reviewing the resulting commit/history:

```sh
git diff --check 9f0e637..HEAD
```

If the base changes, use the appropriate merge-base/range for the recipient-management work. The important point is that the range containing `.plans/add-contact-list-suppression-management.md` must no longer report the trailing blank line.

Expected results:

- focused route tests pass
- mailings tests still pass
- `git diff --check` passes for the working diff
- committed-range `git diff --check 9f0e637..HEAD` no longer reports the trailing blank line after the fix is represented in history
- `pnpm check` passes with only the existing `main.integration.test.ts` no-await-in-loop warnings, unless those are separately fixed outside this plan

## Files Likely to Change

- `apps/service/src/contacts/write.ts`
- `apps/service/src/contacts/routes.test.ts`
- `apps/service/src/lists/routes.test.ts`
- `apps/service/src/suppressions/routes.test.ts`
- `.plans/add-contact-list-suppression-management.md`

No expected changes to:

- migrations
- route URLs
- response JSON shapes
- permissions definitions
- docs, unless implementation discovers a mismatch while adding tests

## Risks and Mitigations

### Risk: transaction body accidentally includes suspended/non-DB work

Mitigation: keep transaction bodies limited to `currentIso`, `db.get`, `db.run`, and readback via DB helpers. Avoid external calls or promises.

### Risk: SQLite busy timeout still produces `DatabaseError`

Mitigation: this plan fixes the expected application-level same-email conflict path after the write lock is acquired. Keep DB busy handling as an operational concern covered by existing `busy_timeout`; do not broaden this cleanup into connection-pool or retry design.

### Risk: normalization invariant regresses later

Mitigation: keep route schemas as the only public write entrypoints and preserve lowercase normalization before DB writes. Existing mixed-case create/import tests plus the conflict/no-op tests help pin this.

### Risk: tests become too broad/noisy

Mitigation: add one focused inverse-permission test per route area instead of duplicating every endpoint happy path in detail.

### Risk: contact create transaction is unnecessary churn

Mitigation: default to skipping Phase 2 unless the implementer explicitly chooses to close the concurrent-delete readback window.

## Definition of Done

- `updateContactEmail()` runs its existence check, conflict check, update, and readback in one DB transaction.
- Contact current-email/no-op update still succeeds.
- Contact update conflict still returns `409 conflict` with the existing message.
- Contact update regression proves delivery email snapshot, delivery contact linkage, and suppressions are not rewritten.
- Read-only API keys are tested against representative write endpoints for contacts, lists, and suppressions.
- `.plans/add-contact-list-suppression-management.md` no longer fails whitespace checks.
- Validation commands pass:
  - `pnpm test apps/service/src/contacts`
  - `pnpm test apps/service/src/lists`
  - `pnpm test apps/service/src/suppressions`
  - `pnpm test apps/service/src/mailings`
  - `git diff --check`
  - committed-range `git diff --check 9f0e637..HEAD` or equivalent review range
  - `pnpm check`

## Independent Review Notes

The draft plan was reviewed with Claude CLI. Useful feedback incorporated:

- Simplified the main race fix from atomic guarded SQL to a transaction-wrapped version of the existing explicit checks.
- Made lowercase email normalization a stated load-bearing invariant.
- Downgraded contact create transaction hardening to optional and named the narrow concurrent-delete scenario it protects.
- Clarified the test plan around deterministic conflict coverage, valid small bodies for permission tests, and preserving `deliveries.contact_id`.
- Fixed validation guidance so the whitespace issue is checked against the relevant commit range, not only the working diff.

## Open Questions

None. The plan intentionally keeps scope limited to cleanup and hardening of the current implementation.

## Implementation Progress

Progress tracker for implementing this plan. Keep this section updated before/after each loop and before final validation.

### Loop Breakdown

| Loop | Scope | Status | Verification |
| --- | --- | --- | --- |
| 1 | Contact update transaction hardening | Complete | `pnpm test apps/service/src/contacts` passed (5 tests) |
| 2 | Permission and snapshot/suppression regression tests | Complete | `pnpm test apps/service/src/contacts apps/service/src/lists apps/service/src/suppressions` passed (17 tests) |
| 3 | Whitespace cleanup | Complete | Removed extra blank line at EOF; `git diff --check` and `git diff --check 9f0e637` passed |
| 4 | Final validation and independent review | Complete | Focused tests, mailings tests, diff checks, `pnpm check`, and final Claude review passed |

### Notes

- **Plan read:** Completed full read before source edits.
- **Initial analysis:** The plan is concrete and non-ambiguous. No human checkpoint needed before implementation because scope is limited to tests, one transaction refactor, and whitespace cleanup.
- **Parallelism decision:** No safe parallel writer work; target files are small and related. Independent reviews will be used after implementation steps instead.
- **Browser/manual verification:** Not applicable; this is JSON API/test/database behavior only with no browser-visible UI changes.
- **Phase 2 decision:** Skipped. `createOrGetContact()` already uses `ON CONFLICT(email) DO NOTHING`; the optional concurrent-delete/readback hardening is outside the default fix and was not needed for the reviewed findings.
- **Loop 1 result:** `updateContactEmail()` now wraps existence check, conflict check, update, and readback in `db.transaction(...)`; existing contact route tests passed.
- **Loop 2 result:** Added read-only API-key write-denial coverage for contacts/lists/suppressions and a contact email update regression proving delivery snapshot email, delivery contact linkage, and old/new suppression rows are preserved as intended.
- **Loop 3 result:** Removed only the extra trailing blank line from `.plans/add-contact-list-suppression-management.md`.
- **Loop 4 validation:** `pnpm test apps/service/src/contacts apps/service/src/lists apps/service/src/suppressions` passed (17 tests); `pnpm test apps/service/src/mailings` passed (40 tests); `git diff --check` passed; `git diff --check 9f0e637` passed for the base-to-worktree review range; `pnpm check` passed with only the pre-existing `apps/service/src/main.integration.test.ts` no-await-in-loop warnings (42 files, 269 tests).
- **Committed-range note:** `git diff --check 9f0e637..HEAD` still reflects already-committed history and will not include the whitespace cleanup until these worktree changes are committed; the equivalent base-to-worktree check `git diff --check 9f0e637` passes.

### Review Log

| Review | Scope | Status | Findings |
| --- | --- | --- | --- |
| Step review | Post-loop implementation diff | Complete | Claude review found no blockers. Low note: race-safety is code-reviewed rather than covered by a deterministic concurrency test; accepted because plan did not require a hard-to-write concurrency test. |
| Final review | Full plan completion | Complete | Claude follow-up confirmed no remaining blockers/major issues, all Definition of Done items met, and tracker accuracy was honest. |
