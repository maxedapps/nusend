# Implement Selected Production-Readiness Fixes

## Summary

Implement the user-selected subset of the July 2026 production-readiness review:

- fix must-fix findings **1, 2, and 5**;
- implement every **Important Improvement**, except that hosted CI is not to be improved—instead remove `.github/workflows/ci.yml`;
- add only high-value behavioral tests for the selected work;
- update `PROJECT.md` and nearby current documentation so the product vision and live behavior remain accurate;
- explicitly leave the other production-readiness blockers open.

This plan does **not** make the broader production-readiness verdict green. Deployment/recovery, HTTPS defaults, SES retention/capacity, live AWS/Gmail validation, and their tests remain intentionally out of scope.

## Confirmed requirements and assumptions

### In scope

1. A manual suppression must be monotonically promoted when later evidence proves complaint, hard bounce, or unsubscribe; automated safety state must not remain deletable as manual.
2. Deleting a list must not erase policy context for a scheduled/sending mailing.
3. Provider-unknown sends must have an explicit delivery-level `ambiguous` outcome, must never be automatically retried, and may become `sent` only when the same attempt later yields authoritative SES acceptance evidence.
4. Device authorization must have bounded process-local token polling, accurate durable pending counts, read-only early `slow_down` handling, and bounded limiter memory.
5. Signed malformed Bounce/Complaint notifications must remain retryable/non-acknowledged instead of being accepted without event/suppression rows.
6. SES readiness must require only configured optional OPEN/CLICK tracking.
7. CLI profile/credential mutations must be safe across concurrent processes; login polling must respect a safe minimum and local expiry without a hidden environment speed override.
8. Remove the GitHub Actions workflow and do not replace it.
9. Add only tests that directly protect these behaviors and their migration/contract boundaries.
10. Re-freeze the repository’s committed test-audit evidence after tests are final.

### Explicit non-goals

- No supervisor/proxy deployment artifacts, backup/restore workflow, retention/pruning, disk/worker freshness work, or related tests.
- No service/CLI HTTPS-default change.
- No live SES/SNS/Gmail/OAuth tests.
- No retry/reconcile mutation API for ambiguous sends.
- No schema-heavy soft-delete system for lists.
- No immutable multi-reason suppression history table.
- No CI replacement, release workflow, SBOM, provenance, or dependency-governance work.
- No templates, assets, or new CLI domain families.

### Vetoable implementation defaults

These decisions remove ambiguity from implementation. Change them only before their dependent phase begins.

- Suppression priority is monotonic:
  - `scope=all`: `complaint > bounce > manual`;
  - `scope=marketing`: `unsubscribe > manual`.
- Promotion preserves the existing suppression row ID and original `created_at`, which continues to mean “suppression began.”
- An approved-but-unconsumed device authorization remains an outstanding grant and continues counting toward durable pending limits; denied and consumed rows do not.
- Token ceilings are process-local: **120 requests/minute per source**, **600/minute globally**, with at most **1024 active source keys**.
- Completed mailings may lose their deleted list identity through the existing `ON DELETE SET NULL`; retained unsubscribe links still create marketing-wide suppression.
- A dead queue job remains `dead` if a late MessageId later proves the delivery was sent. Queue incident history and delivery outcome are separate facts.
- CLI local-state locking supports local filesystems only; network-mounted config directories are unsupported.

## Review-finding traceability

| Source finding/test gap | Plan coverage | Target disposition after implementation |
|---|---|---|
| Must-fix 1: automated suppression remains manual/deletable | Phases 1–2 | Fix and verify |
| Must-fix 2: list deletion erases active compliance context | Phase 1 | Fix and verify |
| Must-fix 3: deployment/recovery | Non-goal | Still open |
| Must-fix 4: transport defaults | Non-goal | Still open; document accurately only |
| Must-fix 5: ambiguous delivery represented as failed | Phase 2 | Fix and verify |
| Must-fix 6: unbounded SES storage | Non-goal | Still open |
| Important: device authorization abuse controls | Phase 3 | Fix and verify |
| Important: malformed reputation events acknowledged | Phase 4 | Fix and verify with retryable 503 |
| Important: optional tracking required by readiness | Phase 4 | Fix and verify |
| Important: CLI local-state/poll robustness | Phase 5 | Fix and verify |
| Important: CI/release coverage | Phase 6 deletes workflow; no replacement | Intentionally not fixed |
| Missing test 1: suppression promotion/deletion | Phase 1 | Add high-value evidence |
| Missing test 2: active-list deletion | Phase 1 | Add high-value evidence |
| Missing test 3: send crash/late reconciliation | Phase 2 | Add mandatory crash/concurrency evidence |
| Missing tests 4–6: backup/worker/TLS | Non-goal | Do not add |
| Missing test 7: Bounce/Complaint body mismatch | Phase 4 | Add high-value evidence |
| Missing test 8: token flood/terminal capacity | Phase 3 | Add high-value evidence |
| Missing test 9: overlapping CLI writers | Phase 5 | Add high-value evidence |
| Missing test 10: live SES/Gmail | Non-goal | Do not add |

## Research and current-state findings

### Local architecture

- Suppression uniqueness is per case-insensitive email plus global scope/list ID, not per reason: `apps/service/src/db/migrations/sql/0001_initial_schema.sql`.
- Manual, SES, and unsubscribe writers currently use independent conflict behavior in:
  - `apps/service/src/suppressions/write.ts`
  - `apps/service/src/ses/process-event.ts`
  - `apps/service/src/unsubscribe/unsubscribe.ts`
- Mailing creation and list deletion already use the same serialized Effect database service; mailing creation is transactional, but list deletion is not.
- `send_attempts.status` already supports `ambiguous`; `deliveries.status`, mailing counts, operations filters, CLI output, and simulator status do not.
- Rebuilding only `deliveries` is unsafe. A scratch migration against the production Bun driver confirmed that `DROP TABLE deliveries` cascades away jobs/attempts despite deferred FK checking. Migration 0009 must rebuild the entire dependent table graph.
- Device token polling currently has durable protocol pacing but no route ceiling; every early poll writes SQLite.
- The webhook already stores the raw notification before decoding and reprocesses dedupe hits whose metadata/events remain incomplete. Generic malformed input can keep returning 400, but a verified Bounce/Complaint block mismatch must use retryable 503 so SNS redelivers it.
- Config/credential writes use lock-free read-modify-write and PID-only temp names.
- Any test identity change invalidates the frozen final test-audit inventory; `docs/test-audit/README.md` requires a new final collection and manifest reconciliation.

