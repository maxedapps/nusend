# Add High-Value Test Coverage and First-Party SNS Verification

## Summary

Update the high-value test plan to reflect a hard product decision: **remove `sns-validator` entirely** and replace it with first-party SNS message verification logic. Then add only the high-value tests that close production-boundary and complex-flow blind spots.

This is no longer purely test-only. The first phase is a small security-sensitive implementation replacement. The rest of the plan remains focused on tests, not broad feature work.

## Requirements and non-goals

### Requirements

- Remove `sns-validator` and `@types/sns-validator` from the project.
- Hand-write only the SNS verification logic Nusend needs.
- Add high-value tests around the verifier and previously identified blind spots.
- Keep the suite deterministic, local, and CI-safe: no real AWS/SNS/SES calls, no real external network dependency.
- Preserve existing public API routes, response shapes, DB schema, and SES webhook semantics unless a new test exposes a confirmed bug.
- Preserve existing Effect v4 service/layer style.
- Keep fixtures/log assertions sanitized: no real secrets, credentials, API keys, cookies, production webhook payloads, or customer addresses.

### Non-goals

- Do not implement live AWS integration tests in the default test suite.
- Do not broaden CRUD/validation tests for already-covered contacts/lists/suppressions/mailings.
- Do not add snapshot-heavy log tests.
- Do not add a generic cryptography abstraction.
- Do not support arbitrary SNS-like endpoints or custom certificate hosts.
- Do not keep backward compatibility with `sns-validator` behavior where it conflicts with AWS docs or Nusend’s stricter security posture.

## Current state

Current dependency usage:

- `apps/service/src/ses/sns-verifier.ts` imports `MessageValidator` from `sns-validator`.
- `apps/service/package.json` depends on `sns-validator`.
- root `package.json` has `@types/sns-validator`.
- `pnpm-lock.yaml` contains both packages.
- `apps/service/src/ses/sns-verifier.test.ts` currently has a smoke/failure test for the old callback package.

Current suite status before this plan:

- `pnpm test --testTimeout=20000` → 47 test files / 280 tests passed.
- `pnpm check` passes with existing `main.integration.test.ts` `no-await-in-loop` warnings only.
- No skipped/todo tests were found.

## Research findings

Official AWS sources consulted:

- <https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html>
- <https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html>
- <https://docs.aws.amazon.com/sns/latest/dg/http-subscription-confirmation-json.html>

Key AWS SNS verification rules:

- Verify SNS message signatures for `Notification`, `SubscriptionConfirmation`, and `UnsubscribeConfirmation` messages sent to HTTP(S) endpoints.
- Verification uses JSON body fields: `Signature`, `SignatureVersion`, `SigningCertURL`, and message fields included in the string-to-sign.
- `SignatureVersion` `1` uses SHA1.
- `SignatureVersion` `2` uses SHA256 and is recommended.
- Nusend will deliberately require `SignatureVersion` `2` for newly implemented first-party verification. This is a security posture and matches the project docs/readiness expectation that SNS topics use SignatureVersion 2. SignatureVersion 1 will be rejected with a sanitized verifier error instead of implementing SHA1 support.
- Build the string-to-sign from exact decoded JSON field values with `\n` separators and **no trailing newline**.
- For `Notification`, include fields in this order:
  - `Message`
  - `MessageId`
  - `Subject` only if present
  - `Timestamp`
  - `TopicArn`
  - `Type`
- For `SubscriptionConfirmation` and `UnsubscribeConfirmation`, include fields in this order:
  - `Message`
  - `MessageId`
  - `SubscribeURL`
  - `Timestamp`
  - `Token`
  - `TopicArn`
  - `Type`
- Fetch the signing certificate over HTTPS from a trusted AWS SNS domain and reject unexpected `TopicArn` values.
- Certificate chain/TLS validation is handled by HTTPS fetch when using platform TLS; Nusend should additionally validate the URL shape and SNS host before fetching.

Installed `sns-validator@0.3.5` source was inspected only to understand current behavior and removal impact. It is no longer a target dependency.

## Chosen strategy

1. Replace `sns-validator` with first-party verifier code inside the existing `SnsMessageVerifier` service boundary.
2. Keep public service behavior stable: `SnsMessageVerifierLive.verify(rawBody)` still returns `VerifiedSnsEnvelope` or `SnsVerificationError`.
3. Add small internal helpers for canonical string construction, strict certificate URL validation, bounded certificate fetching, and SignatureVersion 2 verification.
4. Unit-test those helpers directly via an internal module/factory and integration-test the live verifier with deterministic local signing material and injected/mocked certificate fetch.
5. Then implement the high-value tests from the previous review, without letting secondary tests crowd out review of the security-sensitive verifier.

## Alternatives considered

- **Keep `sns-validator` and only test it better** — rejected by explicit user decision.
- **Use another SNS validation dependency** — rejected; user wants first-party logic.
- **Use AWS SDK helper** — rejected unless an official, lightweight, directly applicable verifier exists in already-installed dependencies; the plan assumes no new dependency.
- **Perform live SNS signature tests** — rejected for default suite; tests must be deterministic and offline.
- **Over-generalize verifier for all AWS cert URLs** — rejected; accept only SNS certificate hosts Nusend expects.

