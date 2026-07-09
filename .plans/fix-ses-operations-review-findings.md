# Plan: Fix SES Operations Review Findings

## Summary

Fix every issue raised in `.reviews/ses-operations-review.md` for the SES operations readiness/tracking implementation, including the two confirmed bugs, missing regression coverage, readiness/setup/observability shortfalls, and minor cleanup points. The goal is to keep the new `apps/service/src/ses/` subsystem and additive `0004_ses_operations_and_tracking.sql` migration, but make the implementation truthful, bounded, test-covered, and operationally usable before commit.

## Implementation Progress

Canonical tracker for this implementation. Updated before and after each loop.

### Overall status

- Status: complete
- Plan created: 2026-07-09
- Implementation started: 2026-07-09
- Source feedback: `.reviews/ses-operations-review.md`, `.progress/ses-operations-review.md`, and the user-provided feedback summary.
- Planning note: `.progress/fix-ses-operations-review-findings-plan.md`
- Browser/manual verification: skipped unless a UI is introduced; this plan is backend JSON API / CLI / docs only.
- Human checkpoint: none required; no destructive AWS actions were performed.

### Loop tracker

| Loop | Scope | Status | Verification | Review |
|---|---|---|---|---|
| 0 | Re-open plan tracker and confirm baseline failures | done | permanent repro tests added for SES summary + simulator failure semantics | advisory review completed |
| 1 | Critical correctness fixes | done | focused SES summary + simulator tests passed | advisory review completed |
| 2 | Config normalization and AWS admin boundedness | done | config/readiness/aws unit tests passed | advisory review completed |
| 3 | Webhook/event ingestion hardening | done | webhook HTTP tests + process-event malformed/idempotency tests passed | advisory review completed |
| 4 | Worker-run retention and observability | done | queue/worker tests + structured log points added; targeted tests passed | advisory review completed |
| 5 | Complete readiness/setup guide/docs/tracker gaps | done | readiness/setup-guide/docs tests and grep passed | final review completed |
| 6 | Minor cleanup, full validation, final review | done | `pnpm test --testTimeout=20000`, `git diff --check`, `pnpm check` passed | final independent review completed |

### Implementation notes

- 2026-07-09 Loop 0 analyze: read full plan and required `implement-plan`, `loop`, `agent-reviewer`, and Effect project-pattern guidance. Existing SES operations implementation is already present as uncommitted work from the prior plan. Next action: inspect current SES/AWS/worker code and establish targeted baseline failures before editing fixes.
- 2026-07-09 Advisory review: launched two read-only reviewer subagents (`0b403e5d...`) for config/readiness and webhook/worker scope. Findings matched plan gaps and guided implementation; artifacts are under `.pi-subagents/artifacts/outputs/0b403e5d-b47f-4315-9cce-749ed92be094/`.
- 2026-07-09 Loops 1-4 implementation: fixed SES summary `SELECT *` alias bug; added explicit read-model response types; fixed simulator typed-failure finalization with `Effect.exit`/`Effect.failCause`; added config diagnostics and public URL normalization; added AWS admin per-call abort signals, timeout classification, SNS pagination, tracking-domain extraction; audited verified malformed SES notifications before SES decode; made notification inserts `ON CONFLICT DO NOTHING`; restored webhook route tests; added worker-run idle heartbeat/pruning; added structured sanitized request/SES/readiness/simulator logs.
- 2026-07-09 Loop 5: expanded setup guide, docs, and original SES readiness plan tracker; documented `refresh=1` as accepted no-op (no cache implemented to avoid DB freshness ambiguity); updated stale future-looking `ses-feedback` references in `.plans/add-contact-list-suppression-management.md`.
- 2026-07-09 Validation: `pnpm test apps/service/src/aws apps/service/src/ses apps/service/src/operations apps/service/src/sending apps/service/src/config.test.ts --testTimeout=20000` passed (18 files / 123 tests); `pnpm --filter @nusend/service typecheck` passed; targeted `oxfmt --write` applied to touched TS files after `format:check` identified formatting issues.
- 2026-07-09 Final validation: `pnpm test --testTimeout=20000` passed (47 files / 277 tests); `git diff --check` passed; `pnpm check` passed with only pre-existing `apps/service/src/main.integration.test.ts` no-await-in-loop warnings.
- 2026-07-09 Final review: reviewer run `391d6020` found two major issues. Fixed request logging token leakage by redacting `/unsubscribe/:token` and adding a unit test; reconciled this tracker and `.plans/add-ses-operations-readiness-tracking.md`.
- 2026-07-09 Post-implementation re-review (`.reviews/ses-operations-review.md`, re-review section) confirmed all original findings fixed and raised four residual items, all fixed the same day: (1) retry-dedupe event/suppression loss window — `handleNotification` now reprocesses stored notifications with `event_type IS NULL` and no `ses_events` rows on SNS redelivery, with a regression test; (2) duplicate readiness check ids — `configIssues` ids now shadow same-id local checks, with a uniqueness test; (3) `?refresh=1` removed from README/ses-setup/production-readiness example URLs; (4) `simulator-main.ts` prints an end-to-end local-DB caveat to stderr. `pnpm check` green: 47 files / 280 tests.

## Confirmed requirements