### External evidence

- Node documents that promise-based filesystem operations are not synchronized/threadsafe; concurrent modifications require application coordination. The relevant built-ins include exclusive creation, hard links, rename, FileHandle sync, and directory operations: <https://nodejs.org/api/fs.html>.
- `proper-lockfile` uses atomic mkdir plus mtime heartbeats/stale detection, but its latest published release is 4.1.2 from 2021. This plan avoids a new dependency and implements a narrowly scoped local lock: <https://github.com/moxystudio/node-proper-lockfile>.
- AWS documents that SNS retries HTTP/S responses only for 5xx and 429; ordinary 400 is permanent. Verified reputation-payload mismatches therefore need a distinct retryable 503 path, while malformed outer/unverified requests remain 400/403: <https://docs.aws.amazon.com/sns/latest/dg/sns-message-delivery-retries.html>.

## Chosen implementation strategy

### Suppressions

Centralize automated global-scope upserts, make reason progression monotonic, and atomically guard manual deletion. Keep the current one-row model because the finding is deletion safety, not full provenance history.

### List deletion

Keep hard deletion for lists with no active mailing. Execute one transaction whose guarded DELETE refuses any list referenced by a mailing whose state is not `completed`. This is smaller and safer than a soft-delete schema.

### Ambiguous delivery outcome

Add `deliveries.status='ambiguous'` as a first-class terminal state. Do not derive it only from the latest attempt: derived semantics would leave raw DB/API state contradictory and force every consumer to perform a correct latest-attempt join.

### CLI local state

Create a dependency-free shared local-state lock and mutation API. Every read-modify-write reload occurs after lock acquisition; writes use a random same-directory temp, file sync, rename, and best-effort directory sync. Reads remain lock-free because rename exposes a complete old or new file.

## Phase 0 — Establish scoped baseline and permanent fail-before proofs

### Baseline evidence

1. Confirm the worktree state and preserve owner changes.
2. Run the existing focused/full gates before edits:
   - `pnpm check`
   - `pnpm build`
   - `pnpm audit:test`
   - `pnpm audit:validate`
   - `pnpm audit:render:check`
   - `pnpm audit:independent`
3. Collect an implementation-local pre-change Vitest JSON report under `.progress/` and compare it with `docs/test-audit/final-inventory.json`. Do not replace the committed historical baseline inventory.
4. Record current test identity/file/test totals and all skipped external checks in the implementation tracker.

### Fail-before test rule

For each defect, write permanent assertions in their final expected form, run them against old behavior, and record the expected failure. Do not invert assertions later. New APIs/types may initially fail compilation; that is acceptable only in the red step immediately preceding the matching vertical implementation.

### Initial red proofs

- manual suppression + permanent bounce/complaint remains protected and non-deletable;
- manual marketing suppression + public unsubscribe becomes protected and non-deletable;
- deleting a list with a scheduled mailing returns 409 and preserves all policy/job rows;
- ambiguous transport/stale lease produces delivery `ambiguous`, not `failed`;
- late same-attempt MessageId produces `succeeded/sent`;
- denied/consumed device rows release durable capacity while approved-unconsumed does not;
- early poll leaves `poll_count`/`last_poll_at` unchanged;
- token route limits reject before DB mutation;
- verified malformed Bounce/Complaint block mismatch returns retryable 503 with no processed rows, while malformed outer input remains 400;
- configured optional tracking is the only OPEN/CLICK requirement;
- concurrent CLI writers preserve every profile/credential;
- login performs no token request after local expiry.

This is an expected-red checkpoint, not a green/deployable checkpoint.

## Phase 1 — Suppression monotonicity and safe list deletion

### 1.1 Central automated suppression upsert

In `apps/service/src/suppressions/write.ts`:

1. Add a narrow input type allowing only:
   - `{ scope: 'all', reason: 'bounce' | 'complaint' }`
   - `{ scope: 'marketing', reason: 'unsubscribe' }`
2. Add `upsertAutomatedSuppression({ id, email, scope, reason, createdAt })`.
3. Use one partial-index conflict statement:

```sql
INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
VALUES ($id, $email, $scope, NULL, $reason, $createdAt)
ON CONFLICT(email, scope) WHERE list_id IS NULL
DO UPDATE SET reason = CASE
  WHEN excluded.reason = 'complaint' AND suppressions.reason IN ('manual', 'bounce')
    THEN 'complaint'
  WHEN excluded.reason = 'bounce' AND suppressions.reason = 'manual'
    THEN 'bounce'
  WHEN excluded.reason = 'unsubscribe' AND suppressions.reason = 'manual'
    THEN 'unsubscribe'
  ELSE suppressions.reason
END
WHERE
  (excluded.reason = 'complaint' AND suppressions.reason IN ('manual', 'bounce'))
  OR (excluded.reason = 'bounce' AND suppressions.reason = 'manual')
  OR (excluded.reason = 'unsubscribe' AND suppressions.reason = 'manual');
```

4. Preserve existing ID and `created_at` during promotion.
5. Keep manual creation as `DO NOTHING`; manual writes must never downgrade automated state.
6. Replace inline SES/unsubscribe writes in:
   - `apps/service/src/ses/process-event.ts`
   - `apps/service/src/unsubscribe/unsubscribe.ts`
7. Keep these calls inside the callers’ existing event/unsubscribe transactions.

### 1.2 Atomically guard suppression deletion

Replace read-then-delete with one short transaction:

```sql
DELETE FROM suppressions
WHERE id = $id AND reason = 'manual'
RETURNING id;
```

If zero rows are returned, still inside the transaction:

- query by ID;
- absent → existing `NotFoundError` / 404;
- present automated reason → existing `ConflictError` / 409.

This closes the promotion/deletion race: deletion either commits first and automation inserts a new protected row, or promotion commits first and the guarded delete cannot remove it.

### 1.3 Guard list deletion

In `apps/service/src/lists/write.ts`, perform this in one transaction:

```sql
DELETE FROM lists
WHERE id = $listId
  AND NOT EXISTS (
    SELECT 1
    FROM mailings
    WHERE list_id = $listId AND state <> 'completed'
  )
RETURNING id;
```

On zero rows, query list existence inside the same transaction:

- absent → `ListNotFoundError` / 404;
- present → `ConflictError` / 409 with:
  - `List cannot be deleted while non-completed mailings reference it.`

Concurrency semantics:

- if mailing creation commits first, deletion sees and refuses the active mailing;
- if deletion commits first, mailing creation cannot resolve/reference the deleted list;
- safe completed-list deletion retains current FK behavior (`mailings.list_id -> NULL`, memberships/list suppressions cascade).

### 1.4 High-value tests

Update existing test files rather than creating low-value duplicates:

- `apps/service/src/ses/process-event.test.ts`
  - manual all → bounce → complaint; assert one row, stable ID/time, monotonic reason, no downgrade.
- `apps/service/src/unsubscribe/unsubscribe.test.ts`
  - manual marketing → unsubscribe; assert one protected row and idempotent repeat.
- `apps/service/src/suppressions/routes.test.ts`
  - promoted rows return 409 on delete; true manual remains 204; missing remains 404.
- `apps/service/src/lists/routes.test.ts`
  - scheduled and sending mailing each block deletion with exact 409;
  - list, `mailings.list_id`, list suppression, queued delivery, and job all remain;
  - completed mailing allows deletion and retained old unsubscribe token still creates marketing suppression.
- Add deterministic file-backed, independent-process race tests:
  - promotion vs guarded deletion converges to one automated, non-deletable suppression regardless of commit order;
  - mailing creation vs list deletion yields only one of two valid outcomes: deleted list/no mailing, or retained list/fully linked mailing—never a queued mailing with null list context.
- `apps/service/src/testing/driver-parity.ts` must exercise the partial-index `DO UPDATE ... WHERE` on both Node SQLite and Bun SQLite.

### Phase 1 slice validation (not scoped completion)

Run targeted suppression/list/SES/unsubscribe tests, service typecheck, then `pnpm check`. Record exact commands, exit status and test totals. Historical row repair remains pending until migration 0009, so finding 1 and the broader scoped plan remain partial even when this slice is green.

## Phase 2 — Explicit delivery ambiguity and migration 0009

### 2.1 Define truthful state semantics

Extend delivery statuses to:

```text
queued | sending | sent | failed | suppressed | ambiguous
```

State rules:

- `ambiguous` is terminal for automatic processing;
- mailings may be `completed` while containing ambiguous deliveries;
- no automatic retry or manual resend is introduced;
- only authoritative MessageId evidence from the exact same attempt can promote `ambiguous -> sent`;
- permanent failure remains `failed`;
- exhausted queued work with no in-flight attempt remains `failed`;
- an exhausted/stale `sending` attempt becomes `ambiguous`.

Update `apps/service/src/sending/schema.ts` and every closed status consumer before claiming a green checkpoint.

### 2.2 Add migration 0009

Create:

`apps/service/src/db/migrations/sql/0009_delivery_ambiguity_and_suppression_safety.sql`

#### UP

1. Use `PRAGMA defer_foreign_keys = ON`.
2. Rebuild the complete dependent graph—not only `deliveries`:
   - `deliveries`
   - `jobs`
   - `send_attempts`
   - `ses_events`
   - `ses_simulator_runs`
3. Rename old tables child-first, drop all old named indexes, create current tables parent-first with identical columns/FKs except:
   - deliveries CHECK includes `ambiguous`;
   - simulator-run CHECK includes `ambiguous`.
4. Copy all columns explicitly and preserve IDs/timestamps/FK actions.
5. Determine each delivery’s latest attempt by maximum `attempt_no`.
6. Historical conversion:
   - identify the latest attempt by `MAX(attempt_no)` for each delivery;
   - convert current delivery `failed` + latest attempt `ambiguous` to `sent`/`succeeded` **only when that exact latest attempt row has a non-null `ses_message_id`** and the delivery MessageId is null or equal;
   - a delivery-only MessageId, an older attempt’s MessageId, or conflicting IDs are not exact-attempt proof and remain delivery `ambiguous`;
   - current delivery `failed` + latest attempt `ambiguous` without exact-attempt proof → delivery `ambiguous`;
   - ordinary failed/suppressed/sent rows remain unchanged;
   - linked simulator `failed` becomes `sent`/`ambiguous` according to converted delivery; unrelated simulator rows remain unchanged.
7. Repair proven historical suppression conflicts with explicit predicates:
   - correlate `suppressions.email = ses_events.recipient_email COLLATE NOCASE`;
   - require `suppressions.scope='all'`, `suppressions.reason='manual'`, and `ses_events.action_taken='suppressed'`;
   - any matching `event_type='Complaint'` wins and promotes to `complaint` (a `not-spam` event is not `action_taken='suppressed'`);
   - otherwise require `event_type='Bounce' AND bounce_type='Permanent'` and promote to `bounce`;
   - another recipient, transient bounce, not-spam complaint, recorded/ignored event, or null email must not promote;
   - do not guess historical unsubscribes because no durable unsubscribe audit record exists.
8. Drop old tables child-first.
9. Recreate every existing index, including all indexes added in migrations 0007/0008:
   - delivery indexes including `deliveries_created_id_idx`;
   - job indexes including unique `jobs_delivery_id_unique_idx`;
   - send-attempt indexes;
   - SES event indexes including `ses_events_created_id_idx`;
   - simulator-run indexes.

#### DOWN

Rebuild the same graph symmetrically:

- delivery `ambiguous -> failed`;
- simulator `ambiguous -> failed`;
- preserve MessageIds, errors, jobs, attempts, event rows, IDs and timestamps;
- leave `send_attempts.status='ambiguous'` legal;
- do not reverse monotonic suppression repair;
- document that downgrade is semantically lossy and triggers the existing destructive rollback confirmation.

#### Migration validation

Extend `apps/service/src/db/migrate.integration.test.ts` with representative pre-0009 rows and assert:

- proven latest-attempt late success converts to succeeded/sent;
- delivery-only proof, older-attempt proof, conflicting IDs and unproven ambiguity all remain delivery ambiguous;
- permanent failure remains failed;
- historical complaint/permanent-bounce evidence promotes manual global suppression;
- another recipient, not-spam complaint, transient bounce, recorded/ignored action and null recipient do not promote;
- jobs, attempts, events, simulator links, timestamps, FKs and every named index survive;
- representative `ON DELETE CASCADE` and `ON DELETE SET NULL` DML still works;
- invalid status insertion fails;
- `PRAGMA foreign_key_check` is empty after UP, DOWN, and re-UP;
- DOWN maps ambiguity to failed without deleting child rows.

### 2.3 Make paired attempt/delivery transitions atomic and fenced

Refactor `apps/service/src/sending/attempts.ts` so paired transitions distinguish only safe terminal no-ops from inconsistencies:

