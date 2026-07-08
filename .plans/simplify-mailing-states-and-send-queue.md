# Simplify Mailing State Lifecycle and Send Queue

## Summary

Implement two focused improvements:

1. Replace future-only/unused live states with a small state vocabulary the current code can actually maintain.
2. Simplify the durable queue from a generic job system into a send-delivery-only queue.

This plan intentionally ignores unrelated earlier suggestions. It keeps the valuable sending foundation: `mailings`, `deliveries`, `jobs`, `send_attempts`, idempotent mailing creation, short DB transactions, and SES calls outside transactions.

## Clarification status and assumptions

No clarification is needed before planning. Assumptions based on the user's feedback:

- `PROJECT.md` should describe both current implementation and future roadmap, but live code/schema should not expose future-only states until their feature exists.
- The queue should be send-delivery-specific because Nusend does not need a generic internal job platform.
- We should not revisit marketing creation/policy behavior or other earlier suggestions.
- For mailings, choose the useful state advancement path (`scheduled -> sending -> completed`) rather than the ultra-minimal alternative of keeping only `scheduled`. This adds a small amount of runtime code but makes the state meaningful immediately.

## Current-state findings

Relevant files:

- DB schema: `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
- Mailing creation: `apps/service/src/mailings/create-mailing.ts`
- Idempotency: `apps/service/src/mailings/idempotency.ts`
- Queue: `apps/service/src/queue/schema.ts`, `apps/service/src/queue/jobs.ts`, `apps/service/src/queue/runner.ts`
- Sending: `apps/service/src/sending/worker.ts`, `apps/service/src/sending/process-delivery.ts`, `apps/service/src/sending/attempts.ts`, `apps/service/src/sending/context.ts`, `apps/service/src/sending/schema.ts`
- Operations: `apps/service/src/operations/read-model.ts`, `apps/service/src/operations/query.ts`
- Docs: `PROJECT.md`, `README.md`

Current DB CHECK constraints include future or unused states:

```txt
mailings.state:
  draft | scheduled | sending | paused | cancelled | completed

deliveries.status:
  scheduled | queued | sending | sent | delivered | bounced | complained | failed | suppressed | cancelled

jobs.state:
  queued | leased | succeeded | failed | dead | cancelled
```

Actual behavior today:

- Mailing creation always inserts `mailings.state = 'scheduled'`.
- Worker processing does not advance mailing state to `sending` or `completed`.
- Delivery creation uses `queued` or `suppressed`; it never uses `scheduled`.
- Sending uses `queued`, `sending`, `sent`, `failed`, and `suppressed`.
- SES event states `delivered`, `bounced`, and `complained` are roadmap-only.
- Job code uses `queued`, `leased`, `succeeded`, and `dead`; it never sets `failed` or `cancelled`.
- Queue code is generic even though the only kind is `send_delivery`.

Important queue/state coupling issue:

- On retryable transport failure, `processSendDeliveryJob` sets delivery back to `queued`.
- Then the queue runner calls `failJob`, which may requeue or dead-letter the job.
- If the job becomes `dead`, no current send-specific logic marks the delivery terminal.
- Expired leased jobs can also become `dead` during lease release, bypassing `processSendDeliveryJob` entirely.
- Mailing completion therefore needs send-specific reconciliation for both active failure and expired-lease dead-letter paths.

## Chosen current state vocabulary

Use only states that current implementation can produce and maintain correctly.

```txt
mailings.state:
  scheduled   -- delivery jobs exist and no send attempt has started yet
  sending     -- at least one send attempt has started and some delivery is still non-terminal
  completed   -- all deliveries are terminal; means processing complete, not inbox delivered

deliveries.status:
  queued      -- pending send or retry
  sending     -- worker attempt started / outcome not finalized
  sent        -- SES accepted the message
  failed      -- terminal failure
  suppressed  -- terminal suppression block

jobs.state:
  queued
  leased
  succeeded
  dead

send_attempts.status:
  started
  succeeded
  failed
  ambiguous
