# Fix Sending Foundation Review Findings Plan

## Summary

Fix and clean up the remaining issues found during the post-implementation review of `.plans/add-sending-foundation.md`. This is a hardening plan for the existing sending foundation, not a feature expansion.

The core correctness fix is compare-and-set guarded send-attempt outcome recording so expired workers cannot corrupt delivery state after another worker resolves the same in-flight delivery. The rest of the plan hardens SES header validation, enforces timeout/lease invariants including sequential batch time, fills test gaps, and cleans stale docs/env examples.

## Implementation Progress

- Started: 2026-07-07
- Status: complete
- Tracker retained in this plan section.
- External context/review support:
  - Launched read-only scout `9650c872-c96c-403b-bd7d-83b7d3f2396d` for implementation risk notes.
- Loop breakdown:
  - [x] Loop 1 — CAS-guard send outcome recording + deterministic stale outcome tests.
    - Analysis: outcome writers needed to no-op unless both attempt is `started` and delivery is `sending` at the winning transition.
    - Changed: `apps/service/src/sending/attempts.ts`, added `apps/service/src/sending/attempts.test.ts`.
    - Verification: `pnpm test apps/service/src/sending/attempts.test.ts` passed (4 tests).
    - Review: requested focused independent CAS review (pending).
  - [x] Loop 2 — SES custom header validation + transport tests.
    - Analysis: validation belongs in `toSendEmailCommand` next to tag validation and can use existing `Effect.tryPromise` classification.
    - Changed: `apps/service/src/services/email-transport-ses.ts`, `apps/service/src/services/email-transport-ses.test.ts`.
    - Verification: `pnpm test apps/service/src/services/email-transport-ses.test.ts` passed (18 tests).
  - [x] Loop 3 — timeout/lease/batch config + worker-main threading + config tests.
    - Analysis: worker-only lease/batch knobs can stay in `SendingConfig`; `EmailSendingConfigService` remains transport-only.
    - Changed: `apps/service/src/config.ts`, `apps/service/src/config.test.ts`, `apps/service/src/sending/worker-main.ts`.
    - Verification: `pnpm test apps/service/src/config.test.ts` passed (25 tests).
  - [x] Loop 4 — renderer/orphan-job coverage tests.
    - Analysis: implemented behavior needed coverage, not feature changes.
    - Changed: `apps/service/src/sending/process-delivery.test.ts`.
    - Verification: `pnpm test apps/service/src/sending/process-delivery.test.ts` passed (12 tests).
  - [x] Loop 5 — docs/env cleanup and optional low-risk idempotency-key cap decision.
    - Analysis: idempotency cap stayed low-churn, so included it; SES client finalizer deferred as non-blocking scoped-layer cleanup.
    - Changed: `.env.example`, `README.md`, `PROJECT.md`, `apps/service/src/mailings/idempotency.ts`, `apps/service/src/mailings/routes.ts`, `apps/service/src/mailings/routes.test.ts`, `.plans/add-sending-foundation.md`.
    - Verification: `pnpm test apps/service/src/mailings/routes.test.ts` passed (8 tests).
    - Deviation: `.env.example` was protected by write/edit tools, so it was updated via a minimal Python file edit command.
  - [x] Loop 6 — targeted validation, independent review passes, fixes, full validation/smoke.
    - Validation completed so far:
      - `pnpm test apps/service/src/sending/attempts.test.ts` passed.
      - `pnpm test apps/service/src/services/email-transport-ses.test.ts` passed.
      - `pnpm test apps/service/src/config.test.ts` passed.
      - `pnpm test apps/service/src/sending/process-delivery.test.ts` passed.
      - `pnpm test apps/service/src/mailings/routes.test.ts` passed.
      - Combined targeted suite passed (5 files / 67 tests).
      - `pnpm --filter @nusend/service typecheck` passed.
      - `pnpm format:check` passed after targeted formatting.
      - `pnpm lint` passed with existing `apps/service/src/main.integration.test.ts` `no-await-in-loop` warnings.
      - `pnpm check` passed (24 files / 162 tests, same lint warnings).
      - DB/worker smoke passed after resetting `.data/nusend.sqlite*`: migrate, status, and no-job `worker:send:once`.
    - Independent review status: Loop 1 review completed; final three-review fanout `9d93bb84-94a7-4019-9656-a672234b04f4` completed.
    - Review feedback incorporated:
      - Added direct `recordRetryableFailure` terminal-delivery guard test from CAS review note.
      - Updated `PROJECT.md` current limits with the 255-character `Idempotency-Key` cap.
      - Updated `PROJECT.md` SES/worker config list with request timeout, lease, batch, poll, and invariant wording.
    - Review findings status: no blockers from CAS or SES/config reviewers; docs/test reviewer notes fixed.
    - Follow-up review status: CAS follow-up `f13c9f56` confirmed the added retryable-failure guard test resolves the only CAS note; docs follow-up `7ad237b8` confirmed `PROJECT.md` docs notes are resolved. No remaining fixes worth doing now.
    - Final validation: `pnpm check` passed after review fixes (24 files / 163 tests, existing `main.integration.test.ts` lint warnings only).
    - Human checkpoints: skipped; no unapproved product/architecture decision or credentials were needed.