```ts
type AttemptWriteResult =
  | 'Recorded'
  | 'Reconciled'
  | 'AlreadyRecorded'
  | 'SupersededTerminal';
```

An incompatible state is **not** returned as a generic success-like `Stale`: if the delivery remains nonterminal, fail with a sanitized `DatabaseError` so the queue runner cannot complete the job. `apps/service/src/sending/process-delivery.ts` must explicitly handle the result:

- `Recorded | Reconciled | AlreadyRecorded` → normal processor success;
- `SupersededTerminal` → safe no-op because another path already made the delivery terminal;
- incompatible/nonterminal/read-back mismatch → Effect failure; the runner fails/requeues only if it still owns the lease, otherwise its existing stale-lease handling records `skippedStale`.

For `recordSendSuccess`:

1. Run inside `BEGIN IMMEDIATE`.
2. Normal success is allowed only for exact attempt/delivery, `attempt=started`, `delivery=sending`, no newer attempt, and compatible/null MessageIds.
3. Late reconciliation is allowed only for exact attempt/delivery, `attempt=ambiguous`, `delivery=ambiguous`, no newer attempt, and compatible/null MessageIds.
4. Update attempt to `succeeded`, set MessageId, clear error, finish timestamp.
5. Update delivery to `sent`, set MessageId, clear error, update timestamp.
6. If either update returns zero, read back inside the transaction:
   - exact already-succeeded/sent with same MessageId → `AlreadyRecorded`;
   - a newer attempt or another changed state returns `SupersededTerminal` **only after read-back proves the delivery is terminal**;
   - a newer attempt while delivery remains queued/sending, any other incompatible nonterminal state, or a first write whose second paired write is neither applied nor already correct → fail with sanitized `DatabaseError` so the transaction rolls back and the caller cannot complete the job.
7. Never overwrite a different MessageId.
8. Preserve queue fencing: stale workers still cannot complete/fail another worker’s lease. MessageId reconciliation does not require lease ownership because provider acceptance evidence is authoritative; it is fenced by exact attempt identity and latest-attempt state.

Apply equivalent checked paired-write behavior to:

- `recordFailure`;
- `recordStaleSendingAsAmbiguous`.

Change:

- explicit ambiguous transport → attempt/delivery `ambiguous`;
- stale in-flight attempt → attempt/delivery `ambiguous`;
- dead queued delivery without started attempt → `failed`.

A late success may change delivery/attempt to sent/succeeded while a dead job remains dead as historical queue evidence.

### 2.4 Update every state consumer in one vertical checkpoint

Modify:

- `apps/service/src/sending/process-delivery.ts`
  - handle paired-write results exactly as specified above; never convert an inconsistent nonterminal write into processor success.
- `apps/service/src/mailings/lifecycle.ts`
  - ambiguous is terminal for completion and terminal counts.
- `apps/service/src/mailings/read-model.ts`
  - decode/count/zero-fill ambiguous.
- `packages/api-contract/src/mailings/schema.ts`
  - add required additive `counts.ambiguous`.
- `apps/service/src/operations/query.ts`
  - accept `status=ambiguous`.
- `apps/service/src/operations/read-model.ts`
  - summary/detail/list expose direct ambiguity;
  - `failed_or_ambiguous` checks delivery `IN ('failed','ambiguous')` plus failed/ambiguous attempts/errors;
  - recent issues include ambiguous even if error is unexpectedly null.
- `apps/service/src/queue/runner.ts`
  - preserve failed-vs-ambiguous dead-job distinction and update comments/query literals.
- `apps/service/src/ses/simulator.ts` and `apps/service/src/ses/read-model.ts`
  - send-acceptance ends as ambiguous rather than failed/timed-out;
  - end-to-end ambiguity may still wait for authentic expected event until timeout;
  - do not auto-promote from webhook events without exact attempt binding.
- `apps/cli/src/commands/mailings.ts`
  - JSON decodes the additive count;
  - human list/detail displays `ambiguous=N` when nonzero and never hides it only in the total.

Use the installed Effect v4 decoding-default pattern so the **decoded Type remains required** while the encoded/wire key may be absent for one-version rolling compatibility:

```ts
ambiguous: Schema.Number.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(0)),
)
```

The new service always emits `ambiguous`; the updated first-party CLI can decode an old five-count service as zero. Document that exhaustive third-party clients still face a new status literal/additive field. This does not make the schema migration rolling-safe: stop old API/worker processes, apply 0009, then start matching service/worker and distribute the matching CLI. Apply the same stop requirement before DOWN.

### 2.5 High-value ambiguity tests

Update existing identities where possible; rename misleading test titles and reconcile audit identities later.

1. Direct ambiguous transport: one dispatch, attempt/delivery ambiguous, job succeeded, mailing completed, second cycle sends nothing.
2. Stale in-flight reclaim: started/sending becomes ambiguous/ambiguous, no second transport call.
3. Late exact MessageId: ambiguous pair becomes succeeded/sent; errors clear; repeat is idempotent.
4. Fence negatives: different attempt, permanent failed/suppressed delivery, or different MessageId cannot promote/requeue; a newer attempt plus terminal delivery is a safe terminal supersession, while a newer attempt plus `queued`/`sending` fails and cannot complete the job.
5. Both race orderings converge:
   - success before stale marker;
   - stale marker before late success.
6. Checked zero-row/read-back behavior never commits a half-paired state.
7. Dead-job distinction:
   - queued exhausted → failed;
   - sending/started exhausted → ambiguous;
   - late proof promotes delivery while job remains dead.
8. **Mandatory file-backed real crash boundary:**
   - child worker commits started/sending and a deterministic dispatch marker;
   - child is SIGKILLed/forcibly terminated before outcome persistence;
   - expire/reclaim lease and restart cycle;
   - assert no second dispatch, one ambiguous attempt/delivery, completed mailing;
   - inject late same-attempt success and assert sent/succeeded.
9. **Mandatory genuinely overlapping race:** use independent file-backed connections and a deterministic barrier so late-success and stale-marker calls overlap; test both acquisition/commit orderings and convergence, rather than merely invoking the functions sequentially.
10. Owned-lease incompatible nonterminal read-back fails the processor and cannot complete the job; terminal supersession is the only safe no-op.
11. Mailing list/detail counts, operations summary/filter/detail, CLI JSON/human output, and simulator all surface ambiguity.
12. Contract compatibility decodes an old five-count payload to `ambiguous: 0` while compile-time `MailingCounts['ambiguous']` remains required; the new service response always emits the key.

Primary files:

- `apps/service/src/sending/attempts.test.ts`
- `apps/service/src/sending/process-delivery.test.ts`
- `apps/service/src/queue/runner.test.ts`
- mandatory focused `apps/service/src/sending/worker-crash.integration.test.ts`
- `apps/service/src/mailings/routes.test.ts`
- `apps/service/src/operations/routes.test.ts`
- `apps/service/src/ses/simulator.test.ts`
- `apps/cli/src/commands/mailings.test.ts`
- `e2e/cli-service.e2e.test.ts` only if it adds a real contract boundary not already covered.

### Phase 2 green checkpoint

Run migration UP/DOWN/re-UP integration tests, focused sending/queue/mailings/operations/simulator/CLI tests, package builds/typechecks, then `pnpm check`. This phase must not be called green until migration, schema literals, all readers, contract, fixtures and tests agree.

## Phase 3 — Device authorization abuse controls

### 3.1 Correct durable pending counts

In both global and fingerprint queries use:

```sql
expires_at > $now
AND denied_at IS NULL
AND consumed_at IS NULL
```

Approved-but-unconsumed rows intentionally remain counted. Add tests for global and per-fingerprint behavior:

- denied frees a slot;
- consumed frees a slot;
- approved-but-unconsumed does not;
- expired rows do not.

### 3.2 Make early protocol polling read-only

For a known unapproved row:

1. if `last_poll_at` is inside the five-second interval, return `slow_down` with 10 seconds and do not update `poll_count` or `last_poll_at`;
2. otherwise increment/update and return `authorization_pending` with five seconds;
3. preserve the current rule that approval is delivered regardless of previous poll timing.

### 3.3 Bound token route traffic and limiter memory

Refactor `apps/service/src/device-auth/attempt-limiter.ts` around one atomic API:

```ts
type AttemptDecision =
  | { kind: 'Allowed' }
  | { kind: 'Limited'; reason: 'rate' | 'capacity'; retryAfterMs: number };

attempt(key: string): AttemptDecision
```

Each call globally prunes expired timestamps before deciding, then:

- existing/new key below limits → records exactly one timestamp and returns Allowed;
- rate-limited key → records nothing and derives retry from that key’s oldest active timestamp;
- unseen key at `maxEntries` after prune → records nothing, fails closed, and derives retry from the earliest expiry across all active keys;
- timestamps per key never exceed the configured maximum;
- `Retry-After` is `max(1, ceil(retryAfterMs / 1000))`;
- expose only test-safe diagnostics needed to assert bounded size, not the raw map.

Apply finite `maxEntries` to **both existing start-route source maps and new token-route source maps**. Global limiters contain only the fixed global key.

In `apps/service/src/device-auth/routes.ts`:

- add injectable per-source/global token limiters and migrate start limiters to `attempt`;
- use the trusted final `X-Forwarded-For` hop consistently;
- call the global limiter first, then the source limiter, before DB access; every request consumes global capacity even if source/capacity limiting later rejects it;
- return 429 `rate_limited` plus integer `Retry-After` from the limiting decision;
- token limits: 120/minute/source, 600/minute/global, 1024 active source keys;
- start limits retain current request counts/window but gain a 128-key source-map cap (the durable/global ceiling already bounds legitimate activity);
- retain process-local/multi-process limitations in documentation.

### 3.4 High-value tests

- terminal and approved-unconsumed durable-count semantics;
- early poll leaves count/time unchanged; later poll updates once;
- source ceiling, independent second source, then global ceiling;
- rejected route request performs no token-row mutation;
- `Retry-After` and stable JSON envelope;
- active-key map never exceeds capacity and stale unrelated keys are globally reclaimed;
- approved-fast-poll behavior remains intact.

Modify:

- `apps/service/src/device-auth/attempt-limiter.ts`
- `apps/service/src/device-auth/attempt-limiter.test.ts`
- `apps/service/src/device-auth/routes.ts`
- `apps/service/src/device-auth/routes.test.ts`
- `apps/service/src/device-auth/service.ts`

### Phase 3 green checkpoint

Run device tests, service typecheck, and `pnpm check`.

## Phase 4 — SES malformed-event validation and optional tracking readiness

### 4.1 Validate reputation-sensitive event bodies

In `apps/service/src/ses/event-schema.ts`, after structural decode:

- `eventType='Bounce'` requires a `bounce` block;
- `eventType='Complaint'` requires a `complaint` block;
- a mismatched block fails;
- known valid and authentic unknown event types retain current behavior;
- do not broaden strictness to every optional event block without authoritative fixtures.

Preserve webhook ordering:

1. verify SNS/topic;
2. insert one raw notification audit row;
3. decode/validate SES event;
4. on a structurally valid, verified notification whose declared Bounce/Complaint block is missing/mismatched, leave event metadata null and write no event/suppression;
5. fail with a new typed `SesOperationsRetryablePayloadError` (name may vary but must stay distinct from generic malformed input);
6. map that error to an empty **503 Service Unavailable**, because AWS SNS retries 5xx/429 but treats ordinary 400 as permanent;
7. duplicate redelivery finds the unprocessed audit row and returns 503 again, allowing SNS retry/DLQ policy.

Keep malformed outer SNS envelopes/invalid JSON at empty 400, forbidden/signature failures at 403, and valid events at 204. Do not acknowledge a verified reputation-payload mismatch with 204.

Update the typed webhook error union/mapping in:

- `apps/service/src/ses/errors.ts`;
- `apps/service/src/http/respond.ts`;
- `apps/service/src/ses/process-event.ts` / `event-schema.ts` as the validation boundary requires.

### 4.2 Require only configured optional tracking

In `apps/service/src/aws/readiness.ts`:

- base requirements for both sets: BOUNCE, COMPLAINT, REJECT, DELIVERY_DELAY;
- for marketing only, append `settings.trackingEvents` uppercased;
- transactional readiness remains base-only;
- union event types across all enabled destinations publishing to allowlisted topics as today.

### 4.3 High-value tests

- `apps/service/src/ses/event-schema.test.ts`
  - missing/mismatched Bounce/Complaint blocks fail specifically with `SesOperationsRetryablePayloadError`, not generic `SesOperationsMalformedError`.
- `apps/service/src/ses/webhook-routes.test.ts`
  - signed Bounce/Complaint block mismatches return empty 503, one raw notification, null metadata, zero events/suppressions, and the same 503 on duplicate;
  - malformed outer envelopes remain empty 400 so the retryable distinction cannot regress.