```

Future statuses should be added by the feature/migration that makes them real:

- `mailings.paused` / `mailings.cancelled`: pause/cancel APIs.
- `deliveries.delivered` / `bounced` / `complained`: SES event ingestion.
- `deliveries.cancelled`: delivery cancellation.
- `jobs.cancelled`: queue cancellation.
- `mailings.draft`: a real draft workflow.

## Chosen queue strategy

Replace the generic queue abstraction with a send-delivery-only queue.

Schema-level target:

- remove `jobs.kind`
- rename `jobs.ref_id` to `jobs.delivery_id`
- remove unsupported job states `failed` and `cancelled`

Code-level target:

- rename `QueueJob` to `SendDeliveryJob`
- expose `deliveryId`, not `refId`
- remove `JobKind`, `JobKindValues`, `kinds` filters, and `createKindFilter`
- remove `job.kind` checks in `processSendDeliveryJob`
- replace generic `runOnce(processJob)` with a send-specific worker runner
- remove `drainOnce` unless a real production caller needs it; currently it is test-only support

Rationale:

- Matches project scope.
- Makes dead-job delivery reconciliation straightforward.
- Reduces defensive checks and generic type plumbing.

## Alternatives considered

### Alternative A: Keep broad DB enums but advance mailings

Rejected. It fixes one visible problem but keeps operations summaries and API filters full of unsupported states.

### Alternative B: Keep only `mailings.state = scheduled`

Rejected. It is the smallest possible schema, but it loses useful operational signal that is cheap to maintain now. `scheduled -> sending -> completed` can be implemented with a small lifecycle helper and gives the operations API a meaningful high-level progress indicator.

### Alternative C: Use `deliveries.scheduled` for future `scheduledAt`

Rejected. `jobs.run_at` already represents scheduling. A second scheduling source in delivery status would complicate retries because retry backoff also creates future `run_at` values.

### Alternative D: Keep the generic queue with send-specific wrappers/hooks

Rejected for this change. A hook could reduce some churn, but the user explicitly wants the queue to stop pretending to be generic. Since there is no second job kind in project scope, the simpler long-term model is a send-delivery queue.

### Alternative E: Remove the `jobs` table and send directly from deliveries

Rejected. Durable leasing, retry backoff, max attempts, and worker crash recovery are still valuable for real SES sending.

## Implementation plan

### Phase 1 — Add mailing lifecycle helpers

Create:

- `apps/service/src/mailings/lifecycle.ts`

Responsibilities:

1. Define current terminal delivery statuses:

   ```ts
   const terminalDeliveryStatuses = ['sent', 'failed', 'suppressed'] as const;
   ```

2. Add `markMailingSending(mailingId)`:

   - sets `mailings.state = 'sending'`
   - only updates rows currently in `scheduled`
   - updates `updated_at`
   - no-ops for `sending` or `completed`

3. Add `refreshMailingStateForDelivery(deliveryId)`:

   - find `mailing_id` from the delivery
   - no-op if delivery/mailing is missing
   - if every delivery for the mailing is terminal, set `mailings.state = 'completed'`
   - else if any send attempt exists for any delivery in the mailing, set `mailings.state = 'sending'`
   - else set `mailings.state = 'scheduled'`

Recommended helper behavior:

- DB-only Effect code.
- No external I/O.
- Avoid overriding a `completed` mailing back to `sending`.
- Document that `completed` means processing finished, not SES delivery-event confirmation.

### Phase 2 — Advance mailing state during attempt start

Update:

- `apps/service/src/sending/attempts.ts`

Changes:

1. In `startSendAttempt`, inside the existing transaction that:
   - updates delivery `queued -> sending`
   - inserts `send_attempts(status='started')`

   also call/update mailing `scheduled -> sending`.

2. Keep `startSendAttempt` claiming only `deliveries.status = 'queued'`.
3. Do not introduce or revive `deliveries.status = 'scheduled'`.

Expected behavior:

- New mailing starts `scheduled`.
- First real attempt advances it to `sending`.
- Later worker cleanup advances it to `completed` when all deliveries are terminal.

### Phase 3 — Simplify queue types and SQL APIs

Update:

- `apps/service/src/queue/schema.ts`
- `apps/service/src/queue/jobs.ts`
- `apps/service/src/testing/queue-fixtures.ts`

Target type:

```ts
type SendDeliveryJob = {
  id: string;
  state: 'queued' | 'leased' | 'succeeded' | 'dead';
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  deliveryId: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Target functions:

```ts
claimSendDeliveryJobs(options)
claimSendDeliveryJobsAt(now, options)
completeSendDeliveryJob(options)
failSendDeliveryJob(options)
releaseExpiredSendDeliveryLeases(options)
releaseExpiredSendDeliveryLeasesAt(now, options)
```

Remove:

- `JobKind`
- `JobKindValues`
- `kind` from returned rows
- `refId` from returned rows
- `kinds?: JobKind[]`
- `createKindFilter`
- operation labels or tests that assert kind behavior

SQL changes:

- select `delivery_id AS deliveryId`
- no `kind` predicates
- keep ordering and lease/backoff semantics unchanged

### Phase 4 — Replace the generic runner with a send-specific runner

Update:

- `apps/service/src/queue/runner.ts`
- `apps/service/src/sending/worker.ts`
- `apps/service/src/sending/process-delivery.ts`

Recommended shape:

```txt
runSendWorkerOnce
  -> now = currentIso
  -> releaseExpiredSendDeliveryLeasesAt(now)
  -> reconcile released jobs that became dead
  -> claimSendDeliveryJobsAt(now)
  -> process each claimed job sequentially
  -> on processor success:
       completeSendDeliveryJob
       refreshMailingStateForDelivery(job.deliveryId)
  -> on processor failure:
       failedJob = failSendDeliveryJob
       if failedJob.state === 'dead':
         markDeliveryFailedForDeadJob(job.deliveryId, failedJob.lastError or processor error)
       refreshMailingStateForDelivery(job.deliveryId)
```

Keep existing important semantics:

- process jobs sequentially
- stale completion/failure lease conflicts count as `skippedStale`
- retryable processor failures still requeue until max attempts
- durable retry/backoff remains SQL-backed
- one clock snapshot for release + claim remains if tests rely on it

Remove or replace `drainOnce`:

- If it has no production caller, delete it and update tests.
- If tests still need drain behavior, implement a small test-only helper or a send-specific `drainSendWorkerOnce`.

### Phase 5 — Reconcile dead jobs with delivery/mailing state

Add helpers, likely in `apps/service/src/sending/attempts.ts` or `apps/service/src/sending/outcomes.ts`:

1. `markDeliveryFailedForDeadJob({ deliveryId, errorMessage })`

   - set delivery `status = 'failed'`
   - set bounded `last_error`
   - update `updated_at`
   - only update non-terminal statuses (`queued`, `sending`)

2. `markReleasedDeadJobDeliveryAmbiguous({ deliveryId, errorMessage })`

   Use existing `recordStaleSendingAsAmbiguous` where possible. This path matters because expired leased jobs can become `dead` before they are ever claimed again.

Worker reconciliation requirements:

- If `failSendDeliveryJob` returns `dead` after an active retryable processor failure, mark delivery `failed`.
- If `releaseExpiredSendDeliveryLeasesAt` returns a job with state `dead`, mark latest started attempt ambiguous if present, mark delivery `failed`, and refresh mailing state.
- If release requeues the expired lease instead of dead-lettering it, preserve existing conservative behavior: the next claim can identify stale `sending` and mark it ambiguous.

This dead-job reconciliation is necessary for the new `mailings.completed` lifecycle to be reliable.

### Phase 6 — Add a careful SQLite migration

Create:

- `apps/service/src/db/migrations/sql/0002_simplify_send_queue_and_states.sql`

Goals:

1. Restrict `mailings.state` to:
   - `scheduled`
   - `sending`
   - `completed`

2. Restrict `deliveries.status` to:
   - `queued`
   - `sending`
   - `sent`
   - `failed`
   - `suppressed`

3. Restrict `jobs.state` to:
   - `queued`
   - `leased`
   - `succeeded`
   - `dead`

4. Remove `jobs.kind`.
5. Rename `jobs.ref_id` to `jobs.delivery_id`.
6. Preserve `mailing_idempotency_keys` and its FK to `mailings`.
7. Recreate affected indexes.

Important SQLite migration mechanics:

- The migration runner wraps every migration in `db.transaction(...)`.
- `PRAGMA foreign_keys = OFF` cannot be used inside that transaction.
- Use `PRAGMA defer_foreign_keys = ON;` at the start of the migration so FK checks are deferred until commit.
- Be aware that `ALTER TABLE ... RENAME TO ...` rewrites child foreign keys to the renamed parent table when `legacy_alter_table` is off. Rebuild all dependent child tables that need to reference the new parent tables.
- Include `mailing_idempotency_keys` in the rebuild sequence because it references `mailings`.

Recommended table rebuild order:

```txt
PRAGMA defer_foreign_keys = ON;

rename child tables first:
  mailing_idempotency_keys -> mailing_idempotency_keys_old
  send_attempts -> send_attempts_old
  jobs -> jobs_old
  deliveries -> deliveries_old
  mailings -> mailings_old

create new parent-to-child tables:
  mailings
  deliveries
  jobs
  send_attempts
  mailing_idempotency_keys

copy compatible data:
  mailings_old -> mailings
  deliveries_old -> deliveries
  jobs_old(ref_id) -> jobs(delivery_id)
  send_attempts_old -> send_attempts
  mailing_idempotency_keys_old -> mailing_idempotency_keys

recreate indexes

drop old child-to-parent tables:
  mailing_idempotency_keys_old
  send_attempts_old
  jobs_old
  deliveries_old
  mailings_old
```

Copy policy:

- Prefer failing loudly if existing rows contain unsupported future-only states.
- Optionally map only `deliveries.scheduled -> queued` if local data may contain it; avoid silently mapping `bounced`, `complained`, `delivered`, or `cancelled` because that loses semantic meaning.
- Current app code should not have produced unsupported states, so migration failure is acceptable and safer.

Down migration:

- Rebuild back to the old shapes.
- Re-add `jobs.kind` with constant `'send_delivery'`.
- Copy `jobs.delivery_id` back to `ref_id`.
- Restore old CHECK constraints and indexes.

### Phase 7 — Update creation, loading, and operations SQL

Update:

- `apps/service/src/mailings/create-mailing.ts`
- `apps/service/src/sending/context.ts`
- `apps/service/src/operations/read-model.ts`
- `apps/service/src/operations/query.ts`
- direct SQL in tests/fixtures

Changes:

- insert jobs with `delivery_id`, no `kind`
- load `delivery_id AS deliveryId`, no `refId`
- operations joins no longer filter by `kind`
- update recent issue `relatedId` from `jobs.delivery_id`, not `jobs.ref_id`
- update delivery list/detail latest-job subqueries:
  - remove `latest_job.kind = 'send_delivery'`
  - use `latest_job.delivery_id = d.id`
- update operation filters and zero-filled summaries to new state vocabularies

### Phase 8 — Update TypeScript schemas

Update:

- `apps/service/src/sending/schema.ts`
- `apps/service/src/queue/schema.ts`
- `apps/service/src/operations/read-model.ts`
- `apps/service/src/operations/query.ts`

Changes:

- narrow `DeliveryStatusValues`
- narrow `JobStateValues`
- narrow `MailingStateSchema`
- rename queue schema exports to send-delivery-specific names
- remove status values from operations query validation that no longer exist

This changes operation API response keys because summary zero-counts shrink to current states. That is acceptable for this early project and matches the requested simplification.

### Phase 9 — Update tests

Update existing tests rather than adding a large parallel suite.

Key test areas:

1. Migration tests
   - migration applies, reports status, rolls back
   - migrated schema has no `jobs.kind`
   - migrated `jobs` has `delivery_id`
   - unsupported states fail or are explicitly handled according to the chosen copy policy

2. Mailing creation tests
   - created mailing starts `scheduled`
   - deliveries are `queued`/`suppressed`
   - jobs use `delivery_id`

3. Send processing tests
   - first successful attempt changes mailing `scheduled -> sending -> completed`
   - partial multi-recipient mailing remains `sending` until all deliveries terminal
   - retryable failure that is requeued keeps delivery `queued` and mailing `sending`
   - retryable failure that exhausts attempts marks job `dead`, delivery `failed`, mailing `completed` if all deliveries are terminal
   - expired leased job that becomes `dead` marks latest started attempt ambiguous, delivery `failed`, and mailing refreshes
   - permanent policy/render/preparation failures complete job and refresh mailing state
   - stale `sending` ambiguity still produces terminal delivery failure and mailing completion

4. Queue tests
   - claim due send-delivery jobs atomically without kind filters
   - complete only leased jobs owned by worker
   - fail requeues or dead-letters
   - release expired leases and reconcile dead releases
   - stale lease handling still works
   - remove tests that only validate generic kind filtering

5. Operations tests
   - summary keys match new state vocabulary
   - delivery list/detail query against `delivery_id`
   - recent issues use `delivery_id` as related ID for jobs
   - status query rejects removed statuses

### Phase 10 — Update documentation

Update:

- `PROJECT.md`
- `README.md`

`PROJECT.md` should separate current implementation from roadmap.

Current data model docs should say:

```txt
mailings.state = scheduled | sending | completed

deliveries.status = queued | sending | sent | failed | suppressed

jobs.state = queued | leased | succeeded | dead

jobs.delivery_id points at deliveries.id
```

Roadmap language should say:

- SES events may add `delivered`, `bounced`, and `complained` delivery statuses.
- Pause/cancel APIs may add paused/cancelled mailing, delivery, or job states.
- Draft mailings should only be added if a draft workflow exists.

Also update the sending architecture section:

- send-specific queue, not generic durable jobs
- mailing state is advanced by the send worker
- dead jobs terminally fail their delivery
- `completed` means send processing completed, not recipient delivery confirmation

### Phase 11 — Verification commands

Run targeted checks:

```sh
pnpm --filter @nusend/service typecheck
pnpm test -- apps/service/src/db apps/service/src/mailings apps/service/src/queue apps/service/src/sending apps/service/src/operations
```

Then run full project checks:

```sh
pnpm check
```

Run a Bun migration smoke test against a temporary DB:

```sh
NUSEND_DB_PATH=.data/tmp-state-queue-plan.sqlite pnpm --filter @nusend/service db:migrate
NUSEND_DB_PATH=.data/tmp-state-queue-plan.sqlite pnpm --filter @nusend/service db:status
```

Clean up the temporary DB afterward.

## Risks and mitigations

### Risk: SQLite table rebuild migration is the riskiest part

Mitigation:

- use `PRAGMA defer_foreign_keys = ON` inside the migration transaction
- rebuild dependent tables explicitly, including `mailing_idempotency_keys`
- test up/down migration paths
- keep schema changes limited to state constraints and queue simplification

### Risk: operation API response shape changes

Mitigation:

- update `PROJECT.md`, `README.md`, and operation tests
- acceptable because the project is early and simplification is explicitly requested

### Risk: mailing `completed` can be misunderstood as successful delivery

Mitigation:

- document it as processing completion, not inbox delivery
- future SES event ingestion can add delivery-event states later

### Risk: queue simplification causes broad test churn

Mitigation:

- update tests by behavior area rather than preserving generic test structure
- preserve the important queue invariants: atomic claim, lease ownership, backoff, dead-lettering, expired lease release, stale lease tolerance

## Suggested implementation order

1. Update state vocabularies in TypeScript and docs enough to expose compile/test failures.
2. Implement lifecycle helpers.
3. Simplify queue types/functions and remove generic kind plumbing.
4. Replace generic runner usage with send-specific worker processing.
5. Add dead-job reconciliation for both active failure and expired lease release.
6. Add the SQLite migration with deferred FK handling.
7. Update operations SQL/API models.
8. Update tests and docs.
9. Run targeted checks, migration smoke test, then `pnpm check`.

## Acceptance criteria

- No live TypeScript schema exports unsupported future-only states.
- DB CHECK constraints match the current implemented state vocabularies.
- New mailings start `scheduled`.
- First send attempt advances mailing to `sending`.
- All-terminal deliveries advance mailing to `completed`.
- Retry-dead jobs mark their delivery `failed`.
- Expired leased jobs that dead-letter reconcile their delivery/attempt/mailing state.
- Queue code no longer exposes job kinds or kind filters.
- `jobs` schema no longer has `kind`; it uses `delivery_id` instead of `ref_id`.
- `PROJECT.md` accurately describes current state and future roadmap separately.
- Targeted tests, migration smoke test, and `pnpm check` pass.