- Fix **all** feedback points, including minor and optional points.
- Do not make destructive AWS changes; readiness/setup remain read-only.
- Preserve the new SES subsystem direction (`apps/service/src/ses/`) and operations route family (`/api/operations/ses/*`).
- Keep public outputs sanitized: no raw SNS JSON, secrets, email bodies, recipient vars, API keys, or auth internals in operations responses or logs.
- Add regression tests for every confirmed bug and every restored coverage class.
- Update `.plans/add-ses-operations-readiness-tracking.md` so its tracker accurately reflects the follow-up work and remaining accepted deviations, if any.

## Relevant research and evidence

### Local reproduction evidence

- A temporary Vitest repro seeded one `Bounce` row into `ses_events` and requested `GET /api/operations/ses/summary`; current code returned `500`, confirming the `SELECT *` / camelCase decoder bug in `apps/service/src/ses/read-model.ts`.
- A scratch script against installed `effect@4.0.0-beta.93` confirmed JS `try/catch` inside `Effect.gen` does not catch typed `Effect.fail(...)`; the simulator failure finalization path is therefore dead for typed failures.

### Dependency/API evidence

- Installed versions: `@aws-sdk/client-sesv2@3.1080.0`, `@aws-sdk/client-sns@3.1080.0`, `effect@4.0.0-beta.93` (`apps/service/package.json`).
- AWS SDK client `send(command, options)` accepts handler options; the project already uses `{ abortSignal: AbortSignal.timeout(ms) }` for SES sending in `apps/service/src/services/email-transport-ses.ts`.
- `@smithy/node-http-handler@4.9.3` is present transitively and supports `requestTimeout` / `connectionTimeout`; adding it as a direct dependency is an alternative if per-call abort signals prove insufficient.
- SESv2 `GetConfigurationSetResponse` includes `TrackingOptions.CustomRedirectDomain`, so custom redirect domain readiness can be checked read-only.
- Effect v4 exposes `Effect.catch`, `Effect.catchTags`, `Effect.catchCause`, `Effect.onError`, `Effect.exit`, and `Effect.result`; use these instead of JS `try/catch` for typed errors.

## Current-state findings

- `apps/service/src/ses/read-model.ts:68-116`
  - `getSesOperationsSummary()` returns `Effect<unknown, ...>` despite a known response shape.
  - Recent issues query uses `SELECT *`, but `SesEventRow` expects aliases like `notificationId`, `eventType`, `createdAt`.
- `apps/service/src/ses/simulator.ts:72-149`
  - Inserts a simulator run, then uses JS `try/catch` around yielded effects; typed failures bypass the catch and leave runs in `started`.
  - Uses `Date.now()` and real `Effect.sleep("1 second")`, making tests slower/harder than Clock/TestClock-based code.
  - Parses/stores `targetBaseUrl` but does not use it.
- `apps/service/src/config.ts:190-233` and `apps/service/src/aws/readiness.ts:44-48`
  - `sesOperationsConfig.publicBaseUrl` is not normalized, but readiness concatenates it with `sesSnsWebhookPath`.
  - Numeric readiness parsing silently falls back on invalid values and drifts from `sendingConfig` validation.
- `apps/service/src/aws/ses-admin.ts` and `apps/service/src/aws/sns-admin.ts`
  - Admin calls have no timeout/abort behavior.
  - SNS subscription listing does not paginate.
  - `SesAccountSummary.suppressionReasons` is fetched but unused.
  - SES configuration set summary does not expose tracking options.
- `apps/service/src/ses/process-event.ts`
  - Verified SNS notifications are decoded before raw notification insertion; malformed authentic events leave no audit row.
  - Subscription/Unsubscribe notification inserts are not transactional and may leak duplicate-race unique errors.
  - `Open` uses `firstDestination(...)`; `Click` inlines `event.mail.destination[0]`.
- `apps/service/src/ses/webhook-routes.ts`
  - There are no route-level tests replacing deleted `ses-feedback/routes.test.ts` coverage.
- `apps/service/src/queue/runner.ts`
  - Every worker cycle inserts `worker_runs`, including idle loop cycles; default 5s polling can create ~17k rows/day with no pruning.
  - Only one Effect log point exists.
- `apps/service/src/aws/readiness.ts` and `apps/service/src/ses/setup-guide.ts`
  - Several planned readiness checks are missing or folded into details: account suppression recommendation, separate DKIM check, domain identity fallback, custom tracking redirect domain verification, and SNS signature-version recommendation.
  - Setup guide has 8 steps and omits several planned setup actions.
- `docs/*`, `README.md`, `PROJECT.md`, and `.plans/add-ses-operations-readiness-tracking.md`
  - Docs exist but are brief; the tracker marks the implementation complete despite known gaps.

## Chosen implementation strategy

Use a focused hardening pass, not another broad rewrite. Fix critical data/Effect bugs first, then make operational checks bounded and truthful, restore deleted test coverage, and update docs/trackers so the implementation record matches reality.

Key choices:

1. **Keep additive migration 0004.** No migration rewrite is needed for these fixes unless retention policy later needs schema support; current issues can be fixed in TypeScript/tests/docs.
2. **Use existing SQL aliasing.** The summary bug should reuse `eventSelectSql`, not duplicate column lists.
3. **Use Effect-native finalization.** Simulator failures should be finalized with `Effect.exit` / `Effect.catch` / `Effect.onError`, then re-fail with the original typed error.
4. **Normalize config once.** Normalize `NUSEND_PUBLIC_BASE_URL` in `sesOperationsConfig`, matching `unsubscribeConfig` semantics.
5. **Bound AWS calls per request.** Use per-call `AbortSignal.timeout(requestTimeoutMs)` first, because it matches existing SES transport style and avoids a new direct Smithy dependency. If tests or types show that is insufficient, add direct `@smithy/node-http-handler` and a small `makeAwsRequestHandler` helper.
6. **Bound worker-run storage without losing worker liveness.** Persist all `once` runs, all non-idle/error loop runs, and periodic idle loop heartbeat rows; skip only repeated idle loop cycles between heartbeats. Prune old rows after inserts using a conservative retention constant or config-backed default.
7. **Audit verified malformed notifications.** Store the verified raw SNS notification before parsing the SES payload, with `event_type` / `ses_message_id` nullable when parsing fails. Keep response status `400` for malformed events so SNS retries as appropriate.
8. **Complete readiness/setup as operator guidance, not mutation.** Add checks and setup steps that report what to do; do not call mutating AWS APIs.
9. **Make all deviations explicit.** If anything remains intentionally out of scope, record it in the plan tracker and docs, not just in conversation.

## Alternatives considered

### Add a new migration for worker-run retention

Rejected for this follow-up. Retention can be handled by insert-time pruning and loop no-op skipping without schema changes. Add a migration later only if retention requires settings tables, aggregate rollups, or durable checkpoints.

### Import `@smithy/node-http-handler` immediately

Deferred. It is a valid solution and source evidence confirms timeout support, but the project already uses `AbortSignal.timeout` with AWS `send` calls. Per-call aborts are simpler and avoid relying on a transitive package unless we add it directly.

### Implement full remote simulator mode now

Rejected unless the implementer explicitly wants a larger feature. The feedback is about the current `--target-url` being a trap. The cleanup should either remove/fail that option clearly or document it as unsupported. A full remote mode would require remote API auth, polling remote operations endpoints, and clearer deployment assumptions.

### Keep the tracker marked complete and add a new plan only

Rejected. The old tracker is now known to be inaccurate. The follow-up plan should explicitly re-open or annotate it.

## Detailed implementation plan

### Phase 0 — Re-open tracker and confirm baseline

Files:

- `.plans/add-ses-operations-readiness-tracking.md`
- `.progress/ses-operations-review.md` or a new implementation progress note

Tasks:

1. Change the original plan tracker status from `complete` to something truthful such as `follow-up required` until this plan is done.
2. Add a short “Post-review follow-up” section referencing `.reviews/ses-operations-review.md` and this plan.
3. Before editing fixes, add temporary local repro tests or focused tests that demonstrate:
   - `/api/operations/ses/summary` fails with a Bounce recent issue.
   - simulator typed failure leaves a run stuck in `started`.
4. Convert those repros into permanent regression tests in later phases; do not leave temporary scratch files behind.

Success criteria:

- Tracker no longer overstates implementation quality.
- Implementer has a known failing baseline for both critical bugs.

### Phase 1 — Fix critical SES summary and simulator bugs

#### 1A. Fix `/api/operations/ses/summary` recent issues

Files:

- `apps/service/src/ses/read-model.ts`
- `apps/service/src/operations/routes.test.ts` or new `apps/service/src/ses/read-model.test.ts`

Tasks:

1. Define explicit response types for SES operations read models:
   - `SesOperationsSummaryResponse`
   - `SesEventsListResponse`
   - `SesEventDetailResponse`
   - `SesSimulatorRunsListResponse`
   - `SesSimulatorRunDetailResponse`
2. Change `getSesOperationsSummary()` from `Effect.Effect<unknown, ...>` to `Effect.Effect<SesOperationsSummaryResponse, ...>`.
3. Replace the recent-issues query:

   ```sql
   SELECT * FROM ses_events ...
   ```

   with:

   ```sql
   SELECT ${eventSelectSql} FROM ses_events ...
   ```

4. Add a route-level regression test for `GET /api/operations/ses/summary` that seeds:
   - one `ses_notifications` row;
   - one `ses_events` issue row, e.g. `Bounce` with `action_taken='suppressed'`;
   - one `worker_runs` row.
5. Assert:
   - response status `200`;
   - counts include the event;
   - `recentIssues[0]` is sanitized and correctly shaped;
   - raw notification JSON is absent;
   - latest worker run appears.

#### 1B. Fix simulator failure finalization

Files:

- `apps/service/src/ses/simulator.ts`
- new `apps/service/src/ses/simulator.test.ts`
- possibly `apps/service/src/testing/email-transport.ts` or test-layer helpers

Tasks:

1. Extract the body after `insertSimulatorRun(...)` into an inner Effect, e.g. `runSimulatorBody(runId, recipientEmail, startedAt, options)`.
2. Replace JS `try/catch` with Effect-native handling. Acceptable pattern:

   - build `body` as an `Effect.Effect<RunSesSimulatorResult, E, R>`;
   - run `Effect.exit(body)`;
   - on success, return result;
   - on failure, derive a safe message from `Cause.squash(exit.cause)`;
   - call `finishSimulatorRun(runId, "failed", message)`;
   - then re-fail with the original cause/error.

   Preserve typed errors; do not convert expected typed failures into defects.
3. Avoid real-time-only code in tests:
   - Prefer injectable `timeoutMs` and `TestClock.adjust` / `TestClock.setTime` where practical.
   - If simulator polling remains sleep-based, keep tests on failure paths that fail before sleep or use very small timeout values.