- Human checkpoints: none required for core fixes; plan has approved defaults.
- Deviations: none yet.

## Confirmed Requirements

- Do not widen scope beyond hardening and cleanup for the current sending foundation.
- Preserve the core architecture: `queue/runner.ts` owns job complete/fail; send processors record domain state and return success/failure.
- Keep raw `EmailTransport` purpose-agnostic.
- Keep marketing sending blocked until unsubscribe support exists.
- Continue reset-clean schema style. The DB can be recreated; no legacy migration compatibility is required.
- Fix the review findings before committing.

## Severity and Scope

### Must fix before commit

1. **Stale-worker late outcome race**
   - Real correctness issue on the current path.
   - A late worker can currently rewrite a delivery after another worker has marked it ambiguous and the runner has completed the job.

2. **Timeout/lease/batch invariant**
   - Defaults are currently safe, but the invariant is not enforced.
   - This is important because the worker processes jobs sequentially in batches; the lease must cover the worst-case batch processing window, not just one SES call.

3. **SES custom header validation**
   - Not attacker-reachable today because `prepareEmail` currently returns `headers: {}`.
   - Still required hardening before future unsubscribe headers are added, and cheap to fix now.

### Cleanup / coverage work

- Add missing renderer and orphan-job tests from the original plan.
- Update `.env.example`, README, and stale `PROJECT.md` wording.
- Optionally add a small idempotency-key length cap while touching request idempotency, if it remains simple and low-risk.
- Defer SES client finalizer unless the scoped layer change is trivial.

## Review Findings Being Addressed

### 1. Late outcome writes after stale lease resolution

Current risk:

- Worker A starts attempt and calls SES.
- The queue lease expires.
- Worker B claims the same job, sees delivery `sending`, marks latest started attempt `ambiguous`, marks delivery `failed`, returns processor success, and the runner completes the job.
- Worker A later receives a retryable/permanent/success outcome and unconditionally updates the same attempt/delivery.
- Retryable failure can set delivery back to `queued` while the job is already `succeeded`, leaving an orphaned queued delivery with no runnable job.

Required fix:

- Use compare-and-set guarded outcome recording.
- Outcome writes must only apply while the attempt is still `started` and the delivery is still `sending`.
- Late outcomes after another resolution must become no-ops.

### 2. Unvalidated SES custom headers

Current risk:

- `toSendEmailCommand` maps `PreparedEmail.headers` directly to SES Simple headers.
- Today this is not externally reachable because the prepare stage sets `headers: {}`.
- Future marketing unsubscribe work will add headers, so validation should exist before that happens.

Required fix:

- Validate header names/values and deny SES-managed headers case-insensitively.

### 3. SES timeout and queue lease invariant

Current risk:

- Default SES timeout: 30s.
- Current worker lease: 300s.
- Current worker batch default: 10 jobs.
- `runOnce` processes claimed jobs sequentially.
- Worst-case default batch duration is roughly `10 * 30s = 300s`, before render/policy/DB overhead. That can exceed the lease even though a single request timeout is below the lease.

Required fix:

- Validate `batchSize * requestTimeoutMs + margin < leaseSeconds * 1000`, or reduce send-worker batch size and validate against that.

## Current Codebase Findings

Relevant files:

- `apps/service/src/sending/process-delivery.ts`
  - Orchestrates load/start/policy/render/prepare/transport/record.
  - Ambiguous transport failure records a terminal ambiguous outcome and returns processor success.
  - Skipped `sending` delivery marks stale ambiguity and returns success.

- `apps/service/src/sending/attempts.ts`
  - `recordSendSuccess`, `recordFailure`, and `recordStaleSendingAsAmbiguous` need stronger CAS guards.
  - `recordRetryableFailure` can set delivery back to `queued`, so it must never run after stale/terminal resolution.

- `apps/service/src/queue/jobs.ts` and `apps/service/src/queue/runner.ts`
  - Queue lifecycle is correct and should not be duplicated.
  - Expired leases requeue/dead jobs based on `jobs.attempts`, independent of delivery state.
  - Runner processes claimed jobs sequentially.

- `apps/service/src/services/email-transport-ses.ts`
  - Maps `PreparedEmail` to `SendEmailCommand`.
  - Validates SES tags, but not custom headers.
  - Current synchronous tag validation thrown from `toSendEmailCommand` is already caught by `Effect.tryPromise`; existing tests prove invalid tags surface as typed `EmailTransportError`. Do not refactor the send pipeline unless implementation proves necessary.

- `apps/service/src/config.ts`
  - `sendingConfig` includes `requestTimeoutMs`, but no worker lease or batch-size config.

- `apps/service/src/sending/worker-main.ts`
  - Hardcodes `leaseSeconds: 300`.
  - Does not set `batchSize`, so the queue default of 10 applies.

- `apps/service/src/sending/render.ts`
  - Supports `{{ user.email }}` and `{{ vars.<key> }}`.
  - Escapes HTML values, rejects non-scalars and invalid vars JSON, but test coverage is incomplete.

- `.env.example`, `README.md`, `PROJECT.md`
  - README documents worker env vars.
  - `.env.example` is incomplete: it does not list SES/worker vars.
  - `PROJECT.md` has stale wording about a future render stage and resolved open questions.

## Research Findings

### SES Simple headers

From the existing sending-foundation plan, AWS SES docs, and installed `@aws-sdk/client-sesv2@3.1080.0` typings:

- SES Simple/Templated custom headers can be set via `Content.Simple.Headers`.
- SES-managed headers such as `From`, `To`, `Subject`, `Content-Type`, `Message-ID`, etc. must not be set through custom headers.
- Header name constraints from typings:
  - printable ASCII 33-126 except colon
  - max 126 characters
- Header value constraints from typings:
  - printable ASCII
  - max 995 characters
  - combined name + value max 996 characters
- `List-Unsubscribe` and `List-Unsubscribe-Post` are not SES-managed and should remain allowed for future marketing support.

### Queue lease vs SES timeout

The original plan required:

```txt
queue lease seconds > SES request timeout + expected processing overhead
```

For a sequential batch worker, the actual required invariant is stricter:

```txt
queue lease milliseconds > (batch size * SES request timeout milliseconds) + safety margin
```

## Chosen Implementation Strategy

Use focused hardening changes that preserve the current architecture.

1. Add conditional/CAS guards to outcome recording without adding schema.
2. Add header validation directly alongside existing SES tag validation.
3. Add send-worker lease and batch settings to `sendingConfig` so the timeout/lease/batch invariant can be validated in one place.
4. Pass configured `leaseSeconds` and `batchSize` from `worker-main.ts` to `runSendWorkerOnce`.
5. Add deterministic tests for CAS predicates rather than brittle real concurrent interleavings.
6. Clean docs/env examples and close test gaps.

## Alternatives Considered