- `apps/service/src/aws/readiness.test.ts`
  - no tracking configured + base events → OK;
  - open-only missing OPEN → warning mentioning only OPEN;
  - click-only present CLICK → OK;
  - configured marketing tracking does not affect transactional requirements.

### Phase 4 green checkpoint

Run event-schema/webhook/readiness tests, service typecheck, and `pnpm check`.

## Phase 5 — CLI local-state locking and safe login polling

### 5.1 Add one shared local-state lock

Create `apps/cli/src/config/local-state.ts` and use one lock path in the Nusend config directory for both config and credentials.

#### Acquisition/publication

1. Ensure directory mode 0700 on Unix.
2. Create a unique candidate owner file containing version, random token, PID, hostname and timestamp; use mode 0600 on Unix.
3. Write and `FileHandle.sync()` it completely.
4. Publish atomically with `link(candidate, lockPath)`; unlink the candidate after success/failure.
5. Retry EEXIST with jittered 25–250 ms waits for at most five seconds.
6. On timeout, fail with a stable local-state contention error and do not mutate files.

#### Dead-owner recovery

- Never steal a foreign-host, malformed, live, `EPERM`, or too-young lock.
- Same-host recovery requires `process.kill(pid, 0)` to return `ESRCH` and a publication grace age.
- Serialize reapers with a short-lived reaper mutex directory.
- After acquiring the reaper mutex, reread and compare token/metadata; atomically rename the dead lock to a unique tombstone, release the reaper mutex, and delete only that tombstone.
- All paths use `try/finally`; an orphaned/malformed reaper mutex fails closed with operator guidance rather than risking another process’s lock.
- Release verifies the current token before unlinking and never removes an unfamiliar replacement lock.

Document that network filesystems are unsupported. Windows local filesystems are intended to remain supported through Node’s built-in `link`/`rename` primitives, but must be reported as unvalidated when no Windows runtime is available; `EPERM`/`ENOTSUP` during lock publication must fail clearly rather than silently fall back to an unsafe lock.

#### Atomic durable mutation API

Add transform-owned helpers such as:

```ts
updateConfig(transform)
updateCredentials(transform)
updateLoginState({ profile, baseUrl, credential })
```

Production code must not retain a raw full-replacement `saveConfig(configComputedBeforeLock)` API: acquiring a lock only around publication would still allow a stale precomputed object to overwrite concurrent updates. Restrict any full-replacement helper to test/bootstrap initialization, or remove it.

`updateLoginState` holds the one shared lock while reloading both files, then writes credential followed by config. This serializes same-profile concurrent logins so the last lock owner wins both base URL and credential consistently. A process crash between the two file renames can still leave a credential/config mismatch; cross-file crash atomicity is explicitly not promised, but another CLI process cannot interleave between those writes.

Each helper:

1. acquires the shared lock;
2. reloads and schema-decodes the latest JSON;
3. applies the transform inside the lock;
4. writes a random same-directory temp at mode 0600;
5. syncs/closes temp;
6. renames over destination;
7. syncs the parent directory where supported;
8. removes temp and releases lock in `finally`.

Directory-sync unsupported errors may be handled narrowly; write/rename/parse errors must propagate. Reads remain lock-free. Remove the production full-replacement `saveConfig` path; test/bootstrap setup may write fixtures directly, while every production mutation uses a lock-owned transform.

Update:

- `apps/cli/src/config/paths.ts`
- `apps/cli/src/config/profiles.ts`
- `apps/cli/src/credentials/file-store.ts`
- `apps/cli/src/commands/login.ts`
- `apps/cli/src/commands/logout.ts` through the store implementation.

Credential-before-config ordering remains intentional. Individual files are crash-safe; the shared critical section prevents inter-process interleaving across a login mutation, while cross-file crash atomicity is not introduced. Logout remote network work happens before lock acquisition, and local deletion uses the same state lock. Same-profile concurrent login/logout is serialized with last-lock-owner local semantics; remote revocation outcome remains governed by the existing logout contract.

### 5.2 Replace hidden polling override with injected runtime dependencies

- Remove `NUSEND_LOGIN_POLL_INTERVAL_MS` entirely.
- Add internal CLI runtime dependencies (`sleep`, `now`) with production defaults and optional test injection through `runCli`/command context.
- Parse `started.expiresAt`; invalid timestamps become a sanitized protocol/internal error.
- Replace recursion with an iterative loop.
- Clamp every server interval to finite milliseconds with a minimum of 1000 ms.
- Before sleep and before each token request, stop with exit 3 when local expiry has arrived.
- Sleep at most the remaining time to expiry.
- If a request began before expiry and returns approved, accept it; server-side transaction remains authoritative.
- Keep denied/expired/invalid-grant behavior unchanged.

Remove the speed override from E2E configuration and use injected no-op/controlled sleep in tests.

### 5.3 High-value CLI tests

- two real overlapping subprocesses write many distinct profiles; all survive;
- two real overlapping credential writers write distinct profiles; all survive;
- concurrent same-profile logins cannot leave base URL from one process paired with the other process’s credential; last lock owner wins both;
- dead same-host owner is recovered; live owner is not stolen and times out;
- modes remain 0700/0600;
- failure before rename leaves previous JSON readable and no temp leak;
- pending/slow-down intervals use injected sleep and minimum 1000 ms;
- expiry before first poll and during sleep exits 3 with zero post-expiry token requests;
- credential write still occurs before config mutation;
- logout concurrent with unrelated profile write does not drop the unrelated credential.

Prefer production entrypoints and real child processes for the cross-process cases. Avoid stress-count-only tests: coordinate child start, assert final complete maps, and bound subprocess timeouts/cleanup.

Modify tests in:

- `apps/cli/src/config/profiles.test.ts`
- `apps/cli/src/credentials/file-store.test.ts`
- mandatory focused `apps/cli/src/config/local-state.test.ts`
- `apps/cli/src/commands/login.test.ts`
- `apps/cli/src/commands/login-order.test.ts`
- `apps/cli/src/commands/logout.test.ts`
- `e2e/cli-service.e2e.test.ts`

### Phase 5 green checkpoint

Run CLI focused tests, typecheck/build, built CLI smoke (`--help` and local profile mutation), then `pnpm check`.

## Phase 6 — Documentation, PROJECT accuracy, environment example, and CI removal

### 6.1 Remove CI

Delete:

- `.github/workflows/ci.yml`

Do not add another workflow or release system. Historical plans/reviews remain historical and are not rewritten.

### 6.2 Update `PROJECT.md`

Update the live architecture/status sections, not just a changelog:

- Current Status:
  - monotonic automated suppressions;
  - guarded list deletion;
  - explicit ambiguous delivery state and late proof reconciliation;
  - bounded token polling and corrected pending semantics;
  - malformed reputation-event rejection;
  - configured-only tracking readiness;
  - cross-process CLI state locking and local expiry.
- Upgrade/compatibility notes:
  - migration 0009 conversion and lossy DOWN mapping;
  - additive `counts.ambiguous` contract;
  - list delete may now return 409;
  - remove `NUSEND_LOGIN_POLL_INTERVAL_MS` if mentioned anywhere.
- Data model:
  - delivery status includes ambiguous;
  - completed means all deliveries are terminal, including ambiguous;
  - distinguish failed from provider-unknown.
- Send attempts/ambiguity:
  - never auto-retry unknown outcomes;
  - same-attempt late MessageId promotes to sent;
  - dead job may coexist with sent delivery as queue history.
- Suppression policy:
  - automated reason priority and deletion guarantees.
- Device auth:
  - process-local route limits, bounded map, durable outstanding-grant predicate.
- SES feedback/readiness:
  - Bounce/Complaint body matching;
  - OPEN/CLICK required only when configured.
- CLI:
  - shared local-state lock, local-filesystem boundary, iterative expiry-aware polling.
- Open Questions:
  - remove “how to surface ambiguous send attempts”; replace with whether to add an explicit operator reconciliation API later.
- Keep the broader statement that production marketing volume is not ready; excluded blockers/live checks remain outstanding.
- Correct the existing HTTPS wording without implementing must-fix 4: validation is conditional on the current production-mode configuration and secure transport defaults remain an open blocker.
- State that hosted CI/release automation is intentionally absent after this change; local commands remain the validation contract.

### 6.3 Update adjacent current docs

- `README.md`
  - six delivery states/counts, ambiguity semantics, list deletion 409, suppression promotion.
- `docs/api.md`
  - additive ambiguous count/status, list delete conflict, token 429/Retry-After.
- `docs/auth-and-api-keys.md`
  - durable pending predicate and process-local token limits.
- `docs/cli.md`
  - local lock/contention/recovery behavior and expiry-aware polling.
- `docs/troubleshooting.md`
  - local lock contention/stale owner guidance and updated device limits.
- `docs/operations.md`, `docs/observability.md`
  - ambiguity is an explicit operator-visible terminal outcome.
- `docs/engagement-tracking.md`, `docs/ses-setup.md`
  - configured-only OPEN/CLICK readiness.
- `docs/deployment.md`
  - minimal migration 0009 compatibility order: stop old API/worker, migrate, deploy matching binaries; same stop requirement before DOWN;
  - selected local lock/token-limit notes only; do not expand into excluded deployment work.
- `docs/production-readiness.md`
  - explicitly say this selected remediation is not full production-readiness closure;
  - retain deployment/recovery, retention, secure-transport and live-provider gates;
  - state hosted CI/release automation is absent and must not be inferred from local audit commands.
- `.env.example`
  - add `NUSEND_API_KEY_HASH_SECRET` because service startup requires it;
  - leave optional tracking blank by default so copying the example does not opt in.

### Phase 6 checkpoint

Search the repository for stale five-status lists, “ambiguous means failed,” hidden poll override, unconditional OPEN/CLICK requirements, unsafe list deletion semantics, and current CI references. Run format/typecheck/build/tests after documentation/config changes.

## Phase 7 — Rebuild test-audit evidence and final verification

### 7.1 Freeze the test sources

Before collecting final evidence:

- finish all test additions/renames;
- remove temporary repros/hooks;
- ensure every test has a behavioral invariant and boundary—not merely line/count coverage;
- avoid renaming unaffected tests.

### 7.2 Reconcile the committed audit

1. Keep `docs/test-audit/baseline-inventory.json` immutable.
2. Collect a successful final Vitest JSON report under `.progress/`:

```sh
pnpm exec vitest run --reporter=json --outputFile=.progress/selected-production-fixes-final.json
```

3. Import it as the new final inventory:

```sh
node scripts/test-quality-audit/cli.mjs import \
  --snapshot final \
  --report .progress/selected-production-fixes-final.json \
  --inventory docs/test-audit/final-inventory.json
```

4. Update `docs/test-audit/manifest.json`:
   - final report metadata/hash/counts;
   - final inventory hash/status;
   - substantive additions for every new identity;
   - rewritten records for renamed baseline identities;
   - replace prior final-only addition identities when those test names changed;
   - update evidence/rationale for materially changed retained tests;
   - preserve duplicate-key multiplicity and exact reporter identity rules;
   - add review-batch coverage for every new test file.
5. Independently review the new/changed test identities and records; do not use blanket retain/addition prose.
6. Regenerate `docs/test-audit/audit.md` only through the audit renderer.

### 7.3 Automated verification

Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit:test
pnpm audit:validate
pnpm audit:render:check
pnpm audit:independent
node scripts/test-quality-audit/cli.mjs compare-report \
  --snapshot final \
  --report .progress/selected-production-fixes-final.json \
  --inventory docs/test-audit/final-inventory.json
