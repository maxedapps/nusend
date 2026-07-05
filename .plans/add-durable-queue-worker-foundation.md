# Plan: Add Durable Queue and Worker Foundation

## Summary

Implement Nusend’s durable SQLite queue foundation before adding SES sending. This slice adds atomic job claiming, leases, retries, backoff, expired-lease recovery, completion/dead-letter transitions, and a testable worker runner with injected processors.

This plan intentionally does **not** send email and does **not** add a production worker command that can consume real `send_delivery` jobs without a real SES processor.

## Confirmed Requirements and Assumptions

- Keep the codebase lean: no external queue package, no ORM, no new workspace packages.
- Continue using Bun runtime and `bun:sqlite`.
- Use the existing `jobs` table in `apps/service/src/db/migrations/sql/0001_initial_schema.sql`.
- Do not integrate AWS SES in this slice.
- Do not mark real `send_delivery` jobs as succeeded via fake/no-op processing.
- Preserve current `POST /api/mailings` behavior: it creates `send_delivery` jobs with `state='queued'` and `run_at=scheduledAt`.
- Use root Vitest tests that spawn Bun subprocesses for code that imports `bun:sqlite`, matching the current pattern.
- Treat this as queue/worker **foundation**: runtime `apps/service/src/worker.ts` and package scripts should wait until a real SES processor exists, unless the entrypoint exits safely without claiming jobs.

## Research Findings

- Bun `Database({ strict: true })` controls parameter binding behavior, not transaction semantics. Queue correctness must come from SQL predicates and transactions. Source: https://bun.sh/docs/runtime/sqlite
- SQLite supports `UPDATE ... RETURNING`; returned rows reflect post-update values. This fits an atomic job-claim statement. Sources: https://www.sqlite.org/lang_returning.html and https://www.sqlite.org/lang_update.html
- `RETURNING` row order is not guaranteed. Candidate fairness should be controlled in the selection subquery, not by relying on returned row order. Source: https://www.sqlite.org/lang_returning.html
- SQLite WAL improves reader/writer concurrency but still uses single-writer behavior and can still hit `SQLITE_BUSY`; the existing `PRAGMA busy_timeout = 5000` should remain and test file DBs should mirror production pragmas. Sources: https://www.sqlite.org/wal.html and https://sqlite.org/lang_transaction.html
- Time values stored as ISO strings only compare correctly if every value uses the same fixed-width UTC format. Nusend currently uses `new Date().toISOString()` and SQLite defaults like `%Y-%m-%dT%H:%M:%fZ`; queue code must not mix in SQLite `datetime()` strings such as `YYYY-MM-DD HH:MM:SS`.

## Current-State Findings

- `PROJECT.md:480-532` defines the queue model: atomic claims, leases, retry with backoff, `dead` as DLQ, lease expiry recovery.
- `PROJECT.md:554-572` defines the future SES worker flow, but SES itself is not present yet.
- `apps/service/src/db/migrations/sql/0001_initial_schema.sql` already has:
  - `jobs(id, kind, state, run_at, attempts, max_attempts, locked_by, locked_until, ref_id, last_error, created_at, updated_at)`
  - indexes on `(state, run_at)`, `locked_until`, and `(kind, ref_id)`
- `apps/service/src/mailings/create-mailing.ts` already enqueues `send_delivery` jobs for unsuppressed deliveries.
- There is no `apps/service/src/queue/` folder, no queue transition module, and no worker runner.
- `pnpm check` currently passes: 10 test files, 52 tests.

## Chosen Strategy

Build small internal queue modules plus a processor-injected runner:

1. `queue/time.ts`: one ISO UTC time helper used by queue code.
2. `queue/backoff.ts`: deterministic retry delay calculation.
3. `queue/jobs.ts`: atomic SQLite queue operations.
4. `queue/runner.ts`: `runOnce()` / `drainOnce()` with an injected processor.
5. Tests using real SQLite databases and fake processors.

Do **not** add a package-level `start:worker` script yet. A real runtime worker should be added with the SES `send_delivery` processor, otherwise queued email jobs could be consumed without being sent.

## Alternatives Considered

### Alternative A: Implement SES sender directly now

Rejected for this slice. SES adds AWS credentials, provider errors, configuration sets, message IDs, send attempts, and at-least-once ambiguity. Queue correctness should be isolated first.

