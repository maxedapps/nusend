# Add Fake Email Workflow Tests

## Summary

Add targeted test coverage for the full local email-sending workflow without AWS SES. The goal is to prove the real API, database, send worker, fake email transport, and operations read model work together, and to close smaller gaps in retry, multi-recipient lifecycle, and permanent transport failure coverage.

Independent review of this plan confirmed the core approach, but tightened the scope: only the API → fake worker → operations success path needs a new full integration test; retry, multi-recipient lifecycle, and permanent transport failure should stay in existing sending tests to avoid unnecessary HTTP/read-model coupling.

This plan is test-first only. It does not add production behavior unless the optional fake worker CLI mode is explicitly chosen later.

## Clarification status and assumptions

No clarification is needed before planning. Assumptions:

- The immediate goal is better automated/local confidence without SES.
- Production `worker:send:once` should keep using real SES unless a separate fake-worker dev mode is intentionally added.
- New tests should fit existing Effect v4, Vitest, Hono, fake auth, fake DB, and fake transport patterns.
- Prefer a few high-value integration/scenario tests over broad duplication of existing processor tests.

## Current-state findings

Relevant files inspected:

- `apps/service/src/testing/layers.ts`
- `apps/service/src/testing/email-transport.ts`
- `apps/service/src/mailings/routes.test.ts`
- `apps/service/src/operations/routes.test.ts`
- `apps/service/src/sending/process-delivery.test.ts`
- `apps/service/src/sending/worker.test.ts`
- `apps/service/src/queue/runner.test.ts`
- `apps/service/src/sending/worker-main.ts`
- `apps/service/src/services/email-transport.ts`

Existing coverage is good for internal worker/processor behavior:

- `apps/service/src/sending/process-delivery.test.ts` covers fake successful sends, retryable transport failures, retry-dead behavior, ambiguous transport failures, marketing policy block, global suppression, placeholder rendering/escaping, invalid vars, terminal delivery skip, and stale in-flight ambiguity.
- `apps/service/src/queue/runner.test.ts` covers send-worker claim/complete and expired-lease dead-job reconciliation.
- `apps/service/src/sending/worker.test.ts` covers due vs future jobs through `runSendWorkerOnce`.
- `apps/service/src/mailings/routes.test.ts` covers HTTP mailing creation and auth/permission/idempotency behavior.
- `apps/service/src/operations/routes.test.ts` covers operations summaries/lists/details from seeded data.

Important gaps:

1. No black-box-ish API → fake worker → operations integration test.
2. No retry-across-multiple-worker-runs test.
3. No multi-recipient partial lifecycle test.
4. No direct permanent transport failure test.
5. No fake `worker-main.ts` CLI/dev mode; the CLI always wires `EmailTransportSesLive`.

## Research findings

This plan depends on local project patterns, not new third-party API behavior. Relevant local patterns:

- `withTestApp(...)` in `apps/service/src/testing/layers.ts` creates a real Hono app with a shared `ManagedRuntime` containing test DB, TestClock, ID generation, and fake auth.
- `fakeEmailTransportLayer(...)` and `fakeSendingConfigLayer(...)` in `apps/service/src/testing/email-transport.ts` can be provided around `runSendWorkerOnce(...)` to process sends without SES.
- The existing `ManagedRuntime` can run a worker effect that is locally provided with fake email layers, while still sharing the same runtime-provided DB/ID services used by the Hono app.
- The shared TestClock should be pinned before the HTTP create step in the full workflow test to keep timestamps deterministic, even if assertions avoid exact timestamps.
- A single fake transport instance must be reused across multiple worker runs when testing retry sequences, because the outcome cursor lives in the fake layer closure.
- Operations routes can be called through the same `app.fetch(...)` instance after the worker mutates the shared test DB.

## Chosen strategy

Add automated tests first, without adding fake production CLI behavior. Use one new full workflow integration test for API/worker/operations wiring, and add the remaining behavior scenarios to existing sending tests.

Rationale:

- It gives immediate confidence in the exact missing workflows.
- It avoids accidentally creating a production footgun where fake sending could be enabled in the wrong environment.
- It keeps scope small and aligns with the project’s existing fake-layer testing style.
- A fake manual worker mode can be planned separately if still desired after tests exist.

## Alternatives considered

### Alternative A — Add fake worker CLI mode now

Example:

```sh
NUSEND_EMAIL_TRANSPORT=fake pnpm --filter @nusend/service worker:send:once
```