```

Also run focused commands after each phase using package-relative Vitest paths as documented in `PROJECT.md`.

### 7.4 Manual/runtime verification

- Fresh database: migrate UP, assert status/indexes/FKs, run service and worker startup guards.
- Seed/reproduce:
  - promotion safety;
  - active-list deletion 409;
  - explicit ambiguity and late success;
  - migration DOWN/re-UP on copied temporary data.
- CLI:
  - run real concurrent child writers against a temporary config directory;
  - verify final JSON/modes and no lock/temp artifacts;
  - run built CLI `--help`, local config mutation, and expiry behavior.
- Browser/device smoke with `agent-browser`:
  - start a temporary migrated service;
  - create a device authorization;
  - open activation page and verify expected sign-in-required state;
  - exercise token pacing with API probes;
  - close browser, stop service, verify no listener/temp DB remains.

Do not claim live AWS/SNS/Gmail, backup/restore, TLS proxy, retention, or hosted CI validation.

### 7.5 Independent reviews

Use fresh read-only reviewers for:

1. migration/data preservation and ambiguity races;
2. suppression/list safety and device/webhook abuse behavior;
3. CLI lock protocol and subprocess tests;
4. final high-value test audit and plan traceability.

Spot-verify every High/Critical reviewer concern, fix valid findings, rerun relevant gates, and follow up with the same reviewer session when possible.

## Canonical file-operation manifest

### Create

- `apps/service/src/db/migrations/sql/0009_delivery_ambiguity_and_suppression_safety.sql`
- `apps/service/src/sending/worker-crash.integration.test.ts` — mandatory real crash/overlap evidence.
- `apps/cli/src/config/local-state.ts`
- `apps/cli/src/config/local-state.test.ts` — mandatory lock ownership/recovery/subprocess evidence.

### Delete

- `.github/workflows/ci.yml` — no replacement.

### Rewrite/modify — service

- `apps/service/src/suppressions/write.ts`
- `apps/service/src/ses/process-event.ts`
- `apps/service/src/ses/errors.ts`
- `apps/service/src/http/respond.ts`
- `apps/service/src/unsubscribe/unsubscribe.ts`
- `apps/service/src/lists/write.ts`
- `apps/service/src/sending/schema.ts`
- `apps/service/src/sending/attempts.ts`
- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/mailings/lifecycle.ts`
- `apps/service/src/mailings/read-model.ts`
- `apps/service/src/queue/runner.ts`
- `apps/service/src/operations/query.ts`
- `apps/service/src/operations/read-model.ts`
- `apps/service/src/ses/simulator.ts`
- `apps/service/src/ses/read-model.ts`
- `apps/service/src/device-auth/attempt-limiter.ts`
- `apps/service/src/device-auth/routes.ts`
- `apps/service/src/device-auth/service.ts`
- `apps/service/src/ses/event-schema.ts`
- `apps/service/src/aws/readiness.ts`
- corresponding focused tests named in phases 1–5
- `apps/service/src/db/migrate.integration.test.ts`

### Rewrite/modify — contract/CLI/E2E

- `packages/api-contract/src/mailings/schema.ts`
- `apps/cli/src/config/paths.ts`
- `apps/cli/src/config/profiles.ts`
- `apps/cli/src/credentials/file-store.ts`
- `apps/cli/src/commands/login.ts`
- `apps/cli/src/commands/logout.ts` only if call-site adaptation is needed
- `apps/cli/src/commands/context.ts` and/or `apps/cli/src/main.ts` for injected runtime dependencies
- `apps/cli/src/commands/mailings.ts`
- corresponding focused CLI tests named in phases 2/5
- `e2e/cli-service.e2e.test.ts` where it protects a real changed boundary

### Rewrite/modify — docs/evidence/config

- `PROJECT.md`
- `README.md`
- `.env.example`
- `docs/api.md`
- `docs/auth-and-api-keys.md`
- `docs/cli.md`
- `docs/troubleshooting.md`
- `docs/operations.md`
- `docs/observability.md`
- `docs/engagement-tracking.md`
- `docs/ses-setup.md`
- `docs/deployment.md` only for selected compatibility notes
- `docs/production-readiness.md`
- `docs/test-audit/final-inventory.json`
- `docs/test-audit/manifest.json`
- `docs/test-audit/audit.md`
- new final raw report/progress/review-batch evidence under `.progress/`

### Retain unchanged

- `docs/test-audit/baseline-inventory.json`
- existing API routes/methods and shared error-code catalog
- transport retry policy (`maxAttempts: 1`)
- queue lease ownership predicates
- SES event ingestion’s audit-only delivery-status boundary
- historical `.plans/`, `.reviews/`, and `.progress/` artifacts

## Implementation delegation

Recommended bounded lanes:

- Worker A: suppression/list safety and tests.
- Worker B: ambiguity migration/runtime/contracts and tests.
- Worker C: device limits + SES validation/readiness and tests.
- Worker D: CLI lock/polling and tests.
- Main/single writer: shared docs, `PROJECT.md`, test-audit manifest/final inventory, integration synthesis.

Parallel writers must use isolated worktrees. In one worktree, run lanes sequentially. Migration/ambiguity is the highest-risk lane and should be integrated before shared documentation/audit finalization.

## Risks and mitigations

- **Migration loses child rows/indexes:** rebuild the entire dependent graph; assert representative DML, all index names and `foreign_key_check` through UP/DOWN/re-UP.
- **Historical ambiguity is misclassified:** convert only when the latest attempt is ambiguous; require a non-null MessageId on that exact attempt and a null/equal delivery MessageId for sent.
- **Late callback corrupts newer attempt:** exact attempt/delivery identity, no newer attempt, compatible MessageIds, paired transactional updates and checked zero-row read-back.
- **Ambiguous outcome is retried:** treat as terminal in delivery/lifecycle and ensure second worker cycle never dispatches.
- **Suppression downgrade/race:** monotonic SQL priority plus guarded transactional delete.
- **List creation/deletion race:** one guarded write transaction with SQLite write serialization.
- **CLI stale lock steals live owner:** same-host dead-PID proof, reaper serialization, token verification, bounded wait, fail closed on uncertainty.
- **CLI lock/test hangs:** bounded retries/subprocess timeouts and `finally` cleanup; no lock held across network/sleep.
- **Rate limiter memory attack:** global prune, key cap, bounded timestamps and fail-closed new-key behavior.
- **Webhook malformed retry storm:** behavior is intentional and observable through one audit row plus SNS retry/DLQ; no duplicate event/suppression writes.
- **Test volume without value:** every addition must state the invariant, production boundary, limitation and wiring in the audit manifest; no percentage/count target.
- **Scope accidentally claims production readiness:** final docs/reports must retain excluded blockers and live validation as open.

## Definition of done

- All selected findings map to implemented code and high-value evidence.
- Suppression promotion/deletion and active-list deletion are race-safe.
- Delivery ambiguity is explicit end-to-end across schema, runtime, API, operations, CLI, simulator and docs.
- Migration 0009 preserves all dependent rows/indexes/FKs and passes UP/DOWN/re-UP validation.
- Device token traffic and limiter memory are bounded; durable pending semantics are exact.
- Signed malformed Bounce/Complaint events remain unprocessed/retryable with one raw audit row.
- Optional tracking readiness reflects configuration only.
- Concurrent CLI processes cannot lose unrelated profiles/credentials; polling is iterative, minimum-paced and expiry-aware.
- `.github/workflows/ci.yml` is removed with no replacement.
- `PROJECT.md` accurately describes current behavior and still marks excluded production-readiness work as open.
- New tests are behavioral/high-value; committed audit evidence is byte-current and independently reconciled.
- Full local checks, build, manual service/browser/CLI smoke, and independent reviews pass.
- No claim is made for excluded deployment, TLS, retention, live-provider, backup/restore, or hosted-CI validation.