### Alternative B: Add a no-op worker that marks `send_delivery` jobs succeeded

Rejected. It would corrupt delivery state and make unsent emails appear sent.

### Alternative C: Add an external queue library

Rejected. The project intentionally uses a lean SQLite-backed queue, and the schema already exists.

### Alternative D: Use `SELECT` then `UPDATE` in separate statements for claims/failures

Rejected where avoidable. Use single-statement `UPDATE ... RETURNING` for claims and `UPDATE ... CASE ... RETURNING` for fail/release transitions.

### Alternative E: Implement a continuous polling loop now

Mostly deferred. With no real processor, `runOnce()` / `drainOnce()` provides the useful foundation. A long-running loop, `AbortSignal` handling, runtime config, and package scripts can be added with SES sender integration.

## Implementation Tasks

### 1. Add queue time helper

Create `apps/service/src/queue/time.ts`.

Required helpers:

```ts
export function nowIso(): string;
export function addSecondsIso(isoTime: string, seconds: number): string;
```

Rules:

- Always return `Date#toISOString()` format.
- Do not use SQLite `datetime()` for queue timestamps.
- Add tests asserting fixed shape, UTC `Z`, and chronological lexicographic order for representative values.

This protects `run_at <= $now` and `locked_until <= $now` string comparisons.

### 2. Add queue types and row mapping

Create `apps/service/src/queue/jobs.ts` with types:

```ts
export type JobKind = "process_ses_event" | "send_delivery";
export type JobState = "queued" | "leased" | "succeeded" | "failed" | "dead" | "cancelled";

export type QueueJob = {
  id: string;
  kind: JobKind;
  state: JobState;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  refId: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Use SQL aliases in every `RETURNING` / `SELECT`, e.g. `run_at AS runAt`, because `bun:sqlite` returns column names as queried.

### 3. Implement atomic job claiming

Add `claimJobs(db, options)`.

Inputs:

- `workerId: string`
- `now?: string`
- `leaseSeconds?: number`
- `limit?: number`
- optional `kinds?: JobKind[]`

Behavior:

- Claim only `state='queued'` jobs with `run_at <= now`.
- Order candidate IDs by `run_at ASC, created_at ASC, id ASC` in the subquery.
- Update selected rows to:
  - `state='leased'`
  - `attempts = attempts + 1`
  - `locked_by = workerId`
  - `locked_until = addSecondsIso(now, leaseSeconds)`
  - `updated_at = now`
- Return claimed rows via `.all()` on `UPDATE ... RETURNING`.
- Use defensive outer predicates and parameterized kind filters.

Reference SQL shape:

```sql
UPDATE jobs
SET state = 'leased',
    attempts = attempts + 1,
    locked_by = $workerId,
    locked_until = $lockedUntil,
    updated_at = $now
WHERE state = 'queued'
  AND run_at <= $now
  AND id IN (
    SELECT id
    FROM jobs
    WHERE state = 'queued'
      AND run_at <= $now
      -- optional AND kind IN (...)
    ORDER BY run_at ASC, created_at ASC, id ASC
    LIMIT $limit
  )
RETURNING
  id,
  kind,
  state,
  run_at AS runAt,
  attempts,
  max_attempts AS maxAttempts,
  locked_by AS lockedBy,
  locked_until AS lockedUntil,
  ref_id AS refId,
  last_error AS lastError,
  created_at AS createdAt,
  updated_at AS updatedAt;