## Implementation phases

Phases 0–2 are required for the dependency removal. Phases 3–8 are the core high-value test additions. Phases 9–10 are conditional stretch work and should not delay careful review of the first-party verifier.

## Phase 0 — Dependency removal and scope cleanup

Files:

- `apps/service/package.json`
- root `package.json`
- `pnpm-lock.yaml`
- `apps/service/src/ses/sns-verifier.ts`
- `apps/service/src/ses/sns-verifier.test.ts`

Tasks:

1. Remove `sns-validator` from `apps/service/package.json`.
2. Remove `@types/sns-validator` from root `package.json`.
3. Run package manager update, e.g. `pnpm install`, so `pnpm-lock.yaml` removes both packages.
4. Remove `import MessageValidator from "sns-validator"` from `sns-verifier.ts`.
5. Rewrite tests that mention loading the callback-based package.
6. Search active source for `sns-validator`; after implementation, only historical plan docs may mention it.

Acceptance:

- `grep -R "sns-validator" apps/service/src package.json apps/service/package.json pnpm-lock.yaml` returns no active dependency/source references.
- `pnpm install` leaves lockfile consistent.

## Phase 1 — First-party SNS verifier implementation

Files:

- `apps/service/src/ses/sns-verifier.ts`
- optionally a new internal module such as `apps/service/src/ses/sns-signature.ts` if it keeps `sns-verifier.ts` clearer.

Keep the existing public service shape:

```ts
export type SnsMessageVerifierService = {
  readonly verify: (
    message: string | unknown,
  ) => Effect.Effect<VerifiedSnsEnvelope, SnsVerificationError>;
};
```

### 1.1 Parse and decode full SNS envelope

Implementation details:

- If input is a string, parse JSON inside the verifier or reuse existing schema decoding from `sns-schema.ts` in a way that preserves all relevant SNS fields.
- Decode to `SnsEnvelope` / `VerifiedSnsEnvelope` using existing schemas.
- Keep malformed shape mapped to `SnsVerificationError`, not `SesOperationsMalformedError`, inside the verifier boundary.
- Do not log raw body or signature values.

### 1.2 Build canonical string-to-sign

Add a helper, preferably pure and testable:

```ts
function buildSnsStringToSign(envelope: SnsEnvelope): Effect.Effect<string, SnsVerificationError>
```

Rules:

- For `Notification`:
  - include `Message`, `MessageId`, optional `Subject`, `Timestamp`, `TopicArn`, `Type`.
- For `SubscriptionConfirmation` and `UnsubscribeConfirmation`:
  - require `SubscribeURL` and `Token`;
  - include `Message`, `MessageId`, `SubscribeURL`, `Timestamp`, `Token`, `TopicArn`, `Type`.
- Join as alternating field name and value separated by `\n`.
- Do **not** add a trailing newline.
- Use decoded string values from JSON parsing; do not re-escape `\n` or JSON-stringify field values.

### 1.3 Validate `SigningCertURL`

Add a pure helper:

```ts
function validateSigningCertUrl(url: string, topicArn: string): Effect.Effect<URL, SnsVerificationError>
```

Rules:

- Must parse as absolute URL.
- Protocol must be `https:`.
- No username/password.
- Port must be empty or `443`.
- Search/query string must be empty.
- Fragment/hash must be empty.
- Pathname must match AWS SNS signing certificate names, e.g. `/SimpleNotificationService-[A-Za-z0-9]+\.pem`; do not accept arbitrary `/cert.pem` style names.
- Host must match the SNS region/partition in `TopicArn`:
  - standard: `arn:aws:sns:<region>:...` -> `sns.<region>.amazonaws.com`
  - GovCloud: `arn:aws-us-gov:sns:<region>:...` -> `sns.<region>.amazonaws.com`
  - China: `arn:aws-cn:sns:<region>:...` -> `sns.<region>.amazonaws.com.cn`
- Reject malformed or non-SNS TopicArn values.

Rationale: this is stricter and more explicit than the old dependency’s broad host regex.

### 1.4 Fetch certificate safely

Add a helper:

```ts
function fetchSigningCertificate(url: URL): Effect.Effect<string, SnsVerificationError>
```

Rules:

- Use global `fetch` or a small internal fetcher function.
- Apply a bounded timeout, e.g. `AbortSignal.timeout(10_000)`.
- Require HTTP `200`.
- Limit certificate body size to a small maximum, e.g. 64 KiB, **without first buffering an unbounded response**.
  - Check `Content-Length` when present and reject values over the cap.
  - Stream `response.body` and accumulate bytes with an enforced cap before decoding to PEM.
  - If the runtime lacks a stream body in a test/fake response, keep the fetcher seam small enough to unit-test the cap logic separately.
- Return PEM string only after size and status checks pass.
- Map all failures to `SnsVerificationError` with sanitized reasons.
- Do not cache certificates initially unless implementation is trivial; correctness and simplicity matter more. Caching can be added later if webhook volume needs it.

Testability seam:

- Prefer an internal factory such as `makeSnsMessageVerifier({ fetchCertificate? })` used by `SnsMessageVerifierLive`, so tests can inject certificate material without monkey-patching global fetch.
- Keep this seam local to `sns-verifier.ts`; do not expose it as a public app service unless needed.
- If direct helper unit tests are awkward, place helpers in an internal `apps/service/src/ses/sns-signature.ts` module with named exports. Treat those exports as internal implementation APIs, not public service contracts.

### 1.5 Verify signature

Implementation details:

- Enforce SignatureVersion 2 only:
  - `SignatureVersion === "2"` -> `RSA-SHA256`
  - `SignatureVersion === "1"` must fail with `SnsVerificationError` because Nusend requires SNS SignatureVersion 2.
  - any other version must fail with `SnsVerificationError`.
- Decode `Signature` as base64.
- Use Node/Bun `crypto.createVerify(algorithm)`.
- Update verifier with canonical string using UTF-8.
- Verify against fetched PEM certificate/public key.
- Return decoded envelope only on successful verification.
- On failure, return `SnsVerificationError` with sanitized reason such as `SNS signature verification failed.`

Acceptance:

- Verifier rejects malformed envelopes, SignatureVersion 1, unsupported signature versions, bad cert URLs, fetch failures, invalid/non-base64 signatures, and invalid signatures.
- Verifier accepts a valid SignatureVersion 2 test fixture.
- No SHA1 / SignatureVersion 1 verification path is implemented.

## Phase 2 — First-party SNS verifier tests

Target file:

- `apps/service/src/ses/sns-verifier.test.ts`

Replace old dependency smoke tests with first-party verifier tests.

Recommended tests:

1. **Canonical string for Notification**
   - Include a `Subject` case and a no-`Subject` case.
   - Assert exact string with no trailing newline.

2. **Canonical string for SubscriptionConfirmation**
   - Include `SubscribeURL` and `Token`.
   - Assert exact string.

3. **Canonical string rejects missing confirmation fields**
   - `SubscriptionConfirmation` without `Token` or `SubscribeURL` fails.

4. **SigningCertURL validation accepts expected AWS SNS hosts and certificate basenames**
   - `arn:aws:sns:us-east-1:123456789012:topic` + `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem`.
   - `arn:aws-us-gov:sns:us-gov-west-1:123456789012:topic` + `https://sns.us-gov-west-1.amazonaws.com/SimpleNotificationService-abc123.pem`.
   - `arn:aws-cn:sns:cn-north-1:123456789012:topic` + `https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-abc123.pem`.

5. **SigningCertURL rejects unsafe URLs**
   - `http:`
   - non-SNS host
   - region mismatch
   - userinfo
   - unexpected port
   - non-`.pem` path
   - `.pem` path not matching `SimpleNotificationService-*.pem`
   - query string
   - fragment
   - malformed TopicArn

6. **Verifies valid SignatureVersion 2 notification**
   - Generate fake RSA test key/cert or use clearly fake static fixture.
   - Use injected certificate fetcher if Phase 1 added it.
   - Sign canonical string with `RSA-SHA256`.
   - Assert live verifier returns expected envelope.

7. **Rejects tampered signature / message**
   - Sign a valid fixture, then alter `Message` or signature.
   - Assert `_tag: "SnsVerificationError"`.

8. **Rejects SignatureVersion 1 and unsupported versions**
   - Assert SignatureVersion `1` fails with `SnsVerificationError`.
   - Assert an unknown version fails with `SnsVerificationError`.

9. **Rejects invalid/non-base64 `Signature`**
   - Assert malformed base64 fails before or during verification with `SnsVerificationError`.

10. **Maps certificate fetch failures and oversize certificate bodies to `SnsVerificationError`**
   - Inject fetcher failure or non-200 response.
   - Test `Content-Length` over the cap when present.
   - Test streamed body exceeding the cap if the fetcher helper exposes that path cleanly.

Acceptance:

- Tests cover first-party canonicalization, URL safety, signature algorithm selection, success, and failure.
- No reference to `sns-validator` remains in active test names/comments.

## Phase 3 — SES webhook HTTP edge-case tests

Target file:

- `apps/service/src/ses/webhook-routes.test.ts`

Add tests:

### 3.1 Unallowlisted topic

Test name:

- `returns empty 403 for verified notifications from non-allowlisted topics`

Steps:

1. Use `withTestApp` with fake SNS verifier returning the parsed envelope.
2. Send a structurally valid `Notification` whose `TopicArn` is not in `fakeSesOperationsConfig().feedbackTopicArns`.
3. Assert:
   - status `403`;
   - empty response body;
   - `ses_notifications` count is `0`;
   - `ses_events` count is `0`.

### 3.2 Missing SubscribeURL

Test name:

- `returns empty 500 for subscription confirmations without SubscribeURL`

Steps:

1. Use `withTestApp` with:
   - fake SNS verifier returning parsed envelope;
   - `snsConfirmerCalls: []`.
2. Send a `SubscriptionConfirmation` using the allowlisted topic but omit `SubscribeURL`.
3. Assert:
   - status `500`;
   - empty response body;
   - `snsConfirmerCalls` remains empty;
   - `ses_notifications` count is `0`.

Acceptance:

- Route-level mapping is pinned for two security/ops-sensitive branches.
- Tests verify no unintended audit writes happen before rejection.

## Phase 4 — Full lifecycle integration test

Preferred target file:

- New `apps/service/src/sending/ses-lifecycle.integration.test.ts`

Alternative:

- Add to `apps/service/src/sending/fake-workflow.integration.test.ts` if the team prefers fewer files.

Add one test:

- `records a worker-produced SES bounce and suppresses future sends`

Flow:

1. Use `withTestApp` configured with API-key permissions:

   ```ts
   {
     contacts: ["read", "write"],
     lists: ["read", "write"],
     mailings: ["create"],
     operations: ["read"],
     suppressions: ["read"]
   }
   ```

2. Provide fake unsubscribe config for marketing mail.
3. Provide fake SNS verifier that returns parsed request body.
4. Through HTTP API:
   - `POST /api/contacts` for `user@example.com`.
   - `POST /api/lists` for a list.
   - `POST /api/lists/:id/contacts` to subscribe the contact.
   - `POST /api/mailings` with `purpose: "marketing"`, `listId`, subject/html, and HTML containing `{{ unsubscribe.url }}`.
5. Run `runSendWorkerOnce` with:
   - `fakeEmailTransportLayer()`;
   - `fakeSendingConfigLayer({ marketingConfigurationSet: "marketing-set" })`.
6. Capture `fake.state.sent[0]` and assert only cross-module contract fields:
   - `tags.delivery_id` exists;
   - `tags.mailing_id` matches created mailing;
   - `tags.purpose === "marketing"`;
   - fake message ID is `fake-message-1` by current fake transport behavior.
7. POST a verified SNS `Bounce` notification to `/api/webhooks/aws/sns/ses` with:
   - `mail.messageId = "fake-message-1"`;
   - `mail.tags.delivery_id = [captured delivery id]`;
   - `mail.tags.mailing_id = [captured mailing id]`;
   - bounced recipient `user@example.com`;
   - `bounceType: "Permanent"`.
8. Assert:
   - webhook returns `204`;
   - `GET /api/operations/ses/events` includes one Bounce with expected `deliveryId`, `mailingId`, `actionTaken: "suppressed"`;
   - serialized operations response does not include notification `raw_json` sentinel;
   - `GET /api/suppressions?email=user@example.com` includes `scope: "all"`, `reason: "bounce"`.
9. Create a second marketing mailing to the same list.
10. Assert exact current behavior:
   - response status `422`;
   - body error code `empty_recipient_set`;
   - no additional delivery/job rows for that second mailing if practical to assert via DB.

Acceptance:

- Proves worker-produced tags/message IDs are sufficient for SES event resolution.
- Proves SES bounce suppression affects future mailing creation through public APIs.
- Does not over-assert every operation response field.

## Phase 5 — SES event row-shape table tests

Target file:

- `apps/service/src/ses/process-event.test.ts`

Add a table-driven test group for event types not already covered in detail.

Recommended selected columns:

- `event_type AS eventType`
- `recipient_email AS recipientEmail`
- `action_taken AS actionTaken`
- `diagnostic_code AS diagnosticCode`
- `delivery_delay_type AS deliveryDelayType`
- `reject_reason AS rejectReason`
- `occurred_at AS occurredAt`

Cases:

1. `DeliveryDelay`
   - Include delayed recipient diagnostic code, `delayType`, event timestamp.
   - Assert `deliveryDelayType`, `diagnosticCode`, `recipientEmail`, `occurredAt`, `actionTaken: "recorded"`.
2. `Delivery`
   - Include two `delivery.recipients`.
   - Assert one row per recipient, no suppressions.
3. `Reject`
   - Include `reject.reason` and destination.
   - Assert `rejectReason`, no suppressions.
4. `Send`
   - Assert destination fallback row.
5. `Rendering Failure`
   - Assert destination fallback row and event type preserved.
6. `Subscription`
   - Assert destination fallback row.
7. Unknown authentic event name
   - Use a name not in `SesEventTypeValues`.
   - Assert stored event type is `Unknown`.
   - Include one case with empty destination to assert null-recipient fallback.

Acceptance:

- Every `eventRowsForEvent` branch has behavior-level coverage.
- Test remains compact and readable.
- No suppressions are written except in already-covered Bounce/Complaint cases.

## Phase 6 — SES operations endpoint auth tests

Preferred target file:

- New `apps/service/src/ses/routes.test.ts`

Alternative:

- `apps/service/src/operations/routes.test.ts` is acceptable but less clear because the routes are implemented in `apps/service/src/ses/routes.ts`.

Add a table test over representative endpoints:

- `/api/operations/ses/summary`
- `/api/operations/ses/events`
- `/api/operations/ses/readiness?includeAws=false`
- `/api/operations/ses/setup-guide?includeAws=false`
- `/api/operations/ses/simulator-runs`

For each endpoint assert:

1. no auth -> `401`;
2. API key with unrelated permission (`mailings:create`) -> `403`;
3. session owner -> `200`;
4. API key with `operations:read` -> `200`.

Implementation notes:

- Keep body assertions minimal; this test is about auth routing only.
- Use `includeAws=false` for readiness/setup-guide to keep tests focused and deterministic.