4. Add tests that prove:
   - if `createMailing` fails (e.g. marketing simulator without unsubscribe config), the simulator run is updated to `failed` with `finished_at` and an error message;
   - if the worker/send path fails before validation, status is finalized appropriately;
   - timeout status still records `timed_out` and `finished_at`;
   - success/send-acceptance path still records `sent` or `validated`.
5. Ensure `targetBaseUrl` behavior is addressed in Phase 6; do not leave it silently unused.

Success criteria:

- Both critical bugs have failing-before/passing-after regression tests.
- No simulator run can remain `started` after a typed failure in the controlled code path.

### Phase 2 — Normalize config and bound AWS admin calls

#### 2A. Normalize public base URL and expose invalid config as readiness data

Files:

- `apps/service/src/config.ts`
- `apps/service/src/ses/config.ts`
- `apps/service/src/aws/readiness.ts`
- `apps/service/src/config.test.ts`
- `apps/service/src/aws/readiness.test.ts`

Tasks:

1. Add a small helper for public base URL normalization used by SES operations config:
   - accept trimmed absolute HTTPS URLs with no query/fragment;
   - strip exactly trailing `/` from `.toString()` / normalized value;
   - keep setup/readiness bootable if missing.
2. Decide whether `sesOperationsConfig` should reject invalid public URLs or report them as readiness errors:
   - Preferred and required for this follow-up: keep API bootable and store invalid/missing optional SES operations config diagnostics in `SesOperationsConfig.configIssues` so readiness reports `config.public_base_url` / numeric config as `error` without making API startup boot-fatal.
   - Update `apps/service/src/ses/config.ts` type definitions, `SesOperationsConfigLive`, fake config helpers in `apps/service/src/testing/layers.ts`, and every consumer that currently assumes only `settings.config.*` values.
   - Ensure worker-only `sendingConfig` remains fail-fast for actual sending, while API readiness remains diagnostic.
3. Fix numeric config drift:
   - Do not silently fall back on garbage like `NUSEND_SES_REQUEST_TIMEOUT_MS=abc`.
   - Mirror `sendingConfig` constraints, including batch size `1..50` and lease budget.
   - Preserve setup endpoint bootability by collecting invalid-value issues for readiness instead of failing API startup.
4. Update tests for:
   - `NUSEND_PUBLIC_BASE_URL=https://mail.example.com/` produces `expectedWebhookUrl=https://mail.example.com/api/webhooks/aws/sns/ses`;
   - invalid public URL produces a readiness `error` check;
   - invalid numeric config values produce readiness errors instead of silent defaults;
   - valid default/missing config remains bootable.

#### 2B. Add AWS admin timeouts

Files:

- `apps/service/src/aws/ses-admin.ts`
- `apps/service/src/aws/sns-admin.ts`
- `apps/service/src/aws/readiness.test.ts` or new admin tests

Tasks:

1. Pass `settings.config.requestTimeoutMs` into `makeSesAdmin(...)` and `makeSnsAdmin(...)`.
2. Update `SesAdminSender` / `SnsAdminSender` to support `send(command, options?)`.
3. Wrap each AWS admin send with `{ abortSignal: timeoutSignal(requestTimeoutMs) }`, reusing the project’s existing `timeoutSignal` shape from `email-transport-ses.ts` or extracting a small shared helper if useful.
4. Add tests with fake senders to assert an abort signal is provided when `AbortSignal.timeout` exists.
5. Ensure timeout/abort errors classify into actionable readiness checks, likely `AwsAdminError(kind: "timeout" | "unknown")`:
   - Preferred: add a `timeout` kind to `AwsAdminError` and map `AbortError`, `TimeoutError`, `RequestTimeout` to it.
   - Update `awsErrorCheck(...)` messages accordingly.
   - Add at least one test where the fake sender rejects with an abort/timeout-shaped error and readiness maps it to the timeout/actionable status instead of generic `unknown`.
6. If TypeScript/Bun compatibility makes abort signals insufficient, add direct dependency `@smithy/node-http-handler` and construct clients with `requestHandler: new NodeHttpHandler({ requestTimeout, connectionTimeout })`; document that switch in the progress tracker.

#### 2C. Paginate SNS subscriptions

Files:

- `apps/service/src/aws/sns-admin.ts`
- `apps/service/src/aws/readiness.test.ts` or new `sns-admin.test.ts`

Tasks:

1. Update `listSubscriptionsByTopic(topicArn)` to follow `NextToken` until exhausted.
2. Preserve current sanitized summary shape.
3. Add a unit test where the matching HTTPS subscription appears on the second page.

Success criteria:

- Readiness URL matching is correct with trailing slashes.
- AWS readiness calls are bounded by configured timeout.
- SNS subscription checks do not false-warn with paginated topics.

### Phase 3 — Harden webhook ingestion and restore route tests

#### 3A. Restore HTTP-level webhook tests

Files:

- new `apps/service/src/ses/webhook-routes.test.ts`
- `apps/service/src/testing/layers.ts` if helpers are needed

Tasks:

1. Recreate the deleted route-level status mapping coverage from `ses-feedback/routes.test.ts` for the new `ses` route:
   - `204` for valid verified notification;
   - `400` for malformed SNS or malformed SES event;
   - `403` for bad SNS verification or disallowed TopicArn;
   - `404` when feedback topics are not configured;
   - `413` for body limit.