```

### 4. Implement completion with ownership checks

Add `completeJob(db, options)`.

Inputs:

- `jobId`
- `workerId`
- `now`

Behavior:

- Only complete rows where `id=$jobId`, `state='leased'`, and `locked_by=$workerId`.
- Set:
  - `state='succeeded'`
  - `locked_by=NULL`
  - `locked_until=NULL`
  - `last_error=NULL`
  - `updated_at=now`
- Return a discriminated result such as:

```ts
{ ok: true; job: QueueJob } | { ok: false; reason: "not_leased_by_worker" }
```

Do not throw for ordinary stale lease / wrong worker cases.

### 5. Implement retry and dead-letter failure handling

Add `failJob(db, options)`.

Inputs:

- `jobId`
- `workerId`
- `errorMessage`
- `now`

Behavior:

- Only affect rows where `id=$jobId`, `state='leased'`, and `locked_by=$workerId`.
- Because `attempts` increments on claim, compare current `attempts` against `max_attempts`.
- Use one `UPDATE ... CASE ... RETURNING` statement.
- If `attempts >= max_attempts`:
  - set `state='dead'`
  - clear lock fields
  - store truncated `last_error`
  - set `updated_at=now`
- Else:
  - set `state='queued'`
  - set `run_at = addSecondsIso(now, backoffSeconds(attempts))`
  - clear lock fields
  - store truncated `last_error`
  - set `updated_at=now`

The `failed` state exists in the schema but should remain unused in this slice. This intentionally skips the transient `leased -> failed -> queued` state from `PROJECT.md` to keep retries simple; `dead` is the operational DLQ.

### 6. Implement expired lease recovery

Add `releaseExpiredLeases(db, options)`.

Inputs:

- `now`
- optional `limit`

Behavior:

- Find `state='leased' AND locked_until <= now`.
- Use one `UPDATE ... CASE ... RETURNING` statement where possible.
- For expired jobs with `attempts >= max_attempts`, set `state='dead'`.
- For expired jobs with attempts remaining:
  - set `state='queued'`
  - set `run_at = addSecondsIso(now, backoffSeconds(attempts))`
- Clear lock fields and update `updated_at`.
- Return affected rows or counts.

Backoff on lease expiry is required to avoid hot crash loops that burn all attempts immediately.

### 7. Implement backoff helper

Create `apps/service/src/queue/backoff.ts`.

Recommended helper:

```ts
export function calculateBackoffSeconds(attempts: number): number;
```

Use simple capped exponential backoff:

```txt
attempt 1 -> 60s
attempt 2 -> 120s
attempt 3 -> 240s
...
cap at 3600s
```

No random jitter in this slice; deterministic tests matter more.

### 8. Implement processor-injected runner

Create `apps/service/src/queue/runner.ts`.

Types:

```ts
export type JobProcessor = (job: QueueJob) => Promise<void>;

