# Plan: Fix Every Implementation-Review Finding and Rebuild Test Confidence

## Summary

Repair every finding in `.reviews/fix-all-review-findings-implementation-review.md`, complete every admitted partial and omitted acceptance criterion from `.plans/fix-all-review-findings.md`, and replace false-confidence or low-value tests with behavioral coverage at the real boundary.

The immediate blockers are:

1. browser Approve/Deny submits a masked user code and fails;
2. an unexpected post-dispatch transport failure is made retryable and can duplicate email;
3. a final-attempt post-dispatch DB failure can leave a dead job with a permanently `started` send attempt.

The test objective is **not a higher test count or a percentage target**. Completion means every important invariant and acceptance criterion has a high-value fail-before test or recorded runtime evidence, weak tests have been deleted/rewritten, every baseline and final Vitest-collected test key has an explicit quality disposition, and the local gate passes. Hosted CI is a separate external landing gate tied to the reviewed SHA.

## Confirmed requirements

- Fix **all** High, Medium, Low, partial, documentation, compatibility, and validation findings from the detailed implementation review.
- Fix planning-time gaps discovered while tracing those findings, especially the nonexistent documented service `test` script and weak rollback/index assertions.
- Preserve:
  - masked device-code storage;
  - canonical public-origin/CSRF protections;
  - raw sending's purpose-agnostic boundary;
  - policy checks before transport;
  - no database transaction across network I/O;
  - no retry when provider acceptance is possible but unknown;
  - durable attempt/delivery/job audit invariants.
- Improve the testbase by removing false-confidence, duplicated, over-mocked, implementation-clone, and assertion-noise tests.
- Add only high-value behavioral tests at route, process, database, browser, Bun-runtime, CLI-composition, migration, and CI boundaries.
- Do not optimize raw test count or add brittle snapshots.
- No source-control workflow steps are prescribed. Implementation and verification only.

## Research and current-state findings

### Version-specific evidence

- Local runtime/dependencies: Bun `1.3.14`, `@types/bun@1.3.14`, Hono `4.12.27`, Effect `4.0.0-beta.93`, Vitest `4.1.9`.
- Bun documents `maxRequestBodySize` as a byte limit: <https://bun.com/reference/bun/Serve/BaseServeOptions/maxRequestBodySize>.
- Bun documents `await server.stop()` as graceful (waits for in-flight requests) and `server.stop(true)` as forced termination: <https://bun.com/docs/runtime/http/server>.
- Hono's testing guide uses real `Request`/`FormData` through the app boundary: <https://hono.dev/docs/guides/testing>.
- The current jsdom FormData implementation supports `FormData(form, submitter)` and constructs successful controls while excluding non-selected buttons: <https://raw.githubusercontent.com/jsdom/jsdom/main/lib/jsdom/living/xhr/FormData-impl.js>. `jsdom@29.1.1` supports the project's Node 24 CI and Node 26 local runtime; use it for browser-faithful form serialization in Vitest, while retaining one real-browser smoke.
- `.reviews/test-suite-critical-review.md` describes an older 47-file/280-test suite. Reverification against the current 71-file/437-test baseline shows many former recommendations are already high-value coverage and must be retained, not duplicated: signed SNS verification, SES abort wiring, stale-lease races, remaining SES row shapes, unsubscribe body cap, SES operations auth, and the send→bounce→suppression lifecycle.

### Relevant existing architecture

- Activation ownership: `apps/service/src/device-auth/{service.ts,activate-routes.ts,activate-routes.test.ts}`.
- Sending ambiguity/state ownership: `apps/service/src/sending/{process-delivery.ts,attempts.ts}` and `apps/service/src/queue/{runner.ts,runner.test.ts}`.
- Bun startup/lifecycle harness: `apps/service/src/main.integration.test.ts`.
- Structured logging boundary: `apps/service/src/http/respond.ts`, `apps/service/src/app.ts`, `apps/service/src/auth/middleware.ts`, `apps/service/src/device-auth/activate-routes.ts`, `apps/service/src/observability/effect-logger.ts`.
- Config duplication: `apps/service/src/config.ts`, `apps/service/src/sending/worker-main.ts`.
- CLI HTTP/parser composition: `apps/cli/src/{main.ts,client/http.ts,commands/context.ts,commands/login.ts}` and command modules.
- Contract types/exports: `packages/api-contract/src/{api-keys/schema.ts,pagination.ts,index.ts}`.
- Runtime acceptance gaps: `apps/service/src/main.integration.test.ts`, `db/startup-migration-check.test.ts`, `db/migrate.integration.test.ts`.
- Topic/idempotency gaps: `ses/{setup-guide.test.ts,webhook-routes.test.ts}`, `mailings/{routes.test.ts,idempotency.test.ts}`.
- `PROJECT.md` documents `pnpm --filter @nusend/service test`, but `apps/service/package.json` has no `test` script.

## Chosen strategy

Use a **surgical invariant-first implementation**:

1. fix the three landing blockers and their misleading tests first;
2. close real runtime/security acceptance gaps with Bun subprocess and real app tests;
3. complete observability/config/CLI/contract partials;
4. close SES/idempotency/migration/documentation gaps;
5. finish a suite-wide test-quality audit, deleting superseded tests only after stronger replacements pass;
6. run focused, full, browser, runtime, and hosted-CI validation with recorded evidence.

This is preferred over a broad refactor because shared-file collisions are substantial and the safety defects must not wait behind infrastructure cleanup. It is preferred over percentage coverage because coverage percentages cannot prove form fidelity, dispatch ambiguity, durable state, signal handling, or composition-root wiring.

## Test-quality standard

Before implementation, create `.progress/fix-findings-test-quality-audit.md` from a baseline Vitest JSON report. Inventory every collected case by stable key `relative file + full test name`; parameterized cases are separate keys only when they represent distinct inputs/failure modes. Also record file-level harness/boundary notes. Required columns:

`stable key → review source/finding → protected invariant/distinct failure mode → strongest boundary → production wiring that would break it → disposition (retain/rewrite/merge/delete) → replacement key → validation/mutation evidence`.

After edits, collect the final suite and reconcile every added/deleted/renamed key. Baseline/final file and case counts are reconciliation metadata, never quality targets. Blanket category rows do not satisfy the audit.

A test is retained only if it protects at least one of:

- public HTTP/CLI behavior;
- security/privacy/permission invariant;
- durable DB/queue/sending state;
- concurrency/crash recovery;
- production-driver/runtime behavior;
- external protocol/contract behavior;
- lifecycle/migration/rollout safety.

Rewrite, merge, or delete tests that:

- reconstruct a request instead of using generated browser/form output;
- clone production middleware/logic inside the test;
- assert only mocks, call order, SQL text, implementation helpers, or full snapshots;
- duplicate the same behavior through a weaker seam;
- increase count without a distinct failure mode;
- pass when the production composition root is unwired.

Every deleted test must name its stronger replacement or why the behavior is intentionally no longer required. A lower final test count is acceptable.

## Canonical test disposition manifest

| Current test area | Action | Replacement / reason |
|---|---|---|
| `app.test.ts` standalone mini-Hono sanitized-500 test | **Delete/merge** | One production-wired `createApp` test captures the structured Effect log, JSON 500, access log, status, and redaction. |
| `app.test.ts` cloned access-log middleware test | **Delete** | It can pass if production middleware is removed. Replace with the real `createApp` path. |
| `app.test.ts` pure `sanitizedLogPath` assertion | **Delete after replacement** | Actual structured request-log test proves token redaction at the emitted-log boundary. |
| `activate-routes.test.ts` approval test that POSTs `started.userCode` | **Rewrite** | Parse and submit the actual rendered successful controls, CSRF, cookie, Origin, and Referer. |
| `activate-routes.test.ts` separate deny test using reconstructed code | **Merge/rewrite** | Table-drive Approve/Deny through the generated form; keep distinct durable-state assertions. |
| `device-auth/routes.test.ts` injected max=1 per-source-only limiter test | **Delete after replacement** | Two route-level scenarios independently prove per-source and global ceilings; `attempt-limiter.test.ts` retains pure window/key behavior. |
| `device-auth/routes.test.ts` durable 30-pending limit scenario | **Retain and rename/comment** | It protects DB-backed pending-row limits, not the in-memory route limiter. Avoid claiming otherwise. |
| `setup-guide.test.ts` distinct-ID aggregation test | **Rewrite/strengthen** | Use duplicate per-topic IDs in pass-then-fail order; retain secret-redaction assertion only if it protects a distinct concern. |
| `client/http.test.ts` redirect-init + synthetic TypeError combined test | **Delete/replace** | Real local 302 test proves redirect target is never requested/API key never forwarded; separate small network-error mapping case if still distinct. |
| `contacts.test.ts` one-off typo test | **Move/merge** | New centralized CLI option-grammar table covers unknown, duplicate, and wrong-subcommand options before auth/network. |
| `startup-migration-check.test.ts` helper tests | **Retain, reclassify** | They protect helper semantics only; add real service and worker subprocess acceptance rather than calling them entrypoint coverage. |
| `config.test.ts` repetitive numeric-bound cases | **Consolidate** | Table-drive shared spec acceptance/failure across readiness and worker config; keep lease-budget invariants separate. |
| Strong DB, idempotency race, CLI stdout, queue, SNS crypto/cache, lifecycle, migration tests | **Retain by individual stable key** | They already exercise meaningful real boundaries and distinct failure modes; each still gets an audit row. |
| Existing SES operations authorization matrix in `ses/routes.test.ts` | **Retain** | It already proves representative 401/403/200 behavior through the mounted middleware; do not duplicate per endpoint family. |
| Existing signed SNS, SES abort, stale-lease, SES row-shape, unsubscribe body-cap, lifecycle tests | **Retain** | These resolved older critical-review gaps before this draft; list them explicitly in audit/traceability to prevent redundant rewrites. |