Acceptance:

- Directly protects `routes.use("/*", requireOperationsRead)` in `apps/service/src/ses/routes.ts`.

## Phase 7 — SES transport abort-signal and timeout classification tests

Target file:

- `apps/service/src/services/email-transport-ses.test.ts`

Add tests:

### 7.1 Abort signal passed to sender

Test name:

- `passes an abort signal to the SES sender`

Steps:

1. Fake sender captures the second argument passed to `send(command, options)`.
2. Return `{ MessageId: "ses-message-1", $metadata: {} }`.
3. Invoke `makeSesEmailTransport(fakeSender, 30_000).send(prepared)`.
4. Assert:
   - captured options exists;
   - `options.abortSignal` is an `AbortSignal` when `AbortSignal.timeout` is available.

### 7.2 Timeout-shaped failure maps through transport path

Test name:

- `maps timeout-shaped send rejection to ambiguous through transport.send`

Steps:

1. Fake sender rejects with an Error whose `name` is `AbortError` or `TimeoutError`.
2. Invoke `transport.send(prepared)`.
3. Assert rejection matches:

   ```ts
   { _tag: "EmailTransportError", kind: "ambiguous", operation: "ses:send" }
   ```

Acceptance:

- Tests protect actual transport wiring, not just `classifySesError()` in isolation.

## Phase 8 — Public unsubscribe body-limit guard

Target file:

- `apps/service/src/unsubscribe/routes.test.ts`

Add exactly one test:

- `POST returns 413 for oversized unsubscribe bodies without mutation`

Steps:

1. Seed a valid marketing unsubscribe token using existing helpers.
2. POST `/unsubscribe/:token` with body length greater than 8192 bytes.
3. Assert:
   - status `413`;
   - HTML body contains generic too-large message;
   - suppression count remains `0`.

Acceptance:

- Protects a public unauthenticated route limit.
- Do not add similar tests to every authenticated JSON route unless there is a specific risk.

## Conditional Phase 9 — Structured log capture/redaction tests

Implement only if this stays localized.

Potential files:

- `apps/service/src/app.test.ts`
- `apps/service/src/ses/process-event.test.ts`
- `apps/service/src/queue/runner.test.ts`
- optional helper in `apps/service/src/testing/layers.ts`

Recommended test-layer change:

1. Add optional `logger?: Layer.Layer<never>` to `TestLayerOptions` / `TestAppOptions` if needed.
2. Merge it into `testLayer()` / `makeTestRuntime()` with default no extra logger behavior.
3. Create helper locally or in testing utilities:

   ```ts
   function captureLoggerLayer(entries: unknown[]): Layer.Layer<never> {
     const logger = Logger.make((options) => {
       entries.push(options);
     });
     return Logger.layer([logger]);
   }
   ```

Test scenarios:

1. HTTP request logging:
   - Request `/unsubscribe/secret-token-value`.
   - Assert captured log serializes to `/unsubscribe/:token` and not `secret-token-value`.
   - Assert it does not contain `x-api-key`, `cookie`, request body sentinel.
2. SES webhook logging:
   - Use a valid event containing a harmless sentinel in a field that should not be logged while still decoding successfully.
   - Assert logs include high-level IDs/type/action but not raw outer JSON, raw `Message`, email body, API key, or unsubscribe token.
   - Do not assert against `ses_notifications.raw_json`; raw audit storage is intentional.
3. Worker cycle logging:
   - Run a small worker cycle.
   - Assert logs include counts and `workerId` but not rendered HTML/text or recipient vars.

Acceptance:

- Tests pin sanitized log contract without brittle full-log snapshots.
- If adding logger support to shared test layers becomes invasive, defer this phase and record rationale.

## Conditional Phase 10 — Queue runner skipped-stale race tests

Implement only if this stays localized and does not require broad production refactoring.

Target file:

- `apps/service/src/queue/runner.test.ts`

Goal:

- Cover `JobNotLeasedError` handling after processor success and after processor failure in `runSendWorkerOnce`.

Preferred simulation approaches, in order:

1. **Custom EmailTransport requiring Database**
   - Success branch: fake transport mutates the leased job’s `locked_by` or state after `processSendDeliveryJob` has started but before it returns success, then returns success. `completeSendDeliveryJob` should see stale lease.
   - Failure branch: fake transport mutates lease before failing retryably. `failSendDeliveryJob` should see stale lease.
2. **Database service wrapper**
   - Delegate to the real test DB but intercept operation labels `jobs:complete-send-delivery` / `jobs:fail-send-delivery` to simulate no returned row.
   - Use only if custom transport approach is not workable.

Assertions:

- `runSendWorkerOnce` result has `skippedStale: 1` for each branch.
- `succeeded` / `failed` counters do not increment for the stale branch.
- `worker_runs.skipped_stale` is persisted.
- Job remains in the intentionally lease-mutated/non-terminal state.
- Do not assert “no processor side effects”; `processSendDeliveryJob` may already have mutated delivery/attempt state before the stale queue transition.

Acceptance:

- Covers both success and failure stale branches if feasible.
- If only one branch is cleanly simulated, implement that one and document why the other was deferred.