export type RunOnceOptions = {
  db: Database;
  workerId: string;
  processJob: JobProcessor;
  now?: () => string;
  leaseSeconds?: number;
  batchSize?: number;
  kinds?: JobKind[];
};
```

Behavior for `runOnce()`:

1. Compute a single `now` value for lease release/claim.
2. Call `releaseExpiredLeases()`.
3. Call `claimJobs()`.
4. For each claimed job:
   - call the injected `processJob(job)` outside claim/transition statements
   - on success call `completeJob()`
   - on failure call `failJob()` with the thrown error message
5. Return counts: released, claimed, succeeded, failed, dead, skipped/stale.

Optional `drainOnce()`:

- Repeatedly call `runOnce()` until no jobs are claimed, with a max iteration guard.
- Useful for tests only.

Do not add a long-running sleep/poll loop yet unless it is fully tested and still cannot process real `send_delivery` jobs without SES.

### 9. Do not add runtime worker scripts yet

Preferred for this slice:

- Do not add `apps/service/src/worker.ts`.
- Do not add `start:worker` or `dev:worker` to `apps/service/package.json`.

Reason: there is no real `send_delivery` processor. A production command that claims jobs now is unsafe.

If an entrypoint is added anyway, it must exit before claiming jobs and must clearly say that runtime processors are not registered yet.

### 10. Add tests

Use Vitest tests that spawn Bun scripts via `apps/service/src/testing/bun-scenario.ts`, as current DB tests do.

Because only the process runner is shared today, either:

- accept some local scenario preamble duplication, matching current tests; or
- first extract a tiny reusable test preamble/helper for migrated SQLite DB creation.

Do not assume `createMigratedDatabase()` already exists globally; it is currently inline in test files.

Recommended tests:

#### `apps/service/src/queue/time.test.ts`

- `nowIso()` / `addSecondsIso()` return `toISOString()`-shaped values.
- adding seconds preserves fixed-width UTC format.
- lexicographic order matches chronological order for generated values.

#### `apps/service/src/queue/backoff.test.ts`

- deterministic delays for attempts 1, 2, 3.
- cap behavior.
- invalid attempts are handled predictably.

#### `apps/service/src/queue/jobs.test.ts`

- claims due queued jobs only.
- does not claim future scheduled jobs.
- respects `limit`.
- optionally respects `kinds`.
- increments `attempts` on claim.
- sets `locked_by` and `locked_until`.
- `completeJob()` succeeds only for the owning worker.
- `failJob()` requeues with ISO `run_at` and backoff while attempts remain.
- `failJob()` marks `dead` at `max_attempts`.
- `releaseExpiredLeases()` requeues with backoff or dead-letters correctly.
- cancelled/succeeded/dead jobs are never claimed; seed those states directly unless a `cancelJob()` helper is added.
- file-based DB tests should use the same pragmas as production: foreign keys, WAL, busy timeout, synchronous normal, trusted schema off where supported.

#### `apps/service/src/queue/runner.test.ts`

- successful fake processor completes a job.
- throwing fake processor requeues or dead-letters a job.
- processor is called after the job is claimed and no long transaction is held around processor execution as far as observable.
- stale completion/failure results do not crash the runner.

#### Concurrency smoke

Add a meaningful two-process smoke only if practical:

- create a temporary SQLite file with many queued jobs.
- spawn two Bun child processes that repeatedly call `claimJobs()` against the same DB file.
- assert no claimed job ID appears in both processes.

If this is too much for the slice, skip it and rely on single-statement SQL correctness; do not add a single-process “two connections” test and call it a concurrency guarantee.

### 11. Update docs minimally

Update `README.md` only if useful:

- mailings enqueue jobs.
- queue primitives exist.
- jobs are not sent until the SES sender/worker slice is implemented.

Avoid documenting internal module APIs heavily.

## Likely Files to Add or Change

Add:

- `apps/service/src/queue/time.ts`
- `apps/service/src/queue/backoff.ts`
- `apps/service/src/queue/jobs.ts`
- `apps/service/src/queue/runner.ts`
- `apps/service/src/queue/time.test.ts`
- `apps/service/src/queue/backoff.test.ts`
- `apps/service/src/queue/jobs.test.ts`
- `apps/service/src/queue/runner.test.ts`

Possibly change:

- `apps/service/src/testing/bun-scenario.ts` if extracting reusable migrated-DB test setup is worth it.
- `README.md` for a short status note.

Avoid changing:

- `apps/service/src/db/migrations/sql/0001_initial_schema.sql` unless a concrete schema issue is found.
- auth files.
- mailings route/service behavior.
- `apps/service/package.json` worker scripts until a real processor exists.

## Data / Schema Changes

Expected: none.

The existing `jobs` table has the columns required for this slice. If a schema issue is discovered, add a new `0003_queue.sql` migration instead of editing applied migrations.

Known schema handoff for the SES slice:

- `jobs_kind_ref_id_idx` is non-unique today. Before actual SES sending, decide whether to add a partial unique index for active `send_delivery` jobs or enforce duplicate-job prevention in enqueue/sender logic. Duplicate `send_delivery` jobs can become duplicate emails.

## API / Interface Changes

Expected: no public HTTP API changes.

This slice creates internal TypeScript APIs. Queue admin API/CLI remains a later task unless explicitly approved separately.

## Testing and Verification Plan

Run:

```sh
pnpm format
pnpm check
pnpm test -- apps/service/src/queue
```

If adding a two-process concurrency smoke, run it as part of the queue test suite or document the focused command.

Expected verification:

- existing tests still pass.
- new queue tests pass.
- no runtime command consumes `send_delivery` jobs.
- queued jobs remain queued unless tests explicitly invoke queue primitives.

## Rollout / Compatibility Notes

- Existing databases already have the `jobs` schema from migration `0001_initial_schema.sql`; no migration should be required.
- Existing queued jobs remain untouched until queue functions or a future worker/processor intentionally run.
- Once SES sending is implemented, the runtime worker can register a `send_delivery` processor and reuse these queue primitives.

## Risks and Mitigations

- **Risk: broken time comparisons due to mixed timestamp formats.**
  - Mitigation: central ISO helper; no SQLite `datetime()` strings; tests for format and lexicographic order.
- **Risk: accidentally consuming real email jobs without sending.**
  - Mitigation: no no-op production worker; no worker package script until SES processor exists.
- **Risk: duplicate job claims under concurrency.**
  - Mitigation: single-statement `UPDATE ... RETURNING`, defensive predicates, optional true two-process smoke.
- **Risk: permanently stuck leased jobs after worker crash.**
  - Mitigation: `releaseExpiredLeases()` before claim cycles.
- **Risk: hot crash loops.**
  - Mitigation: release expired leases back to `queued` with backoff, or `dead` if attempts are exhausted.
- **Risk: duplicate SES sends in future.**
  - Mitigation: explicitly address duplicate `send_delivery` jobs before SES sender is enabled.
- **Risk: processing time exceeds lease duration.**
  - Mitigation: future SES worker should use small batch sizes, conservative lease durations, and accept at-least-once semantics. For slow processors, claim one job at a time or add lease extension later.
- **Risk: SQLite busy/locking behavior differs in tests.**
  - Mitigation: file-based queue tests should mirror production pragmas.
- **Risk: lack of operator visibility for dead jobs.**
  - Mitigation: runner should log or return dead-letter transitions. Full queue admin UI/API can follow later.

## Open Questions

None blocking.

Implementation-time choice: whether to extract shared Bun scenario DB setup before adding queue tests. Prefer extraction only if it reduces obvious duplication without creating a broad test framework.


## Implementation Progress

- [x] Read full plan before editing.
- [x] Started retained progress tracking in this plan.
- [x] Launched read-only `scout` subagent for local context/pitfalls.
- [x] Decompose queue implementation and implement modules/tests.
- [x] Run focused validation (`pnpm format`, `pnpm check`, `pnpm test -- apps/service/src/queue`).
- [x] Perform independent review pass after implementation and address material feedback.
- [x] Perform final validation/review and summarize deviations.

### Implementation Notes

- 2026-07-03: Plan path explicitly provided by user; using this exact file. No safe parallel writer work identified because modules/tests are tightly coupled; main agent will implement sequentially and use subagents for read-only context/review.

### Progress Update 2026-07-03 09:18

- Implemented sequentially in main worktree (no parallel writers):
  - `apps/service/src/queue/time.ts`
  - `apps/service/src/queue/backoff.ts`
  - `apps/service/src/queue/jobs.ts`
  - `apps/service/src/queue/runner.ts`
  - queue-focused tests for time, backoff, jobs, runner
- Used read-only scout result from `.pi-subagents/artifacts/outputs/40576734-0d02-47c6-ab1f-2f1188c3679b/queue-scout-context.md` for local test/DB context.
- Deviation: skipped optional true two-process concurrency smoke for now; relying on single-statement `UPDATE ... RETURNING` plus focused tests unless review indicates this is insufficient for this slice.
- Validation run:
  - `pnpm test -- apps/service/src/queue` passed: 14 test files / 66 tests.
  - `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test -- apps/service/src/queue` passed.

### Review Update 2026-07-03 09:24

- Independent Claude review session: `1c4b882d-c908-4842-97f2-da41496f2f6f`.
- Review verdict: no material production-breaking bugs; plan conformance confirmed.
- Addressed accepted low/nit feedback:
  - Sorted `claimJobs()` results by `runAt`, `createdAt`, `id` so runner/test behavior does not rely on SQLite `RETURNING` order.
  - Added coverage for release-expired dead-letter count and attempts=4 SQL backoff branch.
  - Removed no-op try/catch from runner scenario test wrapper.
- Deferred feedback:
  - True two-process concurrency smoke remains deferred until before SES sender integration; plan allowed skipping it in this slice.
  - `released` count includes both requeued and dead expired leases; left as-is because the result also separately reports `dead` and the count means affected expired leases.
- Validation after fixes:
  - `pnpm format && pnpm check && pnpm test -- apps/service/src/queue` passed.

### Final Review Update 2026-07-03 09:27

- Final independent Claude review session: `52bccebd-0963-44b4-bf51-e948110a2e79`.
- Verdict: no material unresolved concerns; implementation matches plan and no accidental runtime worker behavior exists.
- Cosmetic tracker checkbox inconsistency fixed after review.
- Remaining documented caveats:
  - Optional true two-process concurrency smoke is deferred before SES sender integration.
  - `RunOnceResult.released` counts all expired leases affected, including those also counted as `dead`.