Rejected for this immediate plan. It is useful for manual local testing, but it changes runtime behavior and requires safety design so fake transport cannot be accidentally used in production. Automated tests can close the current verification gap with less risk.

### Alternative B — Only add more unit tests around `processSendDeliveryJob`

Rejected. The largest gap is integration across API creation, worker processing, and operations inspection. More processor-only tests would not prove that the real route/runtime/read-model pieces interoperate.

### Alternative C — Use real SES in tests

Rejected. Real SES is unsuitable for routine local/CI tests due to credentials, account sandbox state, network variability, cost/side effects, and slow/flaky failure modes.

## Implementation plan

### Phase 1 — Add a workflow integration test file

Create a new test file, recommended:

- `apps/service/src/sending/fake-workflow.integration.test.ts`

Purpose:

- Test the complete local workflow without SES:
  1. POST `/api/mailings` through Hono with fake API-key auth.
  2. Run `runSendWorkerOnce(...)` against the same test runtime with fake email transport/config layers.
  3. Query `/api/operations/summary` and `/api/operations/deliveries/:id` through Hono.
  4. Assert DB and API-visible lifecycle outcomes.

Recommended helper shape inside the test file:

```ts
async function runFakeWorkflow(
  body: unknown,
  workerOptions?: SendWorkerOnceOptions,
  transportOutcomes?: readonly FakeTransportOutcome[],
) {
  const fake = fakeEmailTransportLayer(transportOutcomes);

  await withTestApp(
    { auth: { apiKeyPermissions: { mailings: ["create"], operations: ["read"] } } },
    async (app, runtime) => {
      await runtime.runPromise(TestClock.setTime(fixedTime));

      const create = await app.fetch(new Request("http://localhost/api/mailings", { ... }));
      const createBody = await create.json();

      const workerResult = await runtime.runPromise(
        runSendWorkerOnce(workerOptions ?? { workerId: "worker_1" }).pipe(
          Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer())),
        ),
      );

      const summary = await app.fetch(new Request("http://localhost/api/operations/summary", ...));
      const detail = await app.fetch(new Request(`http://localhost/api/operations/deliveries/${deliveryId}`, ...));

      // assertions or return structured data
    },
  );
}
```

Important details:

- Use one `withTestApp(...)` callback so API, worker, and operations share the same in-memory DB/runtime.
- Use API-key permissions containing both `mailings:create` and `operations:read`.
- To discover `deliveryId`, query the DB through `runtime.runPromise(Effect.flatMap(Database, ...))`. Prefer DB query for stable test setup; operations detail still verifies API read model after worker.
- Use `toMatchObject` for operations summary/detail assertions. Do not assert the entire response shape or exact timestamps in this workflow test; existing operations tests cover full response shape.
- Provide fake email layers directly around `runSendWorkerOnce(...)`; do not modify production runtime wiring.

### Phase 2 — Test API → fake worker success → operations

Add test case:

```txt
POST /api/mailings transactional recipient
run fake worker once
GET /api/operations/summary
GET /api/operations/deliveries/:id
```

Assert:

- Create response is `201`; mailing initially `scheduled`.
- Worker result: use `toMatchObject` or include all fields: `{ released: 0, claimed: 1, succeeded: 1, failed: 0, dead: 0, skippedStale: 0 }`.
- Fake transport captured one prepared email with expected `to`, `from`, subject/html/text, tags, and transactional configuration set.
- Summary shows, via `toMatchObject`:
  - deliveries: `sent: 1`.
  - jobs: `succeeded: 1`.
  - sendAttempts: `succeeded: 1`.
  - `recentIssues: []`.
- Delivery detail shows, via `toMatchObject`:
  - delivery `status = sent`, `sesMessageId = fake-message-1`.
  - job `state = succeeded`.
  - attempts contain `succeeded` and fake message ID.
  - mailing `state = completed`.

Why this matters:

- It proves the missing end-to-end local workflow without SES.

### Phase 3 — Add retry across multiple worker runs

Add this test in `apps/service/src/sending/process-delivery.test.ts`, not the workflow integration file. It exercises worker/processor retry behavior and does not need HTTP or operations routes.

Scenario:

1. Create one fake transport instance and reuse its layer for both worker runs. Configure outcomes:
   - first call: retryable `EmailTransportError`
   - second call: success `{ messageId: "fake-message-2" }`
2. Create mailing due now.
3. Run worker once.
4. Assert:
   - job `queued`
   - delivery `queued`
   - mailing `sending`
   - attempt 1 `failed`
5. Advance `TestClock` beyond SQL backoff, e.g. from `12:00` to `12:02`.
6. Run worker again.
7. Assert:
   - job `succeeded`
   - delivery `sent`
   - mailing `completed`
   - attempts are `[failed, succeeded]` with attempt numbers `1`, `2`.
   - fake transport was called twice.

Important pitfall:

- Do not create a fresh `fakeEmailTransportLayer(...)` for the second run; that resets the outcome index and would fail again instead of succeeding.

Potential pitfall:

- Backoff for attempt 1 schedules `run_at` at +60s from failure time. Advance clock far enough to be due.

### Phase 4 — Add multi-recipient partial lifecycle test

Add this test in `apps/service/src/sending/process-delivery.test.ts`.

Scenario:

1. Create a mailing with two explicit recipients. First assert the setup produced two deliveries and two jobs; this verifies the job-per-delivery fan-out assumption before relying on `batchSize: 1`.
2. Run worker once with `batchSize: 1`.
3. Assert:
   - one delivery `sent`, one delivery `queued`.
   - one job `succeeded`, one job `queued`.
   - mailing `sending`.
   - worker result `claimed: 1`, `succeeded: 1`.
4. Run worker again with `batchSize: 1`.
5. Assert:
   - both deliveries `sent`.
   - both jobs `succeeded`.
   - mailing `completed`.
   - fake transport captured two emails to the two recipients.

Why this matters:

- It proves the lifecycle helper does not prematurely mark a partially processed mailing `completed`.

### Phase 5 — Add permanent transport failure branch test

Add a small test to `apps/service/src/sending/process-delivery.test.ts`.

Scenario:

- Fake transport returns:

```ts
new EmailTransportError({ kind: "permanent", operation: "send" })
```

Assert:

- Worker result `succeeded: 1` (job completed; no retry).
- Job `succeeded` and `last_error = null`.
- Delivery `failed` with `Email transport permanent failure.`.
- Attempt `failed` with same message.
- Mailing `completed`.
- Fake transport captured one attempted send.

Why this matters:

- It directly covers `process-delivery.ts` permanent transport branch, currently not directly tested.

### Phase 6 — Keep helper cleanup minimal

After moving retry/multi-recipient/permanent failure tests into `process-delivery.test.ts`, the new workflow integration file may need little or no helper extraction. Prefer inline setup or one tiny local helper.

Avoid:

- Creating a large test harness abstraction.
- Extracting shared helpers before there is real duplication.
- Adding production fake-worker code as part of this test-only plan.
- Rewriting existing tests broadly.

### Phase 7 — Optional fake worker CLI/dev mode (separate follow-up)

If manual local fake processing is still desired after the tests are added, create a separate implementation plan for a dev-safe fake worker mode.

Design constraints for that separate plan:

- Fake mode must be explicit and hard to enable accidentally.
- It should not share production `worker:send` command silently.
- It should print clear logs that no email was sent.
- Consider naming the script `worker:send:fake-once` rather than overloading SES worker behavior.

## Files likely to change

Primary:

- `apps/service/src/sending/fake-workflow.integration.test.ts` (new, one full API/worker/operations success path)
- `apps/service/src/sending/process-delivery.test.ts` (retry across runs, multi-recipient partial lifecycle, permanent transport failure)

Possibly:

- `apps/service/src/testing/email-transport.ts` only if helper support is truly needed.
- `apps/service/src/testing/layers.ts` only if runtime composition becomes too awkward; initial approach should avoid changing it.

Not expected:

- `apps/service/src/queue/runner.test.ts`; current runner-specific coverage is enough for this plan.

No production files should need to change for the automated-test scope.

## Testing and verification plan

Run targeted tests:

```sh
pnpm test -- apps/service/src/sending apps/service/src/queue apps/service/src/mailings apps/service/src/operations
```

Run full checks:

```sh
pnpm check
```

Expected result:

- New tests pass using fake transport.
- No AWS env vars or credentials required.
- Existing lint/typecheck/format remain clean.

## Risks and mitigations

### Risk: tests become too coupled to exact operations response shape

Mitigation:

- For the full workflow test, assert important fields exactly but use `toMatchObject` where unrelated response structure is not the point.
- Keep detailed response-shape testing in `operations/routes.test.ts`.

### Risk: helper abstraction hides what is being tested

Mitigation:

- Keep helper local and small.
- Prefer explicit setup steps in each scenario if the test count stays small.

### Risk: fake transport gives false confidence about SES behavior

Mitigation:

- Name tests clearly as fake/local workflow tests.
- Keep SES adapter tests in `email-transport-ses.test.ts` separate.
- Document that fake workflow tests validate Nusend orchestration, not AWS SES delivery.

### Risk: TestClock/backoff mismatch causes flaky retry test

Mitigation:

- Advance clock well past the expected backoff boundary.
- Assert job `run_at` after first run if debugging is needed.

## Acceptance criteria

- A test proves `POST /api/mailings` → fake `runSendWorkerOnce` → `/api/operations/*` success path without SES.
- A `process-delivery.test.ts` test proves retryable failure can requeue and later succeed across worker runs while reusing one fake transport instance.
- A `process-delivery.test.ts` test proves multi-recipient mailings create one job per delivery and remain `sending` until all deliveries are terminal.
- A `process-delivery.test.ts` test directly covers permanent transport failures.
- No AWS SES environment variables or credentials are required for these tests.
- `pnpm test -- apps/service/src/sending apps/service/src/queue apps/service/src/mailings apps/service/src/operations` passes.
- `pnpm check` passes.

## Open questions

None for the automated-test plan.

Manual fake worker mode remains intentionally out of scope and should be planned separately if desired.

## Implementation Progress

Started: 2026-07-08

### Loop breakdown

- [x] Loop 1 — Analyze current test helpers/patterns and add full API → fake worker → operations integration test.
  - Verification: targeted `pnpm test -- apps/service/src/sending/fake-workflow.integration.test.ts` (or nearest supported Vitest target).
  - Human checkpoint: not required; scope is test-only and plan has no open questions.
- [x] Loop 2 — Add process-delivery scenario tests: retry across worker runs, multi-recipient partial lifecycle, permanent transport failure.
  - Verification: targeted `pnpm test -- apps/service/src/sending/process-delivery.test.ts`.
  - Human checkpoint: not required unless production changes become necessary.
- [x] Loop 3 — Run broader validation, independent reviews, and apply reviewer feedback.
  - Verification: `pnpm test -- apps/service/src/sending apps/service/src/queue apps/service/src/mailings apps/service/src/operations`, `pnpm check`.
  - Human checkpoint: skipped unless validation/review reveals scope or product decisions.

### Log

- 2026-07-08 — Read full plan before edits. Current git status already has unrelated modified files from prior state-queue work; this implementation will avoid production changes and only touch planned test files plus this retained progress section unless a necessary test helper adjustment is discovered.
- 2026-07-08 — Loop 1 implemented `apps/service/src/sending/fake-workflow.integration.test.ts` for API create → fake worker → operations summary/detail. Validation: `pnpm test -- apps/service/src/sending/fake-workflow.integration.test.ts` exited 0 (Vitest selected 26 files / 170 tests due project filter behavior).
- 2026-07-08 — Loop 2 implemented three `process-delivery.test.ts` scenarios: retry across worker runs with one fake transport instance, multi-recipient partial lifecycle, and permanent transport failure. Validation: `pnpm test -- apps/service/src/sending/process-delivery.test.ts` exited 0 (Vitest selected 26 files / 173 tests due project filter behavior).
- 2026-07-08 — Loop 3 broader validation completed: `pnpm test -- apps/service/src/sending apps/service/src/queue apps/service/src/mailings apps/service/src/operations` exited 0; first `pnpm check` found formatting in new integration test, fixed via targeted `pnpm exec oxfmt --write apps/service/src/sending/fake-workflow.integration.test.ts apps/service/src/sending/process-delivery.test.ts`; rerun `pnpm check` exited 0 with only pre-existing `main.integration.test.ts` no-await-in-loop warnings. Independent Claude review session `54c1900b-8261-4c65-9383-e50c8808dfd4` found no blockers; fixed tracker checkbox/log issue and added a small ordering comment for the optional multi-recipient ordering note.
- 2026-07-08 — Claude follow-up review confirmed all material concerns resolved and no blocker remains. Validation after fixes: `pnpm test -- apps/service/src/sending/process-delivery.test.ts` exited 0 and `pnpm check` exited 0 with only the existing `main.integration.test.ts` warnings. Improve-skills review found no project skill update warranted for this test-only implementation.