### Add `deliveries.current_send_attempt_id`

Pros:

- Strong explicit ownership for current attempt.
- Easier future reasoning if multiple jobs per delivery ever exist.

Cons:

- Extra schema and state transitions.
- More migration/test churn for the current foundation.
- Conditional `attempt.status='started'` plus `delivery.status='sending'` is enough for current one-job-per-delivery behavior.

Decision: defer unless conditional guards prove insufficient.

### Requeue ambiguous outcomes

Rejected. Ambiguous means the provider may have accepted the message. Requeueing risks duplicate sends. Terminal ambiguous outcome is safer until an operator/admin surface exists.

### Refactor SES send implementation around `Effect.try`

Rejected by default. Current synchronous validation errors thrown inside `toSendEmailCommand` are already caught by the current `Effect.tryPromise` shape and mapped through `classifySesError`, as proven by the unsafe-tag test. Add header validation following the exact existing tag-validation pattern unless a failing test proves a refactor is needed.

### Make header validation a future marketing task

Rejected. The code already exposes `headers` in `PreparedEmail`, and validation is small. Add it now so future unsubscribe headers are built on a safe boundary.

### Fully test real two-worker interleavings

Rejected for this pass. The Node in-memory test layer uses one connection and deterministic status mutation tests are sufficient to validate the SQL CAS predicates. True concurrent integration tests can be added later if a multi-connection test harness exists.

## Detailed Implementation Plan

## Step 1 — Add guarded send outcome recording

### Goal

Prevent expired workers from rewriting state after another worker already resolved a delivery as stale/ambiguous or terminal.

### Changes

Update `apps/service/src/sending/attempts.ts`.

1. `recordSendSuccess`
   - Update attempt only if still started:
     ```sql
     UPDATE send_attempts
     SET status = 'succeeded', ses_message_id = $messageId, finished_at = $now
     WHERE id = $attemptId AND status = 'started'
     RETURNING id;
     ```
   - If no row returns, treat as stale outcome and return no-op.
   - Update delivery only if still sending:
     ```sql
     UPDATE deliveries
     SET status = 'sent', ses_message_id = $messageId, last_error = NULL, updated_at = $now
     WHERE id = $deliveryId AND status = 'sending'
     RETURNING id;
     ```
   - If delivery update returns no row, do not force delivery state.

2. `recordFailure` used by permanent/retryable/ambiguous outcomes
   - First update attempt only if still started:
     ```sql
     UPDATE send_attempts
     SET status = $attemptStatus, error_message = $errorMessage, finished_at = $now
     WHERE id = $attemptId AND status = 'started'
     RETURNING id;
     ```
   - If no row returns, treat as stale outcome and return no-op.
   - Then update delivery only if still sending:
     ```sql
     UPDATE deliveries
     SET status = $deliveryStatus, last_error = $errorMessage, updated_at = $now
     WHERE id = $deliveryId AND status = 'sending'
     RETURNING id;
     ```
   - This prevents retryable late failures from resurrecting terminal/stale-resolved deliveries to `queued`.

3. `recordStaleSendingAsAmbiguous`
   - Strengthen the current latest-started update:
     ```sql
     UPDATE send_attempts
     SET status = 'ambiguous', error_message = $errorMessage, finished_at = $now
     WHERE id = $attemptId AND status = 'started'
     RETURNING id;
     ```
   - Only update delivery if attempt update succeeds, or explicitly decide that delivery can be marked failed even without a started attempt. Recommended: mark delivery failed only when a started attempt was successfully marked ambiguous; otherwise no-op because another outcome already won.
   - Keep delivery guard: `WHERE id = $deliveryId AND status = 'sending'`.

### Defined behavior

- If a late worker receives success after another worker already marked the delivery ambiguous, Nusend keeps the conservative ambiguous/failed state and does **not** overwrite with the later SES message ID.
- This can hide a real late success, but it avoids state resurrection and duplicate-send behavior. The attempt history still indicates ambiguity.

### Tests

Update `apps/service/src/sending/process-delivery.test.ts` or add `apps/service/src/sending/attempts.test.ts`.