2. Assert webhook responses are empty where expected and never JSON envelopes.
3. Include SubscriptionConfirmation route behavior:
   - valid SubscribeURL calls fake confirmer and stores notification;
   - invalid SubscribeURL / confirmation failure maps to `500` (or chosen current internal status) without exposing details.

#### 3B. Store verified malformed notifications for audit

Files:

- `apps/service/src/ses/process-event.ts`
- `apps/service/src/ses/process-event.test.ts`
- `apps/service/src/ses/read-model.ts` if exposing malformed notifications in summary/events is desired

Tasks:

1. After SNS signature verification and TopicArn allowlisting, insert or find the `ses_notifications` row before decoding `envelope.Message`.
2. For `Notification` rows before decode, store:
   - `sns_message_id`, `sns_topic_arn`, `sns_type`, `raw_json`, `received_at`;
   - `event_type = NULL`, `ses_message_id = NULL` until decode succeeds.
3. If decode succeeds, update notification `event_type` / `ses_message_id` or insert with those values in one helper path.
4. If decode fails, return `SesOperationsMalformedError` so webhook status remains `400`, but retain raw verified notification for debugging.
5. Make duplicate insert idempotent with `INSERT ... ON CONFLICT(sns_message_id) DO NOTHING` or equivalent, including SubscriptionConfirmation/UnsubscribeConfirmation paths. Avoid check-then-insert races.
6. Add tests for:
   - malformed verified SES message stores exactly one notification and returns 400;
   - repeated same SNS message is idempotent;
   - SubscriptionConfirmation duplicate does not leak a unique constraint;
   - raw JSON is still not exposed through operations APIs.

#### 3C. Minor event-processing cleanup

Files:

- `apps/service/src/ses/process-event.ts`

Tasks:

1. Use `firstDestination(event)` consistently for `Open`, `Click`, and any future single-recipient event row.
2. Review `dedupe_key` construction for null recipient/link fields; keep behavior stable unless tests reveal collisions.
3. Add edge-case tests requested by review:
   - `not-spam` complaint records but does not suppress;
   - transient bounce records but does not suppress;
   - tag/email mismatch falls back to SES message ID resolution or leaves delivery null as designed;
   - malformed event -> 400 plus notification audit row.

Success criteria:

- Deleted webhook route coverage is restored.
- Authentic malformed SES notifications become auditable without exposing raw payloads.
- Idempotency no longer relies on fragile check-then-insert races.

### Phase 4 — Bound `worker_runs` and implement observability

#### 4A. Bound worker-run persistence

Files:

- `apps/service/src/queue/runner.ts`
- `apps/service/src/sending/worker.test.ts`
- maybe `apps/service/src/config.ts`, `apps/service/src/ses/config.ts`, `.env.example`, docs if retention becomes configurable

Tasks:

1. Define meaningful persistence policy:
   - Always persist `mode: "once"` runs.
   - Persist `mode: "loop"` runs when `released`, `claimed`, `succeeded`, `failed`, `dead`, or `skippedStale` is non-zero.
   - Persist a periodic idle-loop heartbeat, e.g. at most one pure-idle loop row per worker every 5 minutes, so operations can distinguish "worker healthy but idle" from "worker stopped".
   - Skip only repeated pure idle loop-cycle DB inserts between heartbeat rows.
2. Add pruning after persisted inserts:
   - Preferred simple default: delete rows older than 30 days using `finished_at < addDaysIso(now, -30)` if date helper exists or add a small ISO helper in `lib/iso-time.ts`.
   - Also consider keeping the newest N rows regardless of age (e.g. 10,000) if easy in SQLite; choose one retention scheme and document it.
3. Keep Effect log emission for idle loop cycles even if DB persistence is skipped, but avoid excessive log noise if the worker is idle every 5s:
   - Preferred: log non-idle cycles at info, idle cycles at debug if Effect logger supports levels, or only log idle every N cycles if state is tracked outside this function.
   - If this is too much, log all cycles but document DB retention as the primary fix.
4. Add tests proving:
   - idle loop run does not insert `worker_runs`;
   - `once` idle run still inserts;
   - non-idle loop run inserts;
   - pruning removes old rows but keeps recent rows;
   - periodic idle heartbeat inserts after the heartbeat interval but not before;
   - operations summary still gives operators a recent heartbeat during quiet periods;
   - `finished_at` remains fresh and not equal to stale `started_at` when the clock advances.

#### 4B. Add missing structured log points

Files:

- `apps/service/src/observability/effect-logger.ts`
- `apps/service/src/http/respond.ts`
- `apps/service/src/app.ts`
- `apps/service/src/ses/process-event.ts`
- `apps/service/src/aws/readiness.ts`
- `apps/service/src/ses/simulator.ts`
- `apps/service/src/main.ts`
- `apps/service/src/sending/worker-main.ts`
- new tests only where practical

Tasks:

1. Keep `Logger.consoleJson` as the logger layer, but add actual `Effect.logInfo` / `Effect.logWarning` / `Effect.logError` calls at planned operational points:
   - app startup and shutdown (sanitized host/port only, no secrets);
   - request completed middleware for API/webhook routes: method, path template or sanitized path, status, duration, request ID if added;
   - webhook received/verified/rejected: SNS type, message ID, topic ARN hash or sanitized ARN, reason code;
   - notification inserted or duplicate skipped;
   - SES event row inserted: event type, action taken, linked delivery/mailing IDs;
   - suppression created/skipped;
   - readiness completed: aggregate status, includeAws, check counts, not raw AWS responses;
   - simulator started/completed/failed/timed out;
   - worker cycle already logs counters; keep or refine after persistence policy.