## Explicitly deferred

- Simulator CLI subprocess smoke tests for normal operation. Defer until simulator CLI becomes more user-facing or has regressions. Current `runSesSimulator` core behavior is tested.
- Historical SES feedback data-preservation migration tests. Current early-development/reset-clean posture makes this lower value than runtime boundary tests. Revisit if preserving old `ses_feedback_*` rows becomes a requirement.
- Additional CRUD/validation tests for recipient management/mailings unless a concrete regression is found.
- Live AWS tests in default CI.

## Files likely to change

Implementation / dependency removal:

- `apps/service/src/ses/sns-verifier.ts`
- optional `apps/service/src/ses/sns-signature.ts`
- `apps/service/package.json`
- root `package.json`
- `pnpm-lock.yaml`

Core tests:

- `apps/service/src/ses/sns-verifier.test.ts`
- `apps/service/src/ses/webhook-routes.test.ts`
- `apps/service/src/sending/ses-lifecycle.integration.test.ts` or `apps/service/src/sending/fake-workflow.integration.test.ts`
- `apps/service/src/ses/process-event.test.ts`
- `apps/service/src/ses/routes.test.ts` or `apps/service/src/operations/routes.test.ts`
- `apps/service/src/services/email-transport-ses.test.ts`
- `apps/service/src/unsubscribe/routes.test.ts`

Conditional phases:

- `apps/service/src/testing/layers.ts` only if logger-layer test support is needed.
- `apps/service/src/app.test.ts`
- `apps/service/src/queue/runner.test.ts`

## Validation plan

Run targeted tests after each phase:

```sh
pnpm test apps/service/src/ses/sns-verifier.test.ts --testTimeout=20000
pnpm test apps/service/src/ses/webhook-routes.test.ts --testTimeout=20000
pnpm test apps/service/src/sending --testTimeout=20000
pnpm test apps/service/src/ses/process-event.test.ts --testTimeout=20000
pnpm test apps/service/src/ses/routes.test.ts apps/service/src/operations/routes.test.ts --testTimeout=20000
pnpm test apps/service/src/services/email-transport-ses.test.ts --testTimeout=20000
pnpm test apps/service/src/unsubscribe/routes.test.ts --testTimeout=20000
```

If conditional phases are implemented:

```sh
pnpm test apps/service/src/app.test.ts apps/service/src/ses/process-event.test.ts apps/service/src/queue/runner.test.ts --testTimeout=20000
```

Dependency validation:

```sh
pnpm install
grep -R "sns-validator" apps/service/src package.json apps/service/package.json pnpm-lock.yaml
```

Final validation:

```sh
pnpm test --testTimeout=20000
pnpm check
git diff --check
```

If new tests need intentional sequential awaits, use narrow `oxlint-disable-next-line no-await-in-loop` comments with a reason.

## Implementation decomposition

Sequential/single-writer recommended first:

1. Replace SNS verifier and remove dependency.
2. Add verifier tests.

Safe parallel implementation afterward if using isolated worktrees or careful file ownership:

- Worker A: webhook route edge tests.
- Worker B: process-event row-shape table + SES ops auth tests.
- Worker C: transport timeout + unsubscribe body-limit tests.

Sequential/single-writer recommended:

- Full lifecycle integration test, because it crosses app routes, fake transport, worker, SES webhook, suppressions, and operations.
- Conditional log capture helper if it touches `testing/layers.ts`.
- Conditional queue stale-race tests because simulation details are subtle.

Recommended independent review after implementation:

- Ask a fresh reviewer to inspect the first-party SNS verifier carefully.
- Specifically ask for critique of canonical string order, cert URL validation, signature algorithms, sanitized error handling, and test fixture correctness.
- Then ask reviewer to inspect whether new tests remain high-value and not over-coupled.

## Risks and mitigations

- **SNS signature implementation mistakes**: mitigate with pure canonical-string tests, URL validation table tests, valid signature fixture, tamper tests, and reviewer pass focused on AWS docs.
- **Certificate URL SSRF risk**: validate URL before fetch; require HTTPS, no userinfo, expected SNS regional host, `.pem`, no unexpected port, topic-region match.
- **Certificate fetch hangs or huge body**: use timeout and size limit.
- **Logging sensitive verifier failures**: map all failures to sanitized `SnsVerificationError` reasons; do not include raw body, signature, or cert content.
- **Lifecycle test too broad**: keep exactly one lifecycle test and assert only cross-module contracts.
- **Log tests brittle**: assert only message names and security-relevant presence/absence; avoid timestamps, durations, fiber IDs, exact full JSON.
- **Queue stale-race complexity**: keep conditional; avoid broad refactor. Accept deferral if simulation becomes disproportionate.

## Definition of Done

- `sns-validator` and `@types/sns-validator` are removed from active manifests and lockfile.
- First-party SNS verifier handles supported SNS message types and rejects unsafe/malformed inputs.
- Required SNS replacement phases 0–2 are implemented and passing.
- Core high-value test phases 3–8 are implemented and passing, or any deviation is documented with rationale.
- Conditional phases 9–10 are implemented only if they remain localized and high-value.
- No broad low-value test expansion is added.
- Targeted tests pass after each phase.
- Full suite and `pnpm check` pass.
- No public API/schema behavior changes unless a confirmed bug required it.