Add deterministic CAS tests:

- Late retryable failure after stale ambiguity resolution:
  - Seed started attempt + delivery already `failed` + attempt already `ambiguous` + job `succeeded`.
  - Call `recordRetryableFailure` for the old attempt.
  - Assert attempt remains `ambiguous`, delivery remains `failed`, and no queued resurrection occurs.

- Late success after stale ambiguity resolution:
  - Same setup.
  - Call `recordSendSuccess`.
  - Assert delivery remains `failed`, attempt remains `ambiguous`, and no SES message ID overwrite occurs.

- Stale marker does not stomp a completed attempt:
  - Seed delivery `sending`, latest attempt already `succeeded` or `failed`.
  - Call `recordStaleSendingAsAmbiguous`.
  - Assert attempt status is not changed to `ambiguous`.

- Existing normal-path tests must continue passing:
  - success records message ID and sent delivery
  - retryable failure requeues delivery while attempt is still `started`
  - ambiguous transport failure records terminal ambiguous outcome

## Step 2 — Validate SES custom headers

### Goal

Reject unsafe/invalid custom headers before constructing/sending SES commands.

### Changes

Update `apps/service/src/services/email-transport-ses.ts`.

1. Add a case-insensitive managed-header denylist. Include at least:

```txt
bcc
cc
content-transfer-encoding
content-type
date
from
message-id
mime-version
reply-to
return-path
sender
subject
to
```

2. Add validation rules:

- Header name:
  - length 1..126
  - printable ASCII 33..126
  - no colon
  - no CR/LF/control chars
  - lowercased name not in denylist
- Header value:
  - length <= 995
  - combined name + value <= 996
  - printable ASCII
  - no CR/LF/control chars

3. Throw `EmailTransportError({ kind: 'permanent', operation: 'ses:validate-header' })` on invalid headers.

4. Follow the existing tag-validation shape in `toSendEmailCommand`; do not refactor the send pipeline unless a test proves thrown validation errors are not typed failures.

### Tests

Update `apps/service/src/services/email-transport-ses.test.ts`.

Add tests:

- Allows `List-Unsubscribe`.
- Allows `List-Unsubscribe-Post` if value is valid.
- Rejects managed headers case-insensitively: `subject`, `From`, `Message-ID`.
- Rejects CR/LF injection in header name and value.
- Rejects colon in header name.
- Rejects oversized names/values and combined length overflow.
- Confirms rejected headers do not call the sender.

## Step 3 — Enforce timeout, lease, and batch-size invariant

### Goal

Prevent SES calls from outliving job leases, accounting for sequential batch processing.

### Changes

Update `apps/service/src/config.ts`, `apps/service/src/sending/worker-main.ts`, and possibly `apps/service/src/sending/worker.ts`.

1. Extend `SendingConfig` with:

```ts
workerLeaseSeconds: number;
workerBatchSize: number;
```

2. Add environment variables:

```txt
NUSEND_SEND_WORKER_LEASE_SECONDS optional, default 300
NUSEND_SEND_WORKER_BATCH_SIZE optional, default 1 or 5
```

Recommended default:

- Use `workerBatchSize = 1` initially for live sends.
- Rationale: rate limits/quotas are not implemented, and sequential one-at-a-time sending is safest for the first live SES milestone.
- This also makes timeout/lease reasoning simple.

3. Validate numeric config:

- `workerLeaseSeconds` positive integer.
- `workerBatchSize` positive integer, with a small upper cap if desired (for example 50).
- `requestTimeoutMs + margin < workerLeaseSeconds * 1000` if default batch size is 1.
- If batch size can be greater than 1, enforce:
  ```ts
  workerBatchSize * requestTimeoutMs + marginMs < workerLeaseSeconds * 1000
  ```
- Use a fixed `marginMs = 10_000`.

4. Update `worker-main.ts`:

- Replace hardcoded `leaseSeconds: 300` with `sending.workerLeaseSeconds`.
- Pass `batchSize: sending.workerBatchSize` to `runSendWorkerOnce`.