2. Avoid logging:
   - raw SNS JSON;
   - email bodies/text/html;
   - recipient vars;
   - API keys/session data;
   - unsubscribe tokens/secrets;
   - full diagnostic codes if they can contain PII; truncate or omit.
3. Add a lightweight request-completion logging middleware as a required deliverable:
   - Exclude or reduce `/health` noise.
   - Log method, normalized/sanitized path, response status, duration, and request ID if added.
   - Do not log request/response bodies, raw query strings that may contain tokens, authorization headers, cookies, or API keys.
   - Ensure errors are still mapped by `runRoute`/`runWebhookRoute`; the middleware must observe final status without swallowing responses.
4. Update `docs/observability.md` to document logs, `worker_runs` retention behavior, and what is intentionally not logged.
5. Add focused tests for request logging at the middleware boundary if practical, at least asserting that a representative route still returns the same response and that no body/auth data is required to produce the log metadata. If full log capture is too brittle, record that limitation in the tracker, but do not skip adding the middleware/log points themselves.

Success criteria:

- Observability phase is no longer just “logger installed”; important paths emit structured, sanitized logs.
- `worker_runs` is bounded while still providing periodic worker liveness heartbeat rows.

### Phase 5 — Complete readiness checks and setup guidance

#### 5A. Add missing readiness checks

Files:

- `apps/service/src/aws/ses-admin.ts`
- `apps/service/src/aws/readiness.ts`
- `apps/service/src/aws/readiness.test.ts`
- `apps/service/src/ses/config.ts`

Tasks:

1. Account suppression recommendation:
   - Add `ses.account.suppression_recommendation`.
   - `ok` when account suppression reasons include both `BOUNCE` and `COMPLAINT`.
   - `warning` when missing either; action should recommend enabling account-level suppression as defense in depth while preserving local suppressions as source of truth.
2. Sender identity/domain fallback:
   - Parse domain from `NUSEND_SES_FROM_EMAIL` when it is an email address.
   - Check exact identity first.
   - If exact identity is not found or not verified, check domain identity.
   - Report which identity satisfied the check in details.
   - Preserve actionable warnings when neither is verified.
3. Separate DKIM readiness:
   - Add `ses.identity.dkim` as a separate check, not only a detail field.
   - `ok` for known successful DKIM statuses (e.g. `SUCCESS`); `warning` for pending/not started/failed/null with action to configure DKIM.
   - If exact identity falls back to domain, use the identity that will actually sign/send.
4. Custom tracking redirect domain:
   - Extend `SesConfigurationSetSummary` with `trackingCustomRedirectDomain: string | null` from `GetConfigurationSetResponse.TrackingOptions.CustomRedirectDomain`.
   - Add check `ses.config_set.<kind>.tracking_domain` when `NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN` is configured or tracking events are enabled.
   - `ok` when matching configuration set tracking domain equals configured domain; `warning` otherwise.
   - Include both transactional and marketing sets if both can emit open/click events; at minimum marketing when tracking is configured.
5. SNS signature-version recommendation:
   - Add explicit check or strengthen topic check: `sns.topic.signature_version` should warn if `SignatureVersion` is missing or not `2`.
   - Keep accepting signed messages according to verifier capability, but guide operators to SignatureVersion 2.
6. Readiness cache behavior:
   - Either implement the originally planned short TTL cache with `refresh=1`, or update docs and tests to state `refresh=1` is accepted as future-compatible no-op.
   - Since the user asked to fix all points, preferred: implement a simple in-memory 60s cache keyed by `includeAws` and invalidate on `refresh=1`. Keep local DB checks fresh enough or document that cache applies to AWS-only checks.
   - If cache would complicate DB freshness, keep no cache but explicitly mark it as a de-scoped item in the tracker and docs.

#### 5B. Expand setup guide

Files:

- `apps/service/src/ses/setup-guide.ts`
- new `apps/service/src/ses/setup-guide.test.ts`
- `docs/ses-setup.md`
- `docs/ses-readiness.md`
- `docs/production-readiness.md`
- `docs/engagement-tracking.md`

Tasks:

1. Expand setup guide from 8 steps toward the planned 15-step coverage. Include at least:
   - choose region;
   - configure env vars;
   - verify sending identity;
   - configure DKIM;
   - request production access;
   - enable account-level suppression recommendation;
   - create transactional/marketing configuration sets;
   - create SNS topic;
   - configure SES event destinations;
   - subscribe SNS HTTPS webhook;
   - configure SNS DLQ/alarms as operational guidance;
   - configure open/click tracking and custom redirect domain if desired;
   - configure public base URL and unsubscribe secret for marketing;
   - run readiness endpoint;
   - run SES simulator scenarios;
   - manually verify Gmail/List-Unsubscribe/DKIM before real marketing volume.
2. Add `relatedChecks` for each step so status aggregation is meaningful.
3. Add setup-guide tests for:
   - all major step IDs present;
   - step statuses aggregate related readiness checks correctly;
   - expected webhook URL uses normalized public base URL;
   - no raw secrets appear.
4. Update docs to align with the JSON guide and all new readiness checks.

Success criteria:

- Readiness exposes every previously dropped check or documents an explicit non-goal.
- Setup guide is complete enough for an operator without reading source.

### Phase 6 — Simulator CLI cleanup and tests

Files:

- `apps/service/src/ses/simulator-main.ts`
- `apps/service/src/ses/simulator.ts`
- `apps/service/package.json`
- new `apps/service/src/ses/simulator.test.ts`
- `docs/ses-simulator-testing.md`
- `README.md`

Tasks:

1. Address unused `--target-url`:
   - Preferred cleanup: remove the option or make it fail fast with a clear message: remote target validation is not implemented; run the simulator on the deployed instance that receives SNS.
   - If retaining the field for DB provenance, rename to `--note-target-url` or document it as metadata only. Avoid a misleading option name.
2. Add explicit CLI warning/help text for `--mode end-to-end`:
   - It only validates the app/database receiving SNS callbacks.
   - Running locally while SNS points to production will time out.
3. Add CLI parser tests where feasible, or extract pure `parseSimulatorArgs(argv)` and test:
   - valid scenario/mode/purpose;
   - `all` mode;
   - unsupported `--target-url` behavior;
   - timeout parse errors;
   - help/usage output if supported.
4. Add simulator runtime tests from Phase 1B.
5. Update docs with exact local-vs-deployed behavior and expected status transitions.

Success criteria:

- Simulator no longer has silent dead options.
- Failure, timeout, and success states are test-covered.

### Phase 7 — Minor code-quality and consistency cleanup

Files:

- `apps/service/src/aws/errors.ts`
- `apps/service/src/aws/readiness.ts`
- `apps/service/src/ses/process-event.ts`
- `apps/service/src/ses/read-model.ts`
- `apps/service/src/config.ts`
- relevant tests

Tasks:

1. Replace `capture(...)` helper with `Effect.result(...)` if it simplifies the code with installed Effect v4. If it makes code less clear, keep `capture` but add a short note in the progress tracker that `Effect.either` is not available in this installed API and `Effect.result` was evaluated.
2. Replace `new Date().toISOString()` in readiness with `currentIso` / `Clock`, matching project time conventions and enabling deterministic tests.
3. Tighten `classifyAwsAdminError(...)`:
   - Avoid broad `text.includes("credentials")` classification.
   - Prefer AWS SDK error names/codes such as credentials provider errors, `AccessDeniedException`, `UnrecognizedClientException`, `InvalidClientTokenId`, throttling, not-found names.
   - Add tests for representative errors.
4. Share config parsing logic or at least constraints between `sendingConfig` and `sesOperationsConfig` so readiness cannot report a worker config the worker would reject.
5. Normalize Open/Click first-destination handling as described in Phase 3C.
6. Review operations query filters for `/ses/events`, `/events/:id`, `/simulator-runs*` and add missing tests for filter combinations and not-found behavior.
7. Run cleanup grep:
   - active source/docs should not contain stale `ses-feedback`, `SesFeedback`, or `/operations/ses-feedback` references, except historical plans/artifacts/migrations where intentionally allowed.
   - Decide whether `.plans/add-contact-list-suppression-management.md` stale references should be updated now or left as historical plan text. Since the user asked all feedback, preferred: update active future-looking stale references in non-historical docs/plans if they could mislead future implementers.

Success criteria:

- Minor review findings are either fixed or explicitly recorded as not applicable after API inspection.
- Time/config/error behavior matches project conventions.

### Phase 8 — Documentation and plan tracker reconciliation

Files:

- `.plans/add-ses-operations-readiness-tracking.md`
- this new plan file
- `README.md`
- `PROJECT.md`
- `.env.example`
- `docs/*.md`

Tasks:

1. Update `.plans/add-ses-operations-readiness-tracking.md`:
   - Mark follow-up loops as required/in progress/done as implementation proceeds.
   - Remove or revise claims that targeted coverage exists where it did not.
   - Explicitly list remaining accepted deviations only if still true after fixes.
2. Update `README.md` and `PROJECT.md` to reflect:
   - new readiness checks;
   - simulator limitations;
   - worker-run retention behavior;
   - operations route coverage;
   - production marketing readiness caveats.
3. Update `.env.example` if new config is introduced (e.g. worker run retention days, readiness cache TTL). Avoid adding knobs unless they materially improve operator control.
4. Update docs:
   - `docs/ses-setup.md` with complete steps and IAM/readiness/simulator flow;
   - `docs/ses-readiness.md` with every check ID and status meaning;
   - `docs/ses-simulator-testing.md` with local/deployed caveats;
   - `docs/observability.md` with logs, `worker_runs` retention, and sanitization rules;
   - `docs/engagement-tracking.md` with tracking-domain readiness;
   - `docs/production-readiness.md` with DKIM/Gmail/List-Unsubscribe/manual verification.
5. Regenerate any plan HTML only if the implementation workflow uses rendered plans; otherwise Markdown docs are enough.

## Testing and verification plan

Run tests incrementally after each phase, then full validation at the end.

### Focused tests to add/update

- `apps/service/src/operations/routes.test.ts`
  - `/api/operations/ses/summary` with Bounce recent issue.
  - `/api/operations/ses/summary` with latest worker run.
  - `/api/operations/ses/events` filters and detail not-found.
  - `/api/operations/ses/simulator-runs` list/detail/not-found if not already covered.