## Implementation Progress

Tracker started: 2026-07-09.

### Scope and constraints

- Implement exact plan in this file.
- Preserve deterministic/local tests; no real AWS/SNS/SES/network dependency.
- Single-writer main-agent implementation in the active worktree unless a clearly independent subagent/worktree split is used.
- Browser/manual verification: skipped unless UI/browser-visible behavior changes; current plan targets backend services/routes/tests only.

### Decomposition decision

- Required sequential loop first: Phases 0–2 (`sns-validator` removal, first-party verifier, verifier tests) because security-sensitive implementation and dependency updates are tightly coupled.
- Read-only subagents may scout/review independently.
- Later test phases may be grouped by file ownership, but main agent remains sole writer in this worktree.
- Conditional phases 9–10 will be analyzed after core phases; implement only if localized and high-value.

### Loop log

| Loop | Scope | Status | Verification | Review |
| --- | --- | --- | --- | --- |
| 0 | Read full plan, skills, initialize tracker, decide decomposition | Complete | Plan read in full; tracker added | n/a |
| 1 | Phases 0–2 SNS verifier replacement/tests | Complete | `pnpm test apps/service/src/ses/sns-verifier.test.ts --testTimeout=20000`; dependency grep/install validation | Reviewed; no blockers |
| 2 | Phases 3, 5–8 focused route/service tests | Complete | Targeted tests per phase | Reviewed; no blockers |
| 3 | Phase 4 lifecycle integration | Complete | `pnpm test apps/service/src/sending --testTimeout=20000` via targeted suite | Reviewed; no blockers |
| 4 | Conditional phases 9–10 decision/implementation if localized | Complete | Phase 9 deferred with rationale; Phase 10 targeted test passed | Reviewed; no blockers |
| 5 | Final validation/review | Complete | `pnpm test --testTimeout=20000`; `pnpm check`; `git diff --check`; dependency grep/`pnpm why` | Final review; no blockers |

### Notes

- No human checkpoint currently required: plan is explicit; no credentials/production/destructive action needed.

### Loop 1 update — Phases 0–2 SNS verifier replacement

Status: Implemented, pending independent review.

Actions:
- Removed `sns-validator` from `apps/service/package.json`.
- Removed `@types/sns-validator` from root `package.json` and refreshed `pnpm-lock.yaml` with `pnpm install`.
- Replaced package wrapper in `apps/service/src/ses/sns-verifier.ts` with first-party `makeSnsMessageVerifier` preserving the existing service boundary and fake layer.
- Added internal helper module `apps/service/src/ses/sns-signature.ts` for canonical string construction, strict signing cert URL validation, bounded certificate fetch, and SignatureVersion 2 RSA-SHA256 verification.
- Replaced `apps/service/src/ses/sns-verifier.test.ts` with tests for canonical strings, confirmation-field failures, cert URL accept/reject cases, valid v2 signature, tampering, v1/unknown rejection, invalid base64, fetch failures, and oversized certificate responses.

Verification run:
- `pnpm install` → passed, removed 2 packages.
- `pnpm test apps/service/src/ses/sns-verifier.test.ts --testTimeout=20000` → passed, 1 file / 23 tests.
- `pnpm --filter @nusend/service typecheck` → passed.
- `grep -R "sns-validator" apps/service/src package.json apps/service/package.json pnpm-lock.yaml || true` → no output.

Browser/manual verification: skipped; backend verifier/test-only changes, no browser-visible UI.

Review: launching independent reviewer for security-sensitive verifier before later overlapping changes.

### Loop 1 review follow-up

Reviewer artifact: `.pi-subagents/artifacts/outputs/635b7267/implementation-review/sns-verifier-phase-review.md`.

Findings:
- Blockers: none.
- Accepted medium note: default fetch redirects could follow an unvalidated `Location`. Fixed by adding `redirect: "error"` and test assertion.
- Accepted low note: unsupported SignatureVersion / invalid base64 previously fetched certificate before cheap rejection. Fixed by adding `validateSnsSignatureMetadata` preflight before certificate fetch and tests asserting fetcher is not called.
- Deferred low note: success test uses a generated public key PEM instead of an X.509 certificate. Kept as-is because `createVerify().verify()` accepts both key and certificate PEM; generating a cert would add test fixture complexity. Final review should re-check this judgment.

Verification after fixes:
- `pnpm test apps/service/src/ses/sns-verifier.test.ts --testTimeout=20000` → passed, 1 file / 23 tests.
- `pnpm --filter @nusend/service typecheck` → passed.

### Loop 2/3 update — Core high-value tests Phases 3–8

Status: Implemented, pending review.