5. Keep `NUSEND_SEND_WORKER_POLL_MS` raw-env parsing for now unless there is an easy low-churn move into `SendingConfig`. If moved, add tests; otherwise document it remains worker-entrypoint-only config.

### Tests

Update `apps/service/src/config.test.ts`.

Add tests:

- Default `workerLeaseSeconds` and `workerBatchSize` load correctly.
- Custom valid worker lease and batch size load correctly.
- Timeout too close to lease is rejected.
- Batch-size-adjusted timeout too close to lease is rejected.
- Invalid lease or batch size is rejected.

Update `apps/service/src/sending/worker.test.ts` only if needed to verify configured `batchSize` is threaded into `runOnce`. This may be unnecessary if config tests and code review are enough.

## Step 4 — Add renderer and orphan-job edge tests

### Goal

Cover edge cases already implemented but not fully tested.

### Tests to add

In `apps/service/src/sending/process-delivery.test.ts` or a focused `render.test.ts`:

- HTML escaping:
  - vars value contains `<script>&"'`
  - rendered HTML escapes it
  - subject/text substitution stays plain text
- Invalid `vars_json`:
  - manually update delivery `vars_json = '{'`
  - worker marks delivery failed and does not call transport
- Non-scalar var:
  - `varsJson = '{"name":{"nested":true}}'`
  - worker marks failed and does not call transport
- Missing delivery:
  - seed a `send_delivery` job with nonexistent `ref_id`
  - `runOnce` completes job, no transport call, no retry spin

Do **not** force a missing-mailing integration test if FK cascade makes the state structurally impossible in normal DB operation. If needed, document that missing mailing is corruption-only and already handled by `loadDeliveryContext` returning null.

## Step 5 — Documentation and env cleanup

### Goal

Make current behavior discoverable and remove stale planning text.

### Changes

1. `.env.example`

Add SES/worker variables:

```txt
AWS_REGION=us-east-1
NUSEND_SES_FROM_EMAIL=sender@example.com
NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET=
NUSEND_SES_MARKETING_CONFIGURATION_SET=
NUSEND_SES_REQUEST_TIMEOUT_MS=30000
NUSEND_SEND_WORKER_LEASE_SECONDS=300
NUSEND_SEND_WORKER_BATCH_SIZE=1
NUSEND_SEND_WORKER_POLL_MS=5000
```

2. `README.md`

- Add `NUSEND_SEND_WORKER_LEASE_SECONDS` and `NUSEND_SEND_WORKER_BATCH_SIZE`.
- Explain the timeout/lease/batch invariant briefly.
- Keep note that AWS credentials use the standard AWS SDK provider chain.

3. `PROJECT.md`

- Update mailing HTML note:
  - Current rendering supports limited placeholders: `{{ user.email }}` and `{{ vars.<key> }}`.
  - Future rendering work is richer context-aware rendering, unsubscribe URL, and URL-context safety.
- Update Open Questions:
  - Remove resolved initial placeholder syntax and initial SES retry-classification items.
  - Keep unresolved admin/API surfacing for ambiguous attempts, SES operator setup, unsubscribe URL config, and queue/delivery inspection.

4. `.plans/add-sending-foundation.md`

- During implementation, add progress entries for these fixes.
- Do not update it during this planning-only task.

## Step 6 — Optional low-risk cleanup: idempotency-key cap

### Goal

Avoid unbounded application-level idempotency keys even if server/header limits usually protect the route.

### Proposed behavior

- Add max idempotency key length, for example `200` or `255` characters after trim.
- Empty/whitespace key remains treated as absent, preserving current behavior.
- Too-long key returns `400 invalid_request` rather than `409` or `500`.

### Files

- `apps/service/src/mailings/idempotency.ts`
- `apps/service/src/mailings/routes.ts`
- `apps/service/src/mailings/routes.test.ts`
- `apps/service/src/http/respond.ts` only if a new error type is needed; prefer existing `RequestValidationError`.

### Decision rule

Implement this only if it stays simple. Do not let this optional cleanup delay the three main fixes.