The suite-wide audit may identify more candidates, but it must not delete tests merely to reduce count.

---

## Phase 1 — Restore browser activation and canonical origin (B4, B1)

### Implementation

**Files:**

- `apps/service/src/device-auth/service.ts`
- `apps/service/src/device-auth/activate-routes.ts`
- `apps/service/src/device-auth/activate-routes.test.ts`

1. Split `DeviceAuthorizationActivation` into distinct transient concepts:
   - actionable normalized `userCode`, derived from the caller-supplied code only after a successful hash lookup;
   - masked `userCodePreview`, read from `user_code_preview` for display.
2. Keep DB storage unchanged: hash + masked preview only. Never restore plaintext storage.
3. Render the masked preview in visible text, but the actionable normalized code in the hidden `name="code"` input.
4. Compute one effective origin: `publicOrigin ?? request origin`, normalized to `.origin`. Pass that exact `effectiveOrigin` into `renderActivationForm`; do not pass a full URL and re-derive it there. Use it for displayed Instance and same-origin POST validation; verification URI behavior remains wired through routes.
5. Preserve HTML escaping, CSRF cookie, Origin/Referer checks, and no-store/CSP headers.

### High-value tests

- Add pinned root dev dependencies `jsdom@29.1.1` and compatible TypeScript types; update `pnpm-lock.yaml`.
- Rewrite activation submission with a standards-capable DOM/form harness:
  1. start authorization through the real route and GET the returned verification URL;
  2. load the returned HTML into jsdom at the real page URL;
  3. locate the actual form and selected Approve/Deny submit button;
  4. derive the request target from `form.action`, method from `form.method`, and successful controls via `new window.FormData(form, submitter)`;
  5. serialize those controls and send with the actual cookie, Origin, and Referer.
- Keep `approve` and `deny` as two collected cases (shared helper/setup is fine) because they protect distinct durable transitions. Assert the correct timestamp and the opposite timestamp remains null.
- Assert actionable code is not visible text, visible preview is masked, submitted hidden code is normalized/actionable, and DB stores only hash/preview.
- Add proxy case: internal request URL + configured HTTPS public origin; page shows only the public instance.
- Keep CSRF, missing Origin/Referer, bad Origin, and malformed Referer cases separate because they protect distinct attack classes.
- Do not use regex extraction plus reconstructed `URLSearchParams`; that would recreate the false-confidence class being removed.

### Fail-before proof

Temporarily run the rewritten form-submission test against the current masked-hidden-input behavior and record that it returns “Activation failed”; restore before implementation.

### Manual browser acceptance

Use `agent-browser` against an authenticated test-runtime server:

- open the generated verification URL;
- inspect displayed public origin/masked preview;
- click Approve and verify success;
- repeat with Deny;
- close browser and stop the temporary server.

---

## Phase 2 — Reestablish no-resend and audit invariants (D3, D4)

### D3 implementation: unexpected post-dispatch failures

**Files:**

- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/sending/process-delivery.test.ts`

After `transport.send` is invoked:

- typed `permanent`, `ambiguous`, and `retryable` adapter outcomes retain their explicit contract;
- every **untyped/defect** failure is treated as ambiguous, never retryable;
- persist a fixed sanitized message such as `Unexpected email transport failure after dispatch.`;
- after successful ambiguity recording, return a terminal handled outcome so the queue job completes and cannot resend;
- if ambiguity persistence itself raises `DatabaseError`, propagate it to the runner; D4 is the final recovery path.

Do not persist arbitrary defect messages or properties.

### D4 implementation: immediate dead transition

**Files:**

- `apps/service/src/queue/runner.ts`
- `apps/service/src/queue/runner.test.ts`
- existing helper behavior in `apps/service/src/sending/attempts.ts` (change only if needed)

Required ordering when processor failure exhausts queue attempts:

1. `failSendDeliveryJob` durably transitions the owned job to `dead`.
2. `markReleasedDeadJobDeliveryAmbiguous` finalizes the latest `started` attempt while delivery is still `sending`.
3. The helper marks queued/sending delivery `failed` without reversing an existing terminal state.
4. Refresh mailing state.

Replace the immediate branch's weaker `markDeliveryFailedForDeadJob` call. Preserve stale-worker fencing and `JobNotLeasedError` behavior.

### High-value tests

1. **Unexpected transport defect:** custom `EmailTransport` records one dispatch then `Effect.die(...)`.
   - attempt `ambiguous` + finished;
   - delivery `failed`;
   - job terminal, never queued;
   - second worker cycle performs no second dispatch;
   - defect sentinel absent from persisted error/logs.
2. **Final-attempt outcome-write failure:**
   - `max_attempts=1`;
   - transport succeeds once;
   - DB wrapper fails `sending:attempt:succeed` once, then allows reconciliation;
   - same cycle ends job `dead`, delivery `failed`, attempt `ambiguous`, mailing terminal;
   - next cycle is idempotent and sends nothing.
3. Retain existing pre-dispatch DB recovery, typed retryable/ambiguous, orphan sweep, and late MessageId tests; rename comments so sweeps do not falsely claim immediate-branch coverage.

### Fail-before proof

- Restore retryable handling for the untyped defect and show the new test queues/re-dispatches.
- Restore the weak immediate dead helper and show the new test leaves `status='started'`.

---

## Phase 3 — Prove real Bun/runtime protections (A2, A3, F3, B2)

### Shared subprocess harness

**Files:**

- `apps/service/src/main.integration.test.ts`
- optionally new `apps/service/src/testing/service-process.ts` if reuse stays focused
- `.github/workflows/ci.yml`

Refactor only enough test setup to provide:

- ephemeral loopback port allocation;
- temp DB/env construction;
- stdout/stderr capture;
- health/listening wait;
- bounded process-exit wait;
- `finally` cleanup with SIGTERM then SIGKILL fallback;
- no orphan process or temp directory.

Keep tests sequential if they share runtime resources. Attach child exit/error listeners before readiness checks, capture bounded stdout/stderr, retry cleanly on `EADDRINUSE` or use a child-reported bound port, and SIGKILL in `finally` if needed. Pin CI Bun to the validated runtime version instead of `latest` so boundary behavior is reproducible; update intentionally when runtime validation is rerun.

### A2: body cap

In the real `bun src/main.ts` process:

- POST `2 MiB + 1 byte` to `/cli/activate` with matching Origin and form content type;
- assert the observed Bun boundary rejection (prefer exact 413 on pinned Bun);
- send a just-under-cap control that reaches ordinary route validation rather than being rejected at the server boundary;
- assert `/health` remains healthy afterward.

### A3: in-flight drain

Use a partial-body Node `http.request` to `/cli/activate`:

1. connect and write only part of a declared form body so `formData()` is demonstrably pending;
2. send SIGTERM after socket connection/write acknowledgement, never after a sleep alone;
3. finish the request body;
4. record monotonic event order `connected < SIGTERM < request complete < process exit`;
5. assert the full response completes, then process exits 0, with no closed-DB/runtime error;
6. require request completion less than 10 seconds after SIGTERM so the forced-stop path was not reached; require both request and exit within a separate overall test deadline.

This proves graceful `server.stop()`/dispose ordering without adding a production test route. Never require process exit after the force-stop threshold.

### F3: stale-schema entrypoints

Against a DB migrated only through 0007 (or latest rolled down once):

- spawn `bun src/main.ts`;
- spawn `bun src/sending/worker-main.ts once` with valid non-network sending config;
- assert each exits nonzero without serving/running, identifies pending migration, and prints `db:migrate` guidance;
- service must not print its listening line; worker must not print a cycle result.

Retain helper tests for pending/missing/checksum logic, but do not count them as composition-root acceptance.

### B2: independent rate-limit layers

**Files:** `apps/service/src/device-auth/routes.test.ts`.

- Per-source case: permissive global limiter + small injected per-source limit; same trusted last XFF hop reaches 429 while another source still succeeds.
- Global case: permissive per-source limiter + small injected global limit; distinct last-hop sources succeed below the ceiling and the next request receives the coarse route-level rate-limit envelope.
- Assert the message distinguishes route limiting from durable pending-row limiting.
- Retain the durable 5/fingerprint and 30/global pending-row test under a clear name.
- Delete the old max=1 per-source-only wiring test after replacements pass.
- Document that the in-memory global limiter is per-process and resets on restart; do not claim deployment-wide coordination.

---

## Phase 4 — Complete structured logging and shared worker config (A4, A6)

### A4: structured, correlated, sanitized errors

**Files:**

- `apps/service/src/http/respond.ts`
- `apps/service/src/app.ts`
- `apps/service/src/auth/middleware.ts`
- `apps/service/src/device-auth/activate-routes.ts`
- `apps/service/src/testing/layers.ts`
- `apps/service/src/{app.test.ts,http/respond.test.ts}`
- affected auth/activation tests

1. Add a pure `safeLogFields(cause, requestMeta)` mapper that returns only whitelisted fields.
2. Change `logCause` into an `Effect.Effect<void>` that calls `Effect.logError` and is consumed by `JsonLoggerLive`; it must not import or invoke a runtime itself.
3. Define safe request metadata containing only method and sanitized pathname—no query, body, headers, params, token, cookie, or API key.
4. Emit structured fields such as event, method, path, failure tag/defect type, and known safe DB/Auth operation. For defects, never log message, stack, or arbitrary properties.
5. Migrate signatures explicitly:
   - make Hono `respondUnexpectedError(context, runtime, error)` async and run the log Effect through `AppRuntime`;
   - inside `runRoute`/HTML/webhook programs, yield the log Effect before returning mapped 500s;
   - for failed exits outside the program, run exactly one log Effect through the existing runtime;
   - migrate auth middleware and activation handling through their existing runtime/effect boundaries.
6. Guarantee exactly one error event per failure path; a mapped error must not be logged again by the final-exit backstop.
7. Add a test logger layer using Effect v4 `Logger.make`/`Logger.layer` and capture emitted options without snapshotting full formatted JSON.

**Test rewrite:**

- Delete the mini-Hono sanitized-error test and cloned access middleware test.
- Add a narrow optional `registerBeforeFallback(app)` callback to `createApp` (test use only) so a throwing probe is mounted inside the actual production middleware/onError composition before not-found handling; do not append a route after composition or build another mini-Hono.
- Assert:
  - JSON `internal_error` 500;
  - one structured error event with method, sanitized route, defect type;
  - access-completed event with status 500;
  - sentinel defect message, unsubscribe token, query, headers, and body absent.
- Update `runRoute` infrastructure/defect tests to capture Effect logs rather than spying on `console.error`; retain status/code mapping tables.
- Reuse the same logger sink for one real SES notification and one worker cycle. Assert allowed high-level fields/counters, and absence of raw SNS `Message`, recipient/email, subject/body/vars, unsubscribe token, API key, cookie, and sentinel payloads. Do not snapshot formatted JSON.

### A6: one numeric spec, two error policies

**Files:**

- `apps/service/src/config.ts`
- `apps/service/src/config.test.ts`
- `apps/service/src/sending/worker-main.ts`
- all typed `SendingConfig` fixtures

1. Define shared specs for request timeout, batch size, lease seconds, and poll milliseconds: env name, default, min/max, and message.
2. Consume those specs through:
   - readiness parser: collect issue + fallback;
   - sending parser: fail startup.
3. Preserve the intentional difference in error policy; deduplicate bounds/defaults, not semantics.
4. Add poll milliseconds to `SendingConfig`; remove direct `process.env.NUSEND_SEND_WORKER_POLL_MS` parsing from `worker-main.ts`.
5. Continue using the single lease-budget predicate/message.

**Tests:**

- Consolidate repetitive integer tests into a table across all four specs.
- Assert both config paths agree on defaults, accepted boundary values, and invalid bounds while retaining fallback-vs-fail behavior.
- Keep lease-budget tests separate because they protect a cross-field invariant.
- Typecheck must expose every stale fixture.

---

## Phase 5 — Finish CLI composition/grammar and contract cleanup (G2, G3, H4, H5, H6)

### G2: production env timeout

**Files:**

- `apps/cli/src/client/http.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/commands/login.ts`
- CLI tests

1. Add one dependency-neutral lazy `NUSEND_HTTP_TIMEOUT_MS` parser/factory used by both authenticated and login HTTP clients. It returns a number or parse result and must not import command-layer `UsageError` into `client/http.ts`.
2. Map parse failure to `UsageError` in CLI composition. Default 30,000 ms; accept only a decimal safe integer >=1; invalid values fail exit 2 before network activity.
3. Parse only when an HTTP client is needed so unrelated local commands such as `config repair-permissions` are not broken by an unrelated env value.
4. Preserve `CliHttpError(0, "timeout", ...)` output.

**Tests:**

- Keep the low-level abort-aware hung-fetch timeout mapping test.
- Add `runMain` composition coverage for one authenticated command and login, proving the env value reaches both constructors. Use an abort-aware fake or real local hung server; a fetch mock that ignores `AbortSignal` is invalid timeout evidence.
- Invalid values must exit 2 with no fetch.

### G3: centralized per-subcommand grammar

**Files:**

- `apps/cli/src/main.ts`
- `apps/cli/src/commands/context.ts` or new `commands/options.ts`
- command modules and tests

1. Create one command/subcommand option registry declaring allowed options, value/boolean shape, and repeatability.
2. Run one tokenizer/grammar pass over the original argv after equals-syntax expansion. Either parse globals through the same registry or make `parseGlobalOptions` consume the registry's cardinality metadata; a post-command registry cannot detect already-consumed global duplicates.
3. Only `--permission` is repeatable; reject duplicate global/local single-value and boolean options.
4. Complete grammar validation before config loading, credential lookup, or API construction.
5. Remove family-wide `assertKnownOptions` calls so a second allowlist cannot drift.
6. Include global options (`--profile`, `--base-url`, `--json`) and preserve special help/version behavior:
   - one `--help`/`-h` anywhere after global parsing prints the current global help, including command-scoped use such as `contacts list --help`;
   - one `--version`/`-v` is valid only as the first non-global token and prints the version;
   - these are no-value, nonrepeatable options; duplicate/mixed aliases are usage errors;
   - `--version` after a command remains invalid.
7. Include login/logout/config/whoami behavior.

**Required scopes:**

- contacts list: email/limit/offset; get/create/update/delete: none;
- mailings list: limit/offset; get: none;
- api-keys list: limit/offset; create: name/expires-at/no-expiry/permission; revoke/rotate: none;
- login: name/permission; logout: revoke; `config repair-permissions` and whoami: none.

**Test rewrite:**

- Move the one-off contacts typo test into a centralized table.
- Cover unknown option, duplicate option, wrong-subcommand option, duplicate boolean, and repeated permission success.
- Every invalid case asserts exit 2 and no credential/network/API work.

### G4 test-quality replacement

Although redirect blocking code exists, replace the false-confidence init-only test:

- start a local HTTP server returning 302 to a second local server;
- request through the real client with an API key;
- assert the client reports `network_error`/blocked redirect;
- assert the target server receives no request and therefore no key;
- keep a separate small generic network-rejection mapping case only if it protects a distinct error contract.

### H4: contract-coupled API-key types

**Files:** `apps/service/src/api-keys/service.ts`.

- Alias/use contract `ApiKey` and `ApiKeyWithSecret` for exported service returns.
- Keep domain-only verification/page types local.
- Use `satisfies` at mapping sites.
- Validate with typecheck; do not add runtime shape tests for type aliases.

### H5: remove dead schema export

**Files:** `packages/api-contract/src/pagination.ts` and generated dist via build.

- Make `PaginationSchema` module-private while retaining exported `Pagination` type and `PaginationMetaSchema`.
- Repo-wide grep before/after; rebuild contract then CLI from a clean contract `dist`.
- Record this internal package surface change in compatibility notes.

### H6: make documented service tests real

**Files:**

- `apps/service/package.json`
- `PROJECT.md` only if command wording changes

Add this exact service script: `"test": "vitest run --root ../.. --dir src"`. From the package cwd, forwarded focused filters are `src/<path>.test.ts`. Validate:

- `pnpm --filter @nusend/service test` runs only service tests;
- `pnpm --filter @nusend/service test -- src/config.test.ts` selects only that file;
- documented command exactly matches the real script.

---

## Phase 6 — Close SES and idempotency frozen contracts (E3, Phase 9 gaps)

### E3 duplicate per-topic readiness

**Files:**

- `apps/service/src/ses/setup-guide.test.ts`
- optionally `apps/service/src/aws/readiness.test.ts` for one higher-level scenario

- Rewrite aggregation coverage with duplicate `sns.subscription.webhook` IDs ordered pass then error; assert the setup step and guide are error.
- Add `ok + warning` only if warning precedence is a separate invariant.
- Prefer one higher-level two-topic fake-AWS test if needed to prove production emits repeated checks; do not duplicate all setup-guide logic.

### Multi-topic webhook ingestion

**File:** `apps/service/src/ses/webhook-routes.test.ts`.

- Configure two allowlisted feedback ARNs.
- POST one unique Notification from each.
- Assert two notification/event rows and both topic ARNs.
- Non-allowlisted third topic remains 403 without verifier/cert work.

### Route-level UnsubscribeConfirmation

**File:** `apps/service/src/ses/webhook-routes.test.ts`.

- Send verified allowlisted `UnsubscribeConfirmation` through the HTTP route.
- Assert 204, one audit notification, zero SES events, zero confirmer calls, and duplicate idempotency.
- Keep verifier canonicalization tests; route coverage protects switch/wiring/persistence and is not a replacement for crypto tests.

### Equivalent scheduledAt idempotency

**File:** `apps/service/src/mailings/routes.test.ts`.

- Same key/body, first schedule `...00Z`, replay `...00.000Z`.
- Assert the route's actual replay contract (currently 201 with the same response body; include any replay header/metadata only if the route intentionally adds one), one mailing/job/idempotency row, and canonical stored time.
- Add a one-millisecond-different request asserting idempotency conflict.
- Keep the existing vars-key-order test because it protects a distinct canonicalization dimension.

### Already-resolved older test-review gaps

- Retain the existing representative SES operations auth matrix in `apps/service/src/ses/routes.test.ts`; it already covers unauthenticated, wrong-scope, session, and operations-read principals through the mounted middleware. Do not add one table per endpoint.
- Retain current signed SNS, SES abort, stale-lease, SES row-shape, unsubscribe body-cap, and full lifecycle tests as individually audited high-value keys.

### Test-quality rule

Do not add direct helper tests that feed noncanonical `CreateMailingInput` past the route decoder; the public invariant is decoder-before-hash ordering.

---

## Phase 7 — Harden rollback detection, migration evidence, docs, and CI (F5 and completion gaps)

### F5 operator output

**Files:**

- `apps/service/src/db/migrate.ts`
- `apps/service/src/db/migrate.integration.test.ts`
- optional new `apps/service/src/db/destructive-migration.ts` + focused test

1. Always print a sorted/deduplicated destructive table inventory **before** refusal or execution.
2. Refusal remains nonzero and preserves all tables.
3. Confirmed rollback prints the same inventory before `Rolled back migration...` and removes every named table.
4. Harden table detection only within the trusted migration use case: skip comments/string literals; recognize SQLite `DROP TABLE [IF EXISTS] [schema.]identifier` with ordinary/double/backtick/bracket quoting; return sorted/deduplicated names; conservatively reject malformed recognized statements. Do not create reusable/general SQL parser infrastructure.

**Tests:**

- Current real 0005 refused/confirmed integration with output-order and all-table assertions.
- Focused detector cases for comments, string literals, `IF EXISTS`, quoted/bracketed identifiers, and schema qualification.
- Immediately after the full reapply and before injecting the synthetic missing migration, assert 0008 output and recreation of all three indexes; after rollback, assert all three are absent, including `deliveries_created_id_idx`.

### Documentation/compatibility

**File:** `PROJECT.md`.

Add a clear upgrade/compatibility section covering:

- B5 scoped revoke subset may now return 403;
- G3 unknown, wrong-subcommand, and duplicate nonrepeatable options exit 2; permission remains repeatable;
- G4 redirects are rejected; configure canonical URL;
- G2 timeout override and validation;
- F5 destructive rollback confirmation + printed inventory;
- 0008 unique `jobs(delivery_id)` can fail on legacy duplicates and must trigger inspection, not silent deletion;
- H5 removed internal schema export if relevant to consumers;
- B2 limiter is process-local;
- migration 0004 intentionally uses reset-clean semantics for legacy `ses_feedback_*` data. Document that applying it discards those legacy rows and operators needing history must export before migration; do not add a misleading preservation test unless product requirements change.

Document the accepted operations asymmetry precisely:

- `/api/operations/deliveries` is a filtered, limit-only operational view and does not promise `offset`;
- `/api/operations/ses/events` supports offset pagination;
- unknown delivery query params are not a pagination contract.

### CI evidence

- Pin CI Bun to the runtime used for the Bun boundary tests.
- Keep Node/pnpm pins and frozen install.
- **Implementer-local gate:** workflow syntax/static review plus local `pnpm check`; this can complete without source-control actions.
- **External operator landing gate:** when an ordinary hosted trigger exists, run the workflow against the exact reviewed SHA and record run URL/ID, head SHA, event, job conclusion, and date.
- If hosted execution is unavailable, external status remains **unvalidated**; static YAML review is not success, but it is not an implicit implementation-owned commit/push/PR step.

### Explicit older-review decisions

- Simulator entrypoint subprocess smoke remains an **accepted omission**: simulator core/route behavior is tested, no current implementation-review regression targets its top-level parser, and adding a fake-process network mode would be lower value than the required boundaries above.
- Migration 0004 uses the documented reset-clean policy above; no legacy-row preservation test is added unless preservation becomes a product requirement.

---

## Phase 8 — Final suite-wide pruning and coverage proof

1. Collect baseline and final JSON inventories, e.g. `pnpm test -- --reporter=json --outputFile=<progress path>`, and complete `.progress/fix-findings-test-quality-audit.md` for every stable collected key plus file-level harness notes. Reconcile every added/deleted/renamed key; do not hard-code the pre-change 71-file count.
2. Apply every evidence-backed rewrite/merge/delete disposition; do not leave “review later” rows or blanket-retain categories.
3. Search for weak patterns:
   - local Hono/middleware clones;
   - tests reading rendered output but submitting reconstructed inputs;
   - direct helper tests mislabeled as entrypoint acceptance;
   - full snapshots/SQL-text/call-order assertions;
   - duplicated happy paths with no distinct failure mode;
   - mocks that cannot express the failure class they claim to test.
4. For each important invariant, ensure at least one real-boundary test:

| Invariant | Required evidence |
|---|---|
| Browser form works | DOM-derived automated form submission + agent-browser click |
| No resend after possible dispatch | defect-after-dispatch test + no second call |
| Dead job has no started attempt | final-attempt outcome-write failure state assertions |
| Body cap enforced | real Bun over/under boundary |
| Shutdown drains | partial in-flight HTTP request + SIGTERM |
| Both entrypoints reject stale DB | real service and worker subprocess exits |
| Structured logs are safe/correlated | real createApp/runRoute with captured Effect logger |
| Per-source/global rate limits both wired | independent route tests |
| CLI timeout/grammar composed | runMain tests, not constructor-only tests |
| All configured topics participate | duplicate readiness + two-topic webhook |
| Confirmation route branches work | Subscription + Unsubscribe route tests |
| Idempotency normalizes wire dates | route-level equivalent/different schedule tests |
| Destructive rollback is explicit | refused/confirmed real migration output and state |
| CI gate runs | hosted run tied to reviewed SHA |

5. Run selective mutation/fail-before checks for B4, D3, D4, A2, E3, G2, G3, and F5. For each record: exact temporary mutation, focused command, expected failing stable key/assertion, observed nonzero result, restoration command/check, and post-restore pass. Examples: mask the hidden code; restore retryable untyped dispatch handling; restore weak dead helper; remove `maxRequestBodySize`; restore `find`; bypass timeout composition/grammar registry; suppress rollback inventory. After each restoration compare a path-scoped diff and run `git diff --check` so no temporary mutation survives.
6. Do not add a blanket line/branch threshold. Use optional coverage output only as a discovery aid, never as the definition of done.

## Delegation and file ownership

### Must remain sequential / one writer

- Phase 1 activation (`service.ts`, `activate-routes.ts`, shared tests).
- Phase 2 sending state (`process-delivery.ts`, `runner.ts`, attempts/runner tests).
- Phase 4 logging because `respond.ts` call sites span app/auth/activation.
- Phase 5 CLI grammar because main/context/all command files share parsing behavior.
- Final test pruning and progress traceability synthesis.

### Safe read-only or isolated validation parallelism

- Bun lifecycle/startup reviewer.
- Sending ambiguity/state reviewer.
- CLI parser/composition reviewer.
- SES/migration/docs reviewer.
- Test-quality reviewer comparing the completed audit manifest to the diff.

Do not run parallel writers in the dirty active worktree. If isolated worktrees are unavailable because the base is dirty, use one writer and parallel read-only reviewers.

## File-operation manifest

| Path | Operation |
|---|---|
| `.progress/fix-findings-test-quality-audit.md` | Create audit/traceability evidence |
| root `package.json`, `pnpm-lock.yaml` | Add pinned jsdom test dependency/types for browser-form semantics; update lockfile |
| `apps/service/src/device-auth/{service.ts,activate-routes.ts,activate-routes.test.ts}` | Rewrite |
| `apps/service/src/sending/{process-delivery.ts,process-delivery.test.ts}` | Rewrite |
| `apps/service/src/queue/{runner.ts,runner.test.ts}` | Rewrite |
| `apps/service/src/main.integration.test.ts` | Rewrite/extend shared Bun scenarios |
| `apps/service/src/http/respond.ts`, `app.ts`, `auth/middleware.ts` | Rewrite structured logging |
| `apps/service/src/testing/layers.ts` | Extend with capturable logger only |
| `apps/service/src/{app.test.ts,http/respond.test.ts}` | Rewrite; delete cloned/standalone weak cases |
| `apps/service/src/config.ts`, `config.test.ts`, `sending/worker-main.ts` | Rewrite shared config specs |
| `apps/cli/src/{main.ts,client/http.ts,commands/context.ts,commands/login.ts}` | Rewrite composition/grammar |
| `apps/cli/src/commands/options.ts` | Create only if it becomes the canonical grammar owner |
| CLI command/client tests | Rewrite/merge around real grammar/composition/redirect behavior |
| `apps/service/src/api-keys/service.ts` | Rewrite types only |
| `packages/api-contract/src/pagination.ts` | Rewrite export visibility |
| `apps/service/package.json` | Add real service test script |
| SES/readiness/mailings tests listed in Phase 6 | Extend/rewrite |
| `apps/service/src/db/migrate.ts`, migration tests | Rewrite/extend |
| `apps/service/src/db/destructive-migration.ts` | Create only if needed to isolate safe detector |
| `.github/workflows/ci.yml` | Pin Bun runtime |
| `PROJECT.md` | Rewrite compatibility/scripts/asymmetry notes |
| No DB migration | Schema remains unchanged |

## Validation sequence

After each phase, run narrow owning suites with explicit timeouts. The service package script runs from `apps/service`, so forwarded paths are package-relative `src/...`:

```sh
pnpm --filter @nusend/service test -- src/<affected>.test.ts --testTimeout=30000
pnpm --filter @nusend/cli test -- <affected cli test paths>
pnpm --filter @nusend/api-contract build
pnpm --filter @nusend/cli build
pnpm typecheck
```

Runtime/migration phases:

```sh
pnpm --filter @nusend/service test -- src/main.integration.test.ts --testTimeout=60000
pnpm --filter @nusend/service test -- src/db/migrate.integration.test.ts --testTimeout=30000
```

Final local gate:

```sh
pnpm --filter @nusend/service test
pnpm --filter @nusend/cli test
pnpm check
git diff --check
```

Manual:

- agent-browser Approve and Deny from generated forms;
- concurrent mailing/contact smoke against the real Bun service to retain confidence in the Phase 1 DB serialization without adding a weaker duplicate automated test;
- confirm all temporary servers/workers/browsers are stopped.

Hosted external landing gate:

- CI `check` job succeeds for the exact reviewed SHA when the operator's normal hosted trigger is available; record evidence. Until then mark only this external gate unvalidated.

## Risks and mitigations

- **Plaintext code leakage while fixing B4:** keep plaintext transient and only in hidden control derived from caller input; DB remains hash + preview; logs must never contain query/code.
- **Duplicate-send regression:** fixed message and terminal ambiguity for every untyped post-dispatch failure; assert no second transport call.
- **Attempt finalization ordering:** ambiguity helper must run before delivery becomes failed because SQL guards require `sending`.
- **Bun test flakiness:** pin runtime, allocate ports safely, use readiness/socket signals rather than sleeps, bound/kill all subprocesses.
- **Logging refactor leaks sensitive values:** whitelist fields; capture and test absence of sentinels; no raw cause/message/stack.
- **Parser drift:** one option registry, validated before auth/network; command handlers do not maintain separate allowlists.
- **Over-testing:** audit requires a distinct invariant/failure mode for every retained or added test; no raw coverage target.
- **Public export compatibility:** repo is private, but document H5 change and rebuild all consumers.
- **CI evidence unavailable:** do not claim completion; record explicit external checkpoint.

## Traceability matrix

| Review finding | Plan phase |
|---|---|
| High B4 masked hidden code | 1 |
| Medium D3 post-dispatch defect retries | 2 |
| Medium D4 dead-letter leaves started attempt | 2 |
| Medium A2 body-cap acceptance gap | 3 |
| Medium E3 duplicate-topic regression gap | 6 |
| Low B1 displayed origin | 1 |
| Low A4 unstructured/un-correlated logs | 4 |
| Low A6 duplicated config/poll parsing | 4 |
| Low G2 env override missing | 5 |
| Low G3 duplicate/per-subcommand options | 5 |
| Low H4 API-key contract types | 5 |
| Low H5 dead PaginationSchema export | 5 |
| Low F5 confirmed rollback output | 7 |
| Compatibility notes absent | 7 |
| A3 in-flight drain evidence | 3 |
| F3 real service/worker startup evidence | 3 |
| Phase 9 scheduledAt / multi-topic / Unsubscribe gaps | 6 |
| B2 global ceiling test | 3 |
| Operations offset decision undocumented | 7 |
| False-confidence/low-value test removal | 0 + 8, with replacements in 1–7 |
| Planning-time service test script mismatch | 5 |
| Planning-time F5 detector/index reapply gaps | 7 |
| Hosted CI execution evidence | 7–8 |

No finding from `.reviews/fix-all-review-findings-implementation-review.md` is deferred. Older optional test-review recommendations are explicitly classified above rather than silently treated as current blockers.

## Definition of Done

### Implementer-local completion

- Browser Approve and Deny succeed using exactly the rendered form controls; DB preview remains masked and displayed instance is canonical public origin.
- No untyped post-dispatch failure can queue a resend.
- No dead job can retain a `started` attempt after same-cycle reconciliation.
- Real Bun tests prove over-limit rejection and in-flight SIGTERM drain.
- Real service and worker entrypoints reject stale schemas with actionable output.
- Structured Effect logs contain safe method/path/type correlation and no sensitive sentinel.
- Worker/readiness numeric config shares one bounds/default specification, including poll interval.
- Both CLI client paths honor validated timeout env; command grammar rejects unknown, duplicate, and wrong-subcommand flags before auth/network.
- API-key return types compile against the contract; dead pagination export is removed.
- Exact multi-topic, route-level UnsubscribeConfirmation, and wire-date idempotency contracts are tested.
- Confirmed destructive rollback prints inventory before execution; detector and index lifecycle tests are complete.
- `PROJECT.md` accurately documents scripts, compatibility, limiter scope, migration risk, and operations pagination asymmetry.
- Baseline/final collected test inventories reconcile; every final stable key has an audit disposition; every deleted key names a replacement or accepted removal; all known false-confidence tests are deleted or rewritten.
- Focused tests, service/CLI tests, `pnpm check`, builds, typecheck, `git diff --check`, browser checks, and local runtime checks pass.
- Final fresh-context reviewers find no material correctness, security, state-machine, runtime, or test-quality gaps.

### External operator landing gate

- Hosted CI succeeds for the exact reviewed SHA and its run evidence is recorded. Until an external trigger is available, this gate is explicitly `unvalidated` and must not be reported as passed.

---

# Implementation Progress

- **Plan:** `.plans/fix-implementation-review-findings-and-test-quality.md`
- **Overall status:** `Superseded / partial after final review` (historical implementation evidence retained; hosted CI remains external/unvalidated)
- **Last updated:** `2026-07-10T21:41:59Z`
- **Supersession:** The final [implementation review](../.reviews/fix-implementation-review-findings-and-test-quality-implementation-review.md) found the completion claim unsupported; remediation continues under [Fix Final Review Findings and Rebuild Test Quality from First Principles](./fix-final-review-findings-and-rebuild-test-audit.md).
- **Completion rule:** `Complete` is allowed only when every actionable plan requirement is traceably covered by a `Verified` row or explicitly `Descoped` with user approval. The separately identified hosted-CI operator gate remains explicitly unvalidated unless exact reviewed-SHA evidence becomes available.

## Plan coverage inventory

| ID | Original plan reference / requirement | Dependencies | Status | Owner | Verification | Evidence / notes |
|---|---|---|---|---|---|---|
| T00 | Test-quality standard + Phase 8.1: collect baseline Vitest JSON and create per-key audit | — | Verified | Main | Baseline JSON command; manifest key count reconciliation | 71 files / 437 cases passed; audit contains 71 file rows and 437 explicit stable-key dispositions. |
| T01 | Phase 1.1–3: transient actionable code vs masked preview; unchanged masked DB storage; hidden actionable form control | T03 | Verified | Main | Activation route focused tests + DB assertions | `service.ts` now returns transient normalized code + stored preview; 12 activation tests pass. |
| T02 | Phase 1.4–5: one canonical effective origin; preserve escaping/CSRF/origin/no-store/CSP behavior | T01 | Verified | Main | Public-origin, CSRF, malformed/missing origin tests | Effective origin normalized once; four distinct attack-class cases plus proxy rendering pass. |
| T03 | Phase 1 tests: pin jsdom/types and rewrite Approve/Deny with DOM-derived successful controls | T00 | Verified | Main | Two collected route cases; fail-before mutation evidence | Added jsdom 29.1.1/@types 28.0.3. Pre-fix run failed 3 cases (public origin + masked hidden code twice); post-fix 12/12 pass. |
| T04 | Phase 1 manual acceptance: real-browser Approve and Deny, public origin/preview, cleanup | T03 | Verified | Main | `agent-browser` runtime smoke | agent-browser 0.31.1 clicked rendered Approve and Deny successfully; public origin/masked previews inspected; browser/server/temp files closed and port verified free. |
| T05 | Phase 2 D3: untyped post-dispatch defects become sanitized terminal ambiguity; persistence failure propagates | T00 | Verified | Main | Focused sending tests | Untyped dispatch defects use fixed ambiguity message and terminal handled return; typed outcomes/pre-dispatch recovery preserved. |
| T06 | Phase 2 D3 tests + fail-before: one dispatch, finished ambiguous attempt, terminal job/delivery, no sentinel/no resend | T05 | Verified | Main | Focused test and temporary mutation/restoration | Pre-fix case re-dispatched and failed expected terminal count; post-fix full process suite 25/25 passes with one dispatch and no sentinel persistence. |
| T07 | Phase 2 D4: dead transition then attempt ambiguity reconciliation then mailing refresh | T05 | Verified | Main | Runner focused tests | Immediate dead branch now calls ambiguity reconciliation after durable dead transition; fencing/stale lease behavior preserved by full runner suite. |
| T08 | Phase 2 D4 tests + fail-before: final outcome-write failure reconciles in same cycle and is idempotent | T07 | Verified | Main | Focused test and temporary mutation/restoration | Pre-fix left `started`/unfinished; post-fix two owning suites pass 34/34, second cycle claims zero and transport sends once. |
| T09 | Phase 3 shared subprocess harness: ports/temp env/capture/readiness/exit/cleanup/retry | T00 | Verified | Main | Main integration tests, orphan/temp cleanup checks | Ephemeral ports, temp env/DB, early exit/error capture, bounded waits, SIGTERM/SIGKILL cleanup; sequential suite 5/5. |
| T10 | Phase 3 A2: real Bun over/under 2 MiB body-cap and post-check health | T09 | Verified | Main | Bun subprocess acceptance + mutation evidence | Pinned Bun returns exact 413 over cap; under cap reaches 403 route validation; health remains OK. Mutation evidence remains tracked in T37. |
| T11 | Phase 3 A3: partial request + SIGTERM proves drain ordering and bounded clean exit | T09 | Verified | Main | Bun subprocess acceptance | Socket-connect/write acknowledgement drives signal; response completes before clean exit and under 10s; no closed-DB output. |
| T12 | Phase 3 F3: real service and worker stale-schema entrypoints reject with migration guidance | T09 | Verified | Main | Two subprocess acceptance cases | Both real entrypoints exit nonzero with pending migration + db:migrate; no listening/cycle output. |
| T13 | Phase 3 B2: independent per-source/global route limiter cases; retain durable pending-row test; document process-local scope | T00 | Verified | Main | Device-auth route focused tests | Replaced max=1 case with independent ceilings; 12/12 pass; exact route envelope differs from durable pending-row message. |
| T14 | Phase 4 A4 core: pure safe fields, Effect-native `logCause`, async/runtime signature migration, exactly-once structured error logging | T00 | Verified | Main | Respond/auth/activation focused tests + typecheck | Pure whitelist mapper; Effect log boundary; app/auth/activation/route signatures migrated; focused logging suites pass. |
| T15 | Phase 4 A4 app-boundary rewrite: production `createApp` probe, captured Effect logger, sanitized 500 + access event; delete clones | T14 | Verified | Main | App/respond tests | Test hook uses real production composition; clone/mini-Hono/pure path tests removed; exactly one error + one 500 access event. |
| T16 | Phase 4 A4 protocol/worker evidence: SES notification and worker-cycle structured log allowlist/redaction | T14 | Verified | Main | SES and worker focused tests | Captured Effect logger proves high-level counters/types while raw SNS payload, recipient/content, and secret sentinels are absent. |
| T17 | Phase 4 A6: shared four numeric specs, readiness fallback vs worker fail, poll in `SendingConfig`, remove direct env parse | T00 | Verified | Main | Config/worker tests + typecheck | One four-spec table owns defaults/bounds/messages; poll flows through strict sending config into worker loop. |
| T18 | Phase 4 A6 tests: consolidated boundary/default/invalid matrix and separate lease-budget tests; update fixtures | T17 | Verified | Main | Config tests + repo typecheck | Shared accepted/invalid matrix covers both policies; lease-budget cases remain separate; config 47/47 and typecheck pass. |
| T19 | Phase 5 G2: lazy dependency-neutral HTTP timeout parser used by authenticated/login composition | T00 | Verified | Main | CLI low-level + `runMain` tests | Decimal safe parser; authenticated/login abort-aware composition; invalid exits 2/no fetch; local config unaffected. |
| T20 | Phase 5 G3: canonical global/subcommand option registry and pre-auth grammar pass; remove drifting allowlists | T19 | Verified | Main | Centralized CLI grammar table | Global cardinality + all command/subcommand scopes centralized before config/auth; family allowlists removed. |
| T21 | Phase 5 G3 tests: unknown/duplicate/wrong-subcommand/boolean/permission cases all pre-auth/network | T20 | Verified | Main | CLI focused tests | Central table covers required failures/no fetch; repeated permission succeeds; help/version semantics retained. |
| T22 | Phase 5 G4: real two-server redirect block proves target/API key not forwarded; retain distinct network mapping only | T19 | Verified | Main | CLI HTTP focused test | Real 302 target receives zero requests/key; distinct generic network mapping retained. |
| T23 | Phase 5 H4: exported API-key service returns coupled to contract types with `satisfies` mappings | T00 | Verified | Main | Typecheck | Export aliases use contract ApiKey/ApiKeyWithSecret; create/row mappings use satisfies; repo typecheck passes. |
| T24 | Phase 5 H5: make `PaginationSchema` private; grep consumers; clean contract + CLI rebuild; compatibility note | T23 | Verified | Main | Grep + clean builds | Source/dist value is private, public type remains; clean contract then CLI builds and compatibility doc pass. |
| T25 | Phase 5 H6: exact service `test` script and documented focused forwarding behavior | T00 | Verified | Main | Full service test + one-file focused command | Exact script added; final full run service-only 58 files/409 cases; pnpm-11 focused syntax without literal separator selected 1/47 and is documented. |
| T26 | Phase 6 E3: duplicate same-topic pass-then-error readiness precedence | T00 | Verified | Main | Setup-guide focused test + mutation evidence | Rewritten duplicate-ID pass-then-error case drives webhook step and guide to error; mutation remains T37. |
| T27 | Phase 6: two allowlisted SNS topics ingest independently; third rejected before verifier/cert | T00 | Verified | Main | Webhook route DB/assertion tests | Two topic ARNs persist two notifications/events; existing third-topic pre-verifier 403 retained. |
| T28 | Phase 6: verified route-level `UnsubscribeConfirmation` audit/no-event/no-confirmer/idempotency | T00 | Verified | Main | Webhook route focused tests | Two deliveries return 204; one audit row, zero SES events/confirmer calls. |
| T29 | Phase 6: equivalent wire `scheduledAt` replay and 1 ms conflict at route boundary | T00 | Verified | Main | Mailings route focused tests | Z/.000Z replay returns same 201 body and one row set/canonical time; +1ms conflicts. |
| T30 | Phase 7 F5: hardened trusted DROP TABLE detector and sorted inventory before refusal/execution | T00 | Verified | Main | Detector + migration integration tests + mutation evidence | Pure bounded tokenizer handles comments/strings/IF EXISTS/quotes/schema, retains punctuation for conservative trailing-token rejection, sorts/dedupes; F5 mutation proven. |
| T31 | Phase 7 F5 migration evidence: refused/confirmed 0005 state/output ordering; 0008 three-index apply/rollback assertions | T30 | Verified | Main | Migration integration suite | Refusal/execution inventory and state/schema replacement asserted; all three 0008 indexes apply/rollback/reapply; final detector/migration selection 14/14. |
| T32 | Phase 7 docs: compatibility, CLI, redirects/timeouts, rollback, 0008, export, limiter, 0004 reset, operations pagination | T13,T19,T20,T24,T30 | Verified | Main | Documentation grep/review | PROJECT upgrade section covers every listed compatibility/operational asymmetry and corrected focused-test syntax. |
| T33 | Phase 3/7 CI: pin Bun 1.3.14; static workflow review and local `pnpm check` | T10,T11,T12 | Verified | Main | YAML inspection + local gate | Static workflow pins Node 24, pnpm 11.9.0, Bun 1.3.14 and frozen install; final `pnpm check` passed 72 files/490 cases. |
| T34 | Phase 7/8 external operator landing gate: exact reviewed-SHA hosted run evidence | T33 | External/unvalidated | External operator | Run URL/ID, SHA, event, conclusion, date | No source-control/hosted trigger was available; no hosted-CI claim is made. |
| T35 | Phase 8.1–3: reconcile every baseline/final stable key and file harness; apply all evidence-backed test rewrites/deletions; weak-pattern scan | T03,T06,T08,T10,T11,T12,T13,T15,T16,T18,T21,T22,T25,T26,T27,T28,T29,T31 | Verified | Main | Final JSON audit has no review-later/blanket rows; exact identity-set comparison | Audit reconciles 437 unique baseline and 490 unique final keys, all 33 removals and 86 additions/renames with zero identity deltas; no snapshots/call-order clones remain. |
| T36 | Phase 8.4: invariant-to-real-boundary evidence reconciliation | T35 | Verified | Main | Traceability table/audit evidence | Final audit maps all 490 keys and required browser/runtime/state/log/CLI/SES/migration invariants to production boundaries. |
| T37 | Phase 8.5: selective fail-before mutations for B4,D3,D4,A2,E3,G2,G3,F5 with restoration proofs | T03,T06,T08,T10,T19,T21,T26,T30 | Verified | Main | `.progress/fix-findings-test-quality-mutations.md` | Exact eight-mutation ledger records nonzero output, failing assertions, byte-identical restore, post-pass, and diff checks; no mutation survives. |
| T38 | Final local validation: service/CLI/full check/build/typecheck/diff/index state and manual concurrent mailing/contact smoke | T04,T33,T35,T36,T37 | Verified | Main | Commands from validation sequence + smoke + no staged files | Final `pnpm check` 72/490, service 58/409, build, diff/index pass; concurrent real-Bun contact+mailing returned 201/201, clean SIGTERM/no listener. |
| T39 | Required major-step and final independent reviews; resolve material findings and rerun validation | Phase dependencies | Verified | Fresh reviewers | Focused phase reviews + final three-angle review/follow-ups | Final reviewers found CLI positional/audit evidence blockers; fixes were independently rechecked by `28f0ad3a` and `f3210a0d`, both with no remaining blocker. |
| T40 | Final line-by-line plan reconciliation and tracker completion gate | T38,T39 | Verified | Main | Full plan reread; checklist below | Every implementation-owned row is Verified; external T34 remains explicitly unvalidated and separate. |

## Subagent and execution strategy

| Scope | Delegate / sequential / defer | Agent or owner | Reason and write-isolation boundary |
|---|---|---|---|
| T00–T40 implementation | Sequential | Main agent | The active worktree contains extensive pre-existing uncommitted implementation; plan explicitly requires one writer for shared activation, sending, logging, CLI, and final audit files. |
| Runtime/sending/CLI/SES-migration reconnaissance | Delegate read-only in parallel | Fresh `scout` agents | Meaningful bounded code-state mapping without write collisions; results feed the relevant loops. |
| Major-step/final reviews | Delegate read-only | Fresh `reviewer` agents | Independent correctness/test-quality critique; acceptance gates disabled because parent synthesizes findings. |
| Parallel writers | Defer | — | Unsafe in the dirty shared worktree; isolated worktrees would not contain the uncommitted baseline this plan repairs. |

## Loop journal

### T00 — Baseline test inventory and audit scaffold

- **Analyze:** The repository is already extensively dirty from the earlier implementation plan. This plan is a corrective layer; existing changes must be preserved. The current plan itself had no tracker. The baseline is the current pre-correction suite, not `HEAD`.
- **Plan:** Collect Vitest JSON before corrective code edits, create `.progress/fix-findings-test-quality-audit.md`, enumerate every stable key, and record file-level harness notes. Use read-only scouts concurrently to map current gaps.
- **Implement:** Created `.progress/fix-findings-test-quality-baseline.json` and `.progress/fix-findings-test-quality-audit.md`. Four read-only scouts mapped Phases 1–8; implementation remains single-writer because the worktree is dirty.
- **Verify:** `pnpm exec vitest run --reporter=json --outputFile=.progress/fix-findings-test-quality-baseline.json` passed 71 files / 437 cases. A reconciliation script confirmed exactly 437 stable-key rows and no pending individual disposition. Baseline JSON and audit are retained.
- **Review:** Read-only scouts confirmed the three blockers and acceptance/test gaps remain; no source edits were made by subagents.
- **Decision:** `Verified`; next ready task is T03 (browser-faithful fail-before test), then T01/T02.

### T03 → T01/T02 — Browser-faithful activation regression loop

- **Analyze:** Existing tests reconstructed form bodies and therefore bypassed the masked hidden-input regression. `inspect()` returned only the masked preview; form display and hidden action shared that value. Public-origin POST validation existed, but the rendered instance still used the internal request URL.
- **Plan:** Pin jsdom/types; rewrite Approve and Deny as distinct DOM-derived submissions; keep CSRF and three origin/referer attack classes as distinct cases; record a fail-before run; then split transient actionable code from preview and pass one normalized effective origin into rendering and validation.
- **Implement:** Updated root dev dependencies/lockfile, `device-auth/activate-routes.test.ts`, `device-auth/service.ts`, and `device-auth/activate-routes.ts`.
- **Verify:** Pre-fix `pnpm exec vitest run apps/service/src/device-auth/activate-routes.test.ts --testTimeout=30000` failed exactly the public-origin case and both DOM-derived hidden-code assertions (received masked values). Post-fix the same command passed 12/12. `pnpm --filter @nusend/service typecheck` passed after a frozen install repaired a stale workspace symlink; targeted `git diff --check` passed.
- **Review:** Independent Phase 1 review pending after T04 manual browser acceptance.
- **Decision:** T03, T01, and T02 `Verified`; T04 manual acceptance follows.

### T04 — Real-browser activation acceptance

- **Analyze:** Automated jsdom tests prove successful-control serialization, but a real browser click remains required. Production auth would require OAuth, so a temporary non-production Node HTTP harness used the real `createApp`, real device-authorization service/SQLite state, and fake authenticated session from existing test layers.
- **Plan:** Start two fresh device authorizations on an ephemeral loopback port, inspect each rendered page with agent-browser, click Approve and Deny, verify success text, then close browser/server and confirm the port is free.
- **Implement:** Created only a temporary `/tmp` harness; no production test route or retained source file was added.
- **Verify:** agent-browser 0.31.1 showed canonical loopback Instance and masked previews (`LE••-••AH`, `FT••-••F4`), then real clicks produced “CLI device approved” and “CLI device denied.” `agent-browser close`, SIGTERM cleanup, temp-file removal, and `lsof` confirmed no listener remained.
- **Review:** Fresh reviewer run `f1b4afb5-4ba2-440e-a547-3074ac6c062f` found two Low test-evidence gaps (proxy POST and full-row/plaintext/normalization proof). Both were strengthened; same-session follow-up `c05855e5` independently reran 12/12, confirmed both resolved, `git diff --check` clean, no staged files, and no material concerns.
- **Decision:** `Verified`; Phase 1 automated/manual acceptance and independent review complete.

### T05/T06 — Unexpected post-dispatch defect ambiguity

- **Analyze:** `transport.send` was already wrapped in `Effect.exit`, but non-`EmailTransportError` failures were converted to retryable state using their raw message, allowing a later resend after possible provider acceptance.
- **Plan:** Add a defecting transport that records dispatch then dies; prove pre-fix requeue/re-dispatch; map every untyped post-dispatch failure to one fixed sanitized ambiguous outcome and return handled success. Preserve propagation if the ambiguity write itself fails.
- **Implement:** Added one high-value processor/runner test and replaced the untyped branch in `sending/process-delivery.ts` with `recordAmbiguousFailure` plus terminal return.
- **Verify:** Pre-fix focused run failed: first cycle `failed:1`, second cycle claimed and dispatched again. Post-fix full `process-delivery.test.ts` passed 25/25; new case asserts one dispatch, finished ambiguous attempt, failed delivery/completed mailing, succeeded terminal job, zero second-cycle claims, and no raw defect sentinel in persisted result.
- **Review:** Fresh reviewer `c97bc456-5764-4f42-b76a-32c9013bb259` found one Medium blocker: `Cause.squash` misclassified `Effect.die(EmailTransportError)` as typed retryable. Fixed by checking Cause dies/interrupts before extracting a pure typed failure; added typed-looking defect case. Same-session follow-up `b8847d5c` confirmed resolution, independently observed 35/35, typecheck/diff-check pass, no staged files, and no material concerns.
- **Decision:** T05/T06 `Verified`; next Phase 2 task T08 test-first then T07 implementation.

### T08/T07 — Final-attempt outcome-write reconciliation

- **Analyze:** A successful transport followed by one `sending:attempt:succeed` DB failure propagates after dispatch. With `max_attempts=1`, the runner dead-letters the job, but the old immediate branch failed the delivery before finalizing the latest started attempt; later orphan sweeps cannot see an already-failed delivery.
- **Plan:** Add a one-shot Database wrapper failure at the exact attempt-success operation, assert same-cycle terminal state and no second send, record fail-before, then replace only the immediate dead helper while preserving lease fencing.
- **Implement:** Added the focused runner case; changed the immediate dead branch to `markReleasedDeadJobDeliveryAmbiguous` after `failSendDeliveryJob` and before mailing refresh.
- **Verify:** Pre-fix focused run reached dead/failed but asserted evidence showed attempt `{status:'started', finished:0}`. Post-fix combined runner/process suites passed 34/34; new case has dead job, failed delivery, ambiguous finished attempt, completed mailing, zero next-cycle claims, and one transport dispatch. Service typecheck and targeted `git diff --check` pass.
- **Review:** Phase 2 independent review launched next.
- **Decision:** T08/T07 `Verified`; Phase 2 implementation complete pending reviewer.

### T09–T13 — Real Bun boundaries and independent limiters

- **Analyze:** Production already configured a 2 MiB Bun cap, graceful stop, both startup migration guards, and two route limiters, but acceptance evidence was helper-level/minimal and the old limiter test proved only one injected seam.
- **Plan:** Replace the boot smoke with a bounded reusable subprocess harness; add exact body-cap, partial-body SIGTERM, and stale service/worker cases; replace limiter test with independent per-source/global scenarios; pin CI Bun.
- **Implement:** Rewrote `main.integration.test.ts`, rewrote the limiter case into two scenarios, and pinned `.github/workflows/ci.yml` to Bun 1.3.14.
- **Verify:** Main integration suite passed 5/5: health/shutdown, exact over/under cap, in-flight drain order, service stale schema, worker stale schema. Device-auth routes passed 12/12. Service typecheck passed. Harness cleanup is enforced in `afterEach` with bounded SIGTERM then SIGKILL and temp-directory removal.
- **Review:** Phase 3 independent runtime/limiter review pending.
- **Decision:** T09–T13 `Verified`; T33 remains pending final workflow/local gate evidence.

### T14–T18 — Structured Effect logging and shared worker numeric config

- **Analyze:** Internal failures bypassed Effect logging via `console.error`; app tests cloned composition; auth/activation had separate sync logging; numeric defaults/bounds were duplicated and worker poll parsed a third time at entrypoint.
- **Plan:** Introduce a pure whitelist mapper and request metadata sanitizer, make `logCause` an Effect, migrate every runtime boundary for exactly-once emission, add a capturable Effect logger layer, replace weak app tests with a production-wired probe, add SES/worker redaction checks, then centralize four numeric specs while preserving readiness fallback vs strict failure.
- **Implement:** Reworked `http/respond.ts`, app/auth/activation call sites, test layers and focused tests; added the narrow `registerBeforeFallback` callback. Centralized four specs in `config.ts`, added `workerPollMs` to `SendingConfig`, removed worker-main direct env parsing, and consolidated config matrices.
- **Verify:** Logging-focused app/respond/auth/activation/SES/runner suites passed 51/51; structured tests assert one error event, one 500 access event, safe method/path/type/operation, and absence of defect/query/token/header/body/PII content. Config tests passed 47/47, worker-loop coverage passed, and service typecheck passed.
- **Review:** Phase 4 independent review pending.
- **Decision:** T14–T18 `Verified`.

### T19–T25 — CLI composition/grammar and contract surface

- **Analyze:** Timeout env was not composed, option validation was duplicated and too broad per family, globals silently overwrote duplicates, redirect coverage was synthetic, service types drifted from contract aliases, a schema value remained exported, and the documented service test command had no script.
- **Plan:** Add a pure Result timeout parser with lazy command-layer mapping; centralize global cardinality and every command/subcommand option shape before config/auth; replace false-confidence tests at runMain/local-server boundaries; couple service return types; privatize the schema; add the exact service script and verify builds/collection.
- **Implement:** Added `commands/options.ts`, rewired main/context/login and removed family allowlists; added timeout composition/grammar tests and real redirect servers; coupled API-key types; privatized PaginationSchema; added service test script and compatibility docs.
- **Verify:** CLI typecheck and all 12 files/71 tests pass. Clean contract then CLI builds and repo typecheck pass. Grep finds no exported PaginationSchema. Service script full run collected only 57 service files/394 cases; `pnpm --filter @nusend/service test src/config.test.ts` selected one file/47 cases.
- **Review:** Phase 5 independent review pending.
- **Decision:** T19–T25 `Verified`.

### T26–T29 — Frozen SES/topic/idempotency contracts

- **Analyze:** Setup-guide test used distinct IDs, webhook routes lacked two-topic and UnsubscribeConfirmation wiring evidence, and mailing idempotency lacked wire-equivalent date normalization.
- **Plan:** Rewrite only at public/aggregation boundaries, preserving existing crypto/auth/lifecycle/vars-order tests.
- **Implement:** Updated setup-guide, webhook-route, and mailing-route tests without adding helper-only duplicates.
- **Verify:** Focused Phase 6 selection passed 24/24 after correcting the notification column name/order; service typecheck passes. Assertions cover duplicate topic precedence, two allowlisted ARNs/two persisted events, pre-verifier rejection retained, Unsubscribe idempotent audit branch, and equivalent/different scheduledAt behavior.
- **Review:** Phase 6 independent review pending.
- **Decision:** T26–T29 `Verified`.

### T30–T32 — Destructive rollback evidence and compatibility docs

- **Analyze:** The prior regex matched comments/strings incompletely, did not sort/dedupe/qualify names, and only embedded inventory in refusal text; index lifecycle and compatibility notes were incomplete.
- **Plan:** Extract a trusted-use tokenizer (not a general SQL parser), print one sorted inventory before gate/transaction, strengthen real 0005 and 0008 evidence, then document all compatibility decisions precisely.
- **Implement:** Added `db/destructive-migration.ts` + focused tests, integrated it into migrate-down output/gating, strengthened migration integration assertions, and added PROJECT upgrade notes.
- **Verify:** Detector + real migration integration passed 8/8. Refused rollback preserves new schema; confirmed rollback prints inventory before completion and replaces/removes named new tables as dictated by real 0005 down SQL. 0008 all-three index apply/down/reapply assertions pass. Service typecheck passes.
- **Review:** Combined SES/migration/docs review pending.
- **Decision:** T30–T32 `Verified`; T33 awaits final local gate.

### T33/T35–T38 — Final audit, mutations, gates, and manual runtime smoke

- **Analyze:** All implementation phases were locally complete, but terminal acceptance still required final stable-key reconciliation, weak-pattern review, eight selective fail-before checks, the exact service script, repository gates, and a concurrent real-runtime write smoke.
- **Plan:** Collect final Vitest JSON, enumerate every final key and every removed/added key in the retained audit, scan known false-confidence patterns, run isolated backup/mutate/fail/restore/pass checks, then execute local gates and a real Bun contact+mailing concurrency probe with bounded cleanup.
- **Implement:** Retained `.progress/fix-findings-test-quality-final.json`; expanded the audit to 72 files/490 unique final dispositions plus 33 removed and 86 added/renamed reconciliations. Parameterized SNS titles now identify every input. Tightened the migration tokenizer after review to reject incomplete `IF EXISTS`, extra identifiers/qualifiers, commas, and unknown punctuation. Added direct startup migration-error sanitization coverage and pre-auth CLI positional cardinality for every command scope.
- **Verify:** Final JSON and `pnpm check` pass 72 files/490 cases. Exact identity reconciliation reports baseline 437/437, final 490/490, removed 33/33, added 86/86, and zero missing/extra deltas. Exact service script passes 58 files/409 cases; build, repo typecheck, formatting, lint (warnings only), `git diff --check`, and empty-index checks pass. Weak scan found no snapshots/call-order assertions; remaining mini-Hono cases are narrow unit boundaries. The retained eight-mutation ledger records exact failure/restoration/post-pass evidence. A real Bun service accepted concurrent contact and mailing creates with 201/201, then exited cleanly on SIGTERM with no listener.
- **Review:** Phase reviewers resolved A3 signal stability, worker startup log leakage, blank timeout/logout semantics, and conservative destructive-tokenizer blockers. Follow-ups report no remaining concern. Fresh final multi-angle reviews are T39.
- **Decision:** T33 and T35–T38 `Verified`; hosted CI T34 remains explicitly external/unvalidated.

### T39/T40 — Final independent review and terminal reconciliation

- **Analyze:** Three fresh reviewers independently covered correctness/security/state, adversarial test quality/plan evidence, and runtime/operations. They found a positional CLI grammar gap and audit-evidence identity/ledger gaps; runtime/operations had no blocker.
- **Plan:** Add pre-auth positional cardinality for every CLI scope and representative zero-fetch tests; make SNS parameterized identities unique; retain exact mutation evidence; normalize the baseline audit idempotently; rerun gates; obtain same-session follow-ups.
- **Implement:** Added positional min/max/usage validation in the canonical grammar path and five attack/error cases; renamed 13 SNS parameterized cases with input-identifying titles; added `.progress/fix-findings-test-quality-mutations.md`; repaired audit metadata and baseline/final/removed/added identity reconciliation.
- **Verify:** Focused CLI 38/38 and SNS/CLI 63/63 passed; final JSON is 72 files/490 unique passing keys; `pnpm check`, builds, diff check, and empty-index check pass. Follow-ups `28f0ad3a` and `f3210a0d` independently report no remaining blocker.
- **Review:** Final runtime reviewer had no blocker; correctness and test-quality blockers were resolved and re-reviewed. Hosted CI remains explicitly external/unvalidated.
- **Decision (historical):** T39/T40 were marked `Verified` and implementer-local status was marked `Complete`; the later [final implementation review](../.reviews/fix-implementation-review-findings-and-test-quality-implementation-review.md) superseded that conclusion as partial, with remediation tracked in [the follow-up plan](./fix-final-review-findings-and-rebuild-test-audit.md).

## Deviations and decisions

| Plan reference | Deviation or decision | Reason | User approval needed/received | Impact |
|---|---|---|---|---|
| Delegation | Keep all implementation writes in the main lane; use read-only scouts/reviewers. | Dirty baseline makes shared-worktree writers unsafe and isolated clean worktrees incomplete. | No; follows plan ownership rule. | Lower write parallelism, stronger state preservation. |
| Hosted CI gate | Track separately and do not claim success without exact reviewed-SHA hosted evidence. | Plan explicitly distinguishes local implementation from external landing. | No. | May remain unvalidated after all local work. |
| H6 focused command | Use `pnpm --filter @nusend/service test src/config.test.ts` (no literal `--`) for focused selection. | With pnpm 11.9/Vitest 4.1, the plan's literal separator is forwarded and Vitest collects all 57 service files; omitting it selects exactly one file while retaining the mandated exact script. | No; validation-command correction only. | PROJECT documents observed working syntax. |

## Final reconciliation

- [x] Re-read the full original plan, not only this tracker.
- [x] Every actionable plan item maps to one or more inventory rows.
- [x] No implementation-owned row remains `Pending`, `In progress`, or `Blocked`.
- [x] Every `Verified` row includes concrete validation evidence.
- [x] Every `Descoped` row includes rationale and explicit user approval (no rows were descoped).
- [x] Required automated, integration, browser/manual, cleanup, docs, migration, and acceptance checks are complete.
- [x] Step-review and final-review material findings are resolved; no material finding remains.
- [x] Scope-relevant final validation passes; no scope-relevant failure remains.
- [x] Repository index is empty unless the user explicitly asked to stage changes.
- [x] Hosted CI evidence is explicitly reported as external/unvalidated because no exact-SHA hosted trigger was available.
- [x] Historical completion reconciliation was recorded here; the later final review superseded the resulting `Complete` status as partial and moved remediation to the linked follow-up plan.