- `apps/service/src/ses/simulator.test.ts`
  - failure finalization;
  - timeout finalization;
  - send-acceptance success/failure;
  - `--target-url`/remote-mode behavior via extracted parser if possible.
- `apps/service/src/ses/webhook-routes.test.ts`
  - 204/400/403/404/413 mappings;
  - SubscriptionConfirmation success/failure;
  - empty response bodies.
- `apps/service/src/ses/process-event.test.ts`
  - malformed verified notification audit row;
  - duplicate notification idempotency;
  - not-spam complaint no suppression;
  - transient bounce no suppression;
  - tag/email mismatch fallback behavior;
  - Open/Click destination consistency.
- `apps/service/src/aws/readiness.test.ts`
  - normalized public base URL;
  - account suppression recommendation;
  - exact identity vs domain fallback;
  - DKIM check;
  - tracking custom redirect domain check;
  - SNS signature version recommendation;
  - AWS failure timeout classification.
- `apps/service/src/aws/ses-admin.test.ts` / `sns-admin.test.ts` if not covered elsewhere:
  - abort signal / timeout option passed;
  - SNS pagination;
  - tracking options extracted.
- `apps/service/src/config.test.ts`
  - public base URL normalization;
  - invalid numeric config readiness issue behavior;
  - batch-size cap drift fixed.
- `apps/service/src/queue/runner.test.ts` / `sending/worker.test.ts`
  - idle loop skip persistence;
  - once mode persists;
  - prune old worker runs;
  - non-idle/error runs persist.
- `apps/service/src/ses/setup-guide.test.ts`
  - expected step IDs and status aggregation.

### Commands

Use relevant subsets during implementation:

```sh
pnpm test apps/service/src/ses
pnpm test apps/service/src/aws
pnpm test apps/service/src/operations
pnpm test apps/service/src/queue apps/service/src/sending
pnpm test apps/service/src/config.test.ts
pnpm --filter @nusend/service typecheck
pnpm format:check
```

Final validation:

```sh
pnpm test --testTimeout=20000
git diff --check
pnpm check
```

If `pnpm check` hits the known default Vitest timeout fragility, rerun full tests with `pnpm test --testTimeout=20000` and still investigate whether `vitest.config.ts` should set a project-level timeout for migration integration tests.

### Manual / operational verification

No browser verification is needed unless a UI is added. Do not perform live AWS mutations. Optional safe manual checks with fake/local app:

- Start in-process/local app and call:
  - `GET /api/operations/ses/readiness?includeAws=false`
  - `GET /api/operations/ses/setup-guide?includeAws=false`
  - `GET /api/operations/ses/summary`
- Run simulator CLI with fake/test transport only if the implementation adds such a harness. Do not send real SES simulator email unless explicitly approved.

## Risks and mitigations

- **Risk: AWS timeout implementation changes SDK behavior.** Mitigation: prefer per-call abort signal consistent with existing transport, add fake-sender tests, and classify aborts cleanly.
- **Risk: readiness config issues make API boot fail.** Mitigation: collect config issues into readiness checks rather than throwing from API startup config.
- **Risk: auditing malformed notifications stores sensitive raw JSON.** Mitigation: raw JSON is already stored for valid notifications; continue never exposing it through APIs/logs and document retention/privacy.
- **Risk: request logging leaks PII.** Mitigation: log method/path/status/duration only; no bodies, tokens, query strings containing secrets, raw SNS payloads, or email content.
- **Risk: worker-run pruning deletes useful debugging history.** Mitigation: document retention; keep recent/non-idle rows; operations summary only needs latest run.
- **Risk: setup-guide expansion becomes noisy.** Mitigation: keep steps ordered and status-driven; move details into docs links, not huge API payloads.
- **Risk: changing simulator CLI options breaks early users.** Mitigation: this is pre-release/early-development; fail fast with clear usage rather than silently accepting unused options.

## Definition of Done

- Critical bug repros are now permanent passing tests.
- `/api/operations/ses/summary` works with non-empty issue events.
- Simulator failures, timeouts, and successes finalize `ses_simulator_runs` correctly.
- Public base URL normalization is consistent across unsubscribe and SES operations.
- AWS admin readiness calls are bounded by configured timeouts and paginated where needed.
- Webhook HTTP status mapping coverage is restored.
- Verified malformed SES notifications are audited and sanitized outputs remain safe.
- Worker-run storage is bounded and documented, without losing all idle-worker liveness signal.
- Readiness includes account suppression, DKIM, identity/domain fallback, tracking-domain, and SNS signature-version guidance or explicitly documents any remaining non-goals.
- Setup guide/docs cover the full operational flow.
- Observability has real sanitized log points, not just a logger layer.
- Minor cleanup findings are resolved or explicitly recorded as not applicable after API inspection.
- `.plans/add-ses-operations-readiness-tracking.md` accurately reflects the follow-up state.
- Final validation passes: targeted tests, `pnpm test --testTimeout=20000`, `git diff --check`, and `pnpm check`.
- Independent final review finds no blockers.

## Open questions

None blocking. Vetoable implementation assumptions:

1. Worker-run retention will use a conservative code-level default plus periodic idle heartbeat unless the implementer decides an env var is worth the added config surface.
2. `--target-url` should fail fast or be removed rather than implementing full remote simulator mode in this cleanup pass.
3. Readiness cache should be implemented only if it does not make DB freshness confusing; otherwise `refresh=1` must be documented as a no-op and recorded as an explicit accepted deviation.