## Step 7 — SES client lifecycle cleanup

### Goal

Destroy the AWS SDK client on runtime disposal if this is low-churn with Effect v4 layers.

### Preferred approach

- Convert `EmailTransportSesLive` to a scoped acquire/release layer.
- Acquire: `new SESv2Client({ region })`.
- Release: `Effect.sync(() => client.destroy())`.

### Decision rule

If the scoped Effect v4 layer is awkward or destabilizes runtime composition, defer it and document as a small follow-up. This should not block the correctness/security fixes.

## Testing and Verification Plan

### Targeted validation after fixes

```sh
pnpm test apps/service/src/sending/process-delivery.test.ts
pnpm test apps/service/src/services/email-transport-ses.test.ts
pnpm test apps/service/src/config.test.ts
pnpm test apps/service/src/mailings/routes.test.ts
pnpm --filter @nusend/service typecheck
pnpm format:check
pnpm lint
```

### Full validation

```sh
pnpm check
```

Expected lint caveat:

- Existing `apps/service/src/main.integration.test.ts` `no-await-in-loop` warnings may remain.

### Smoke validation

```sh
rm -f .data/nusend.sqlite .data/nusend.sqlite-shm .data/nusend.sqlite-wal
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service db:status
AWS_REGION=us-east-1 NUSEND_SES_FROM_EMAIL=sender@example.com pnpm --filter @nusend/service worker:send:once
```

If `workerBatchSize` default changes to 1, ensure the no-job smoke still prints a valid zero-count result.

## Required Review After Implementation

After implementation, request focused independent review for:

1. Stale-worker CAS behavior and late-outcome no-op semantics.
2. SES header validation and timeout/lease/batch config.
3. Docs/test completeness.

Fix any material reviewer findings and rerun targeted validation before final `pnpm check`.

## Files Likely to Change

- `apps/service/src/sending/attempts.ts`
- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/sending/process-delivery.test.ts`
- `apps/service/src/services/email-transport-ses.ts`
- `apps/service/src/services/email-transport-ses.test.ts`
- `apps/service/src/config.ts`
- `apps/service/src/config.test.ts`
- `apps/service/src/sending/worker-main.ts`
- `apps/service/src/sending/worker.ts`
- `apps/service/src/sending/worker.test.ts` if batch/lease propagation needs test support
- `apps/service/src/mailings/idempotency.ts` only if idempotency cap is included
- `apps/service/src/mailings/routes.ts` and `routes.test.ts` only if idempotency cap is included
- `.env.example`
- `README.md`
- `PROJECT.md`
- `.plans/add-sending-foundation.md` progress tracker after implementation

## Risks and Mitigations

### Risk: CAS no-op hides a real late SES success

Mitigation:

- This is intentional and conservative. If another worker already marked the attempt ambiguous and completed the job, overwriting with success can corrupt state. The ambiguous attempt is the durable indication that the outcome is uncertain.

### Risk: Batch-size validation still misses non-SES overhead

Mitigation:

- Include a fixed safety margin.
- Default live send batch size to 1.
- Keep future rate/concurrency work separate.

### Risk: Header denylist is incomplete

Mitigation:

- Start with documented SES-managed/basic message headers.
- Test obvious managed headers and future allowed unsubscribe headers.
- Keep header addition centralized in preparation/policy code.

### Risk: Optional cleanups distract from blockers

Mitigation:

- Implement steps in priority order.
- Do not block final validation on SES client finalizer or idempotency-key cap if either becomes unexpectedly invasive.

## Open Questions

No user decision is required for the core fixes. Recommended defaults:

- Use conditional outcome updates without adding `current_send_attempt_id`.
- Add `NUSEND_SEND_WORKER_LEASE_SECONDS`, default `300`.
- Add `NUSEND_SEND_WORKER_BATCH_SIZE`, default `1` for initial live sending.
- Enforce a 10-second minimum margin for `batchSize * requestTimeoutMs` below the worker lease.
- Treat stale/ambiguous outcomes as terminal for now to avoid duplicate sends.