Actions:
- Phase 3: added SES webhook route edge tests for unallowlisted verified topic and subscription confirmation missing `SubscribeURL` in `apps/service/src/ses/webhook-routes.test.ts`.
- Phase 4: added one full lifecycle integration test in `apps/service/src/sending/ses-lifecycle.integration.test.ts` covering contact/list/mailing creation, worker send tags/message id, verified SES bounce webhook, operations event projection, bounce suppression, and blocked future marketing mailing.
- Phase 5: added process-event row-shape coverage for `DeliveryDelay`, `Delivery`, `Reject`, `Send`, `Rendering Failure`, `Subscription`, and unknown event normalization in `apps/service/src/ses/process-event.test.ts`.
- Phase 6: added SES operations endpoint auth matrix in new `apps/service/src/ses/routes.test.ts`.
- Phase 7: added SES transport abort-signal wiring and timeout-shaped rejection mapping tests in `apps/service/src/services/email-transport-ses.test.ts`.
- Phase 8: added public unsubscribe oversized POST body-limit guard in `apps/service/src/unsubscribe/routes.test.ts`.

Verification run:
- `pnpm test apps/service/src/ses/webhook-routes.test.ts apps/service/src/ses/process-event.test.ts apps/service/src/ses/routes.test.ts apps/service/src/services/email-transport-ses.test.ts apps/service/src/unsubscribe/routes.test.ts apps/service/src/sending/ses-lifecycle.integration.test.ts --testTimeout=20000` → passed, 6 files / 46 tests.
- `pnpm --filter @nusend/service typecheck` initially found a test helper type issue in `ses-lifecycle.integration.test.ts`; fixed by allowing Hono `fetch` to return `Response | Promise<Response>` and using `TestRuntime` explicitly.
- `pnpm --filter @nusend/service typecheck` → passed after fix.

Browser/manual verification: skipped; backend route/service/test changes only, no browser-visible UI change.

Deviations:
- Lifecycle test directly asserts DB delivery/job counts after the second mailing only through a small helper, as the plan allowed "if practical".

### Loop 4 update — Conditional phases

Status: Phase 10 implemented; Phase 9 deferred.

Phase 9 decision:
- Deferred structured log capture/redaction tests for now. Reason: implementing meaningful log capture would require shared test-layer logger injection and careful assertions across app/webhook/worker paths. Current core implementation already added substantial high-value coverage, and the plan explicitly made this phase conditional if it stayed localized. A superficial `sanitizedLogPath` unit test would not satisfy the phase's structured-log intent.

Phase 10 actions:
- Added queue runner stale-lease tests in `apps/service/src/queue/runner.test.ts` for both processor-success and processor-failure branches.
- Used a localized custom `EmailTransport` layer that closes over `Database`, mutates the claimed job's `locked_by` to `other_worker` during processing, and then succeeds or fails retryably.
- Asserted `skippedStale: 1`, no succeeded/failed increments, persisted `worker_runs.skipped_stale`, and non-terminal stolen lease state.

Verification run:
- `pnpm test apps/service/src/queue/runner.test.ts --testTimeout=20000` → passed, 1 file / 4 tests.
- `pnpm --filter @nusend/service typecheck` → passed.

Browser/manual verification: skipped; backend queue/test changes only, no browser-visible UI.

### Loop 4 review follow-up

Reviewer artifact: `.pi-subagents/artifacts/outputs/f6442744/implementation-review/core-test-phases-review.md`.

Findings:
- Blockers: none.
- Reviewer confirmed phases 3–8 match the plan and remain high-value/deterministic.
- Reviewer confirmed Phase 10 stale-lease tests are localized and deterministic.
- Reviewer agreed Phase 9 deferral is reasonable because meaningful structured log capture would require broader shared test-layer logger work, while a superficial unit test would not satisfy the phase intent.

No code changes required from this review.

### Loop 5 update — Final validation before final review

Status: Final validation passed; final independent review pending.

Validation run:
- `pnpm test --testTimeout=20000` → passed, 49 files / 315 tests.
- First `pnpm check` attempt failed format check for three edited TS files; ran targeted `pnpm exec oxfmt --write apps/service/src/queue/runner.test.ts apps/service/src/ses/sns-verifier.test.ts apps/service/src/ses/sns-verifier.ts`.
- Second `pnpm check` passed format, lint, typecheck, and tests. Lint warnings are only the pre-existing `apps/service/src/main.integration.test.ts` `no-await-in-loop` warnings.
- A new `no-await-in-loop` warning in `apps/service/src/ses/sns-signature.ts` was fixed with a narrow `oxlint-disable-next-line` reason for sequential streaming reads, then `pnpm check` was rerun and passed.
- `git diff --check` → passed.
- `grep -R "sns-validator" apps/service/src package.json apps/service/package.json pnpm-lock.yaml || true` → no output.
- `pnpm why sns-validator || true` and `pnpm why @types/sns-validator || true` → no output.
- `git diff --cached --name-only` → no staged files.

Current deliberate deferral:
- Conditional Phase 9 remains deferred with rationale above.

### Final review result

Reviewer artifact: `.pi-subagents/artifacts/outputs/5514495e/implementation-review/final-review.md`.

Findings:
- Blockers: none.
- Reviewer confirmed phases 0–8 and conditional Phase 10 match the plan.
- Reviewer confirmed Phase 9 deferral is acceptable.
- Reviewer confirmed `sns-validator`/`@types/sns-validator` removal, first-party SNS verifier security checks, high-value test scope, and validation evidence.

No code changes required from final review.
