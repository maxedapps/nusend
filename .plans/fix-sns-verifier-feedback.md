# Fix SNS Verifier Feedback

## Summary

Fix the production-breaking SNS signature canonicalization bug and apply the small hardening/test-polish items surfaced by independent feedback on `.plans/add-high-value-test-coverage.md` implementation.

The critical change is to align Nusend’s first-party SNS string-to-sign builder with AWS’s working validator implementations: append `\n` after every signed field value, including the final `Type` value. The current verifier omits that final newline, and its positive test signs using the same helper, so the test suite proves internal consistency but not AWS interoperability.

## Requirements

- Fix SNS canonical string construction to match AWS SNS validator implementations.
- Restructure verifier tests so positive signatures are generated from an independent test canonicalizer, not from production `buildSnsStringToSign()`.
- Keep tests deterministic/offline; no real AWS/SNS/SES/network calls in the default suite.
- Preserve the first-party verifier service boundary and Effect v4 style.
- Keep SignatureVersion 2-only policy unless explicitly revisited later.
- Preserve existing public route/API behavior except for safe earlier rejection of unallowlisted SNS topics.
- Apply low-risk hardening/polish surfaced by feedback:
  - exact HTTP 200 for cert fetch;
  - cancel cert stream reader on oversize;
  - precheck unverified TopicArn allowlist before verifier/cert fetch;
  - assert fake worker message id in lifecycle test;
  - make fake SNS fixtures SigV2-looking;
  - remove dead lifecycle assertion.

## Non-goals

- Do not reintroduce `sns-validator` as a dependency.
- Do not add live AWS tests to the default suite.
- Do not broaden unrelated CRUD coverage.
- Do not implement generic certificate caching unless it is tiny and clearly local; caching is not required to fix the reported bug.
- Do not speculatively accept `Subject: null` unless supported by captured real SNS evidence or a product decision.
- Do not change DB schema, public API response schemas, or SES event semantics.

## Evidence and current-state findings

### External evidence

Primary/near-primary sources checked:

- AWS JS SNS validator source (`aws-js-sns-message-validator`, same lineage as removed `sns-validator`) at commit `a6ba4d646dc60912653357660301f3b25f94d686`: `verifier.update(key + "\n" + message[key] + "\n", encoding)` for every signed key. Permalink: <https://github.com/aws/aws-js-sns-message-validator/blob/a6ba4d646dc60912653357660301f3b25f94d686/index.js>
- AWS PHP SNS `MessageValidator::getStringToSign()` at commit `01f104920423c9b7c0a13dbe5115cc4cbc808161`: appends `"{$key}\n{$message[$key]}\n"` for every included key. Permalink: <https://github.com/aws/aws-php-sns-message-validator/blob/01f104920423c9b7c0a13dbe5115cc4cbc808161/src/MessageValidator.php>
- AWS SNS docs page `sns-verify-signature-of-message-verify-message-signature.html`: <https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html>. It contains contradictory prose (“Do not add a newline character at the end of the string”), but its shell examples pipe/redirect strings in ways that append a final newline. Prefer working AWS validator implementations over the contradictory prose.

Conclusion: canonical strings should include a trailing newline after the final signed field value.

### Local code findings

- `apps/service/src/ses/sns-signature.ts`
  - `buildSnsStringToSign()` currently uses `fields.flatMap(...).join("\n")`, which omits trailing newline.
  - `fetchSigningCertificate()` uses `response.ok`, accepting 2xx instead of the plan’s exact 200.
  - `readLimitedResponseText()` throws on oversize but does not call `reader.cancel()`.
- `apps/service/src/ses/sns-verifier.test.ts`
  - `signedEnvelope()` signs with production `buildSnsStringToSign()`, so canonicalization bugs self-cancel.
  - Exact canonical string expectations currently omit trailing newline.
- `apps/service/src/ses/process-event.ts`
  - Flow is: config disabled check → decode unverified shape → verifier/cert fetch/signature check → allowlist TopicArn. This means public requests can force a bounded SNS cert fetch before allowlist rejection.
- `apps/service/src/sending/ses-lifecycle.integration.test.ts`
  - Bounce fixture uses fake verifier and has `SignatureVersion: "1"` plus `/cert.pem`, which is harmless but confusing after SigV2-only production verifier.
  - Test uses `fake-message-1` in the bounce and event assertion but does not directly assert that the worker/fake transport produced that message id.
  - `expect(contact.body.contact.id).toBeTruthy()` is low-signal dead weight.
- `apps/service/src/ses/webhook-routes.test.ts` and `apps/service/src/ses/process-event.test.ts`
  - Fixtures use fake verifiers and currently contain v1-ish/cert.pem values in some places. These can be made v2-looking without changing test semantics.

## Chosen strategy

Implement a focused compatibility/hardening patch:

1. Correct canonical string generation and tests first.
2. Harden cert fetch and allowlist rejection next.
3. Polish confusing fixtures and lifecycle assertion last.
4. Run targeted verifier/webhook/lifecycle tests, then full validation.
5. Request independent review focused on SNS interoperability and regression risk.

This keeps the patch small, avoids dependency reintroduction, and directly addresses the production-breaking issue.

## Implementation Progress

Tracker path: `.plans/fix-sns-verifier-feedback.md` (this section).

### Initial setup — 2026-07-09

- Status: in progress.
- Goal: implement this plan exactly, preserving the existing first-party SNS verifier boundary and Effect v4 style.
- Loop type: bug/security compatibility fix plus focused hardening/test polish.
- Subagent decomposition decision:
  - Use read-only subagents for codebase/context scouting and independent reviews.
  - Keep implementation single-writer in the main worktree because Phases 1–4 are tightly coupled and security-sensitive; avoid concurrent writers.
  - Candidate reviews: SNS canonicalization/cert hardening after Phases 1–3; route/lifecycle behavior after Phases 4–5; final full-diff review.
- Planned verification:
  - Targeted verifier tests after Phases 1–3.
  - Targeted webhook/process and lifecycle tests after Phases 4–5.
  - Service typecheck, full tests/checks, `git diff --check`, dependency absence checks, and staged-file check at final validation.
- Browser/manual verification: skipped; this plan changes backend SNS webhook verification/tests only, with no UI/browser-visible behavior.
- Human checkpoints: none currently needed; scope and exact plan path were provided by the user, and no production credentials/actions are required.
- Current repository state note: working tree already contains uncommitted/untracked files from prior work; implementation will preserve unrelated existing changes and use diffs carefully.

### Loop 1 — Phases 1–3 canonicalization, independent signatures, cert hardening — 2026-07-09

- Status: implemented; targeted verification passed; review requested.
- Analyze: inspected `apps/service/src/ses/sns-signature.ts`, `apps/service/src/ses/sns-verifier.test.ts`, and scout findings from `45c4df87-b966-4d31-8d85-d5f4baa69064`.
- Plan: change production canonicalizer to append `\n` after every signed value, restructure tests to sign with an independent AWS-validator-style helper, require exact HTTP 200, and cancel oversize cert streams.
- Actions/files changed:
  - `apps/service/src/ses/sns-signature.ts`: switched string-to-sign builder to `${name}\n${value}\n`, changed cert fetch from `response.ok` to `response.status !== 200`, and cancel the stream reader before throwing on streamed oversize while preserving the intended error.
  - `apps/service/src/ses/sns-verifier.test.ts`: added independent `awsValidatorStyleStringToSign()`/field helpers for positive signatures, trailing-newline exact canonical assertions, a positive `Subject` crypto case, a 204 rejection check, and an observable stream-cancel assertion.
- Verification run:
  - `pnpm test apps/service/src/ses/sns-verifier.test.ts --testTimeout=20000` — passed (1 file, 24 tests).
- Browser/manual verification: skipped; backend verifier/cert-fetch logic only.
- Deviations: none.
- Review: step-specific read-only reviewer `a1095880-fde3-4730-b90c-20f9e77f790f` found no blockers. Notes: confirmation signatures are exact-string tested but not end-to-end signed; cancel-failure path not directly tested. No changes required for current acceptance.

### Loop 2 — Phases 4–5 allowlist precheck, fixture polish, lifecycle assertion — 2026-07-09

- Status: implemented; targeted verification passed; review requested.
- Analyze: inspected `handleSesSnsRequest()` flow, fake-verifier route/process fixtures, and lifecycle bounce flow. Precheck is safe only for early rejection; verified allowlist check remains as defense-in-depth.
- Plan: decode unverified envelope into a variable, reject unallowlisted `TopicArn` before `SnsMessageVerifier`, prove verifier is not called, make fake fixtures SigV2-looking, assert the worker-produced `ses_message_id`, and remove the low-signal lifecycle contact id assertion.
- Actions/files changed:
  - `apps/service/src/ses/process-event.ts`: added pre-verifier allowlist rejection using the decoded unverified `TopicArn`; retained post-verify allowlist check.
  - `apps/service/src/ses/webhook-routes.test.ts`: updated the unallowlisted-topic test to assert verifier calls stay at `0`; updated fake SNS fixtures to `SignatureVersion: "2"` and AWS-style cert URLs.
  - `apps/service/src/ses/process-event.test.ts`: updated fake SNS fixture to SigV2-looking values.
  - `apps/service/src/sending/ses-lifecycle.integration.test.ts`: queries `deliveries.ses_message_id` after worker send and asserts `fake-message-1` before constructing the bounce; removed dead `contact.body.contact.id` assertion; updated fake SNS fixture to SigV2-looking values.
- Verification run:
  - `pnpm test apps/service/src/ses/webhook-routes.test.ts apps/service/src/ses/process-event.test.ts --testTimeout=20000` — passed (2 files, 14 tests).
  - `pnpm test apps/service/src/sending/ses-lifecycle.integration.test.ts --testTimeout=20000` — passed (1 file, 1 test).
- Browser/manual verification: skipped; backend webhook/test-only changes, no UI/browser-visible behavior.
- Deviations: Phase 6 optional process-level real-verifier integration not implemented; Phase 2 independent verifier tests already exercise real verifier code with injected cert fetch, matching the plan’s decision rule without exporting/duplicating broader signing machinery.
- Review: step-specific read-only reviewer `8abf5589-d3b8-4ebc-9ad0-a6653c4bbcc2` found no blockers.

### Loop 3 — Typecheck cleanup and final validation/review — 2026-07-09

- Status: complete.
- Analyze: after Loop 2, service typecheck failed because the subscription-confirmation canonical test passed optional `envelope.SubscribeURL` / `envelope.Token` values into a strict string tuple.
- Plan: make those test values explicit constants, rerun verifier test and service typecheck, then run full validation and final independent review.
- Actions/files changed:
  - `apps/service/src/ses/sns-verifier.test.ts`: introduced local `subscribeUrl` and `token` constants for the canonical string expectation to satisfy TypeScript without casts.
- Verification run:
  - `pnpm --filter @nusend/service typecheck` — initially failed on optional `SubscribeURL`/`Token`; passed after the constants fix.
  - `pnpm test apps/service/src/ses/sns-verifier.test.ts --testTimeout=20000` — passed after the constants fix (1 file, 24 tests).
- Browser/manual verification: skipped; backend webhook/verifier logic only.
- Human checkpoints: none needed.
- Final validation run:
  - `pnpm test --testTimeout=20000` — passed (49 files, 316 tests).
  - `git diff --check` — passed.
  - `grep -R "sns-validator" apps/service/src package.json apps/service/package.json pnpm-lock.yaml || true` — no matches.
  - `pnpm why sns-validator || true` — no installed dependency output.
  - `pnpm why @types/sns-validator || true` — no installed dependency output.
  - `git diff --cached --name-only` — no staged files.
  - `pnpm check` — passed format/typecheck/tests; lint reported only the expected pre-existing `apps/service/src/main.integration.test.ts` `no-await-in-loop` warnings.
- Repository state note: working tree still includes pre-existing unrelated/package/test changes from prior work; plan-relevant implementation files are `apps/service/src/ses/sns-signature.ts`, `apps/service/src/ses/sns-verifier.test.ts`, `apps/service/src/ses/process-event.ts`, `apps/service/src/ses/webhook-routes.test.ts`, `apps/service/src/ses/process-event.test.ts`, `apps/service/src/sending/ses-lifecycle.integration.test.ts`, and this plan tracker.
- Review: final read-only independent reviewer `ac600cd1-7f49-4b50-b957-dd7b58a4ee5e` found no blockers. Optional note only: add an end-to-end signed `SubscriptionConfirmation` verifier test later if confirmation verification becomes higher-risk; current exact canonical confirmation tests plus signed Notification/Subject tests satisfy this plan.
- Post-tracker validation: `git diff --check && git diff --cached --name-only` passed after final tracker edits; no staged files.
- Final status: complete. All Definition of Done bullets met. No human checkpoint was needed.

## Alternatives considered

### Alternative A — Trust AWS docs prose and keep no trailing newline

Rejected. AWS validator source implementations append trailing newline and are stronger interoperability evidence than contradictory prose/examples.

### Alternative B — Reintroduce `sns-validator` only for canonicalization

Rejected. User explicitly required removing `sns-validator`. Also unnecessary: the canonicalization logic is small and now backed by independent tests.

### Alternative C — Add live AWS SNS staging test now

Deferred. Valuable for rollout confidence, but requires AWS setup/captured payloads and should not be part of deterministic default CI. Add as manual rollout validation if infrastructure is available.

### Alternative D — Implement certificate caching now

Deferred. It would reduce repeated cert fetches, but it is not required for correctness. Prechecking allowlist closes the bigger unauthenticated amplification gap. Add cache later if webhook volume warrants it.

## Implementation plan

### Phase 1 — Fix canonical string construction

Files:

- `apps/service/src/ses/sns-signature.ts`
- `apps/service/src/ses/sns-verifier.test.ts`

Tasks:

1. Change `buildSnsStringToSign()` from flattened `.join("\n")` to AWS-validator style:

   ```ts
   return fields.map(([name, value]) => `${name}\n${value}\n`).join("");
   ```

2. Keep existing field order:
   - `Notification`: `Message`, `MessageId`, optional `Subject`, `Timestamp`, `TopicArn`, `Type`.
   - `SubscriptionConfirmation` / `UnsubscribeConfirmation`: `Message`, `MessageId`, `SubscribeURL`, `Timestamp`, `Token`, `TopicArn`, `Type`.

3. Update exact canonical string tests to assert a trailing newline explicitly. Prefer literal strings or arrays mapped through a local test helper that clearly appends after every pair.

4. Add a short comment in the test or helper explaining why trailing newline is intentional despite ambiguous AWS docs prose: AWS JS/PHP validators append it.

Acceptance:

- Canonical string tests fail without trailing newline and pass with it.
- Existing missing confirmation-field tests still pass.

### Phase 2 — Make signature fixtures independent from production canonicalizer

Files:

- `apps/service/src/ses/sns-verifier.test.ts`

Tasks:

1. Replace `signedEnvelope()`’s call to production `buildSnsStringToSign()` with a test-only independent canonicalizer.
2. Keep the test canonicalizer intentionally simple and obviously derived from AWS validators:

   ```ts
   function awsValidatorStyleStringToSign(fields: readonly (readonly [string, string])[]): string {
     return fields.map(([name, value]) => `${name}\n${value}\n`).join("");
   }
   ```

3. For `signedEnvelope()`, avoid trying to reimplement all production branching. Either:
   - pass the canonical fields explicitly from each positive fixture; or
   - implement a minimal independent helper used only by the positive/tamper fixture, with clear comments and no import from `sns-signature.ts`.

Recommended shape:

```ts
const signed = signEnvelope(baseEnvelope, [
  ["Message", baseEnvelope.Message],
  ["MessageId", baseEnvelope.MessageId],
  ["Timestamp", baseEnvelope.Timestamp],
  ["TopicArn", baseEnvelope.TopicArn],
  ["Type", "Notification"],
]);
```

4. Keep negative tests for tampered message, unsupported version, invalid base64, malformed envelope.
5. Add a test that fails if production builder output differs from the independent AWS-validator-style expected string.
6. If cheap, add one more independent-signature positive case that includes `Subject` (or a confirmation envelope) so the cryptographic path covers more than the no-Subject notification fixture. Keep it small; exact-string tests remain the primary branch coverage.

Acceptance:

- Positive verifier test no longer signs via `buildSnsStringToSign()`.
- A future accidental removal of trailing newline breaks at least one exact-string test and at least one signature verification test.

### Phase 3 — Cert fetch hardening polish

Files:

- `apps/service/src/ses/sns-signature.ts`
- `apps/service/src/ses/sns-verifier.test.ts`

Tasks:

1. Replace `if (!response.ok)` with exact status check:

   ```ts
   if (response.status !== 200) throw new Error(...);
   ```

2. Update or add a test ensuring a non-200 2xx status (e.g. 204) maps to `SnsVerificationError`.
3. On streamed body oversize, call `await reader.cancel()` before throwing. Use a `try`/`finally` or local helper to avoid masking the intended oversize error.
4. Keep the existing `oxlint-disable-next-line no-await-in-loop` reason for sequential streaming reads; update wording if needed after cancel call.
5. If cancel behavior is easy to observe in Vitest with a custom `ReadableStream`, add a small assertion that `cancel()` is invoked on oversize. If brittle, skip explicit cancel assertion and rely on code review plus existing oversize test.

Acceptance:

- Cert fetch requires exact HTTP 200.
- Oversize stream still maps to `SnsVerificationError`.
- No unbounded buffering is introduced.

### Phase 4 — Precheck TopicArn allowlist before verifier/cert fetch

Files:

- `apps/service/src/ses/process-event.ts`
- `apps/service/src/ses/webhook-routes.test.ts`
- potentially `apps/service/src/ses/process-event.test.ts`

Tasks:

1. In `handleSesSnsRequest()` after `decodeUnverifiedSnsEnvelopeString(rawBody)`, store the unverified envelope:

   ```ts
   const unverified = yield* decodeUnverifiedSnsEnvelopeString(rawBody);
   ```

2. Check the unverified `TopicArn` against `settings.config.feedbackTopicArns` before fetching certificate:

   ```ts
   if (!settings.config.feedbackTopicArns.includes(unverified.TopicArn)) {
     return yield* Effect.fail(new SesOperationsForbiddenError({ reason: "SNS TopicArn is not allowlisted." }));
   }
   ```

3. Then call `verifier.verify(rawBody)` as before.
4. Keep, or optionally repeat, a defensive post-verify allowlist check on `verified.TopicArn`. Because the verified payload is parsed from the same raw body and schema, this is redundant, but keeping it is cheap defense-in-depth and avoids future refactor hazards.
5. Update/add a route test that proves verifier is not called for unallowlisted `TopicArn`:
   - inject a fake verifier that increments a counter or fails with a distinct error;
   - send unallowlisted topic;
   - assert `403`, no rows, and counter remains `0`.
6. Re-evaluate Phase 3 missing `SubscribeURL` route test semantics after this change. It still uses allowlisted topic and fake verifier, so it should remain a handler-level 500 defense-in-depth test.

Acceptance:

- Unallowlisted requests return 403 before cert fetch/verifier invocation.
- Existing verified allowlisted webhook paths still pass.
- No audit rows are written for unallowlisted requests.

### Phase 5 — Test fixture polish and lifecycle contract assertion

Files:

- `apps/service/src/sending/ses-lifecycle.integration.test.ts`
- `apps/service/src/ses/webhook-routes.test.ts`
- `apps/service/src/ses/process-event.test.ts`

Tasks:

1. In lifecycle test, directly assert the fake worker’s SES message id contract. Because fake transport records `PreparedEmail` but not `SendResult`, assert through DB after worker run:

   ```sql
   SELECT ses_message_id AS sesMessageId FROM deliveries WHERE id = $deliveryId;
   ```

   Then assert `sesMessageId === "fake-message-1"` before constructing bounce payload.

2. Remove `expect(contact.body.contact.id).toBeTruthy()` unless it is replaced with a meaningful assertion.
3. Change fake SNS fixtures that bypass real verification to be SigV2-looking:
   - `SignatureVersion: "2"`;
   - `SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem"`;
   - `Signature: "signature"` can remain fake where verifier is injected.
4. Do not over-expand fixture realism into real signatures for fake-verifier route tests; keep route tests focused on handler behavior.

Acceptance:

- Lifecycle test proves worker output `ses_message_id` is exactly what bounce webhook uses.
- Fake SNS envelopes no longer visually contradict the SigV2-only verifier policy.
- No new broad assertions or unrelated route coverage are added.

### Phase 6 — Optional local live-verifier integration test without network

This phase is optional but recommended if it stays small.

Possible target:

- `apps/service/src/ses/process-event.test.ts` or `apps/service/src/ses/sns-verifier.test.ts`

Goal:

- Close the “all HTTP/webhook tests use fake verifier” gap without real network.

Option A — Keep it in verifier tests:

- Already mostly covered by `makeSnsMessageVerifier({ fetchCertificate })` positive test. After Phase 2 independent signing, this may be enough.

Option B — Add process-level test:

- Use `runTest(handleSesSnsRequest(JSON.stringify(validSignedEnvelope)), { snsVerifier: (message) => makeSnsMessageVerifier({ fetchCertificate }).verify(message) })`.
- This still uses the fake layer injection seam but exercises `handleSesSnsRequest()` with the real verifier service implementation behavior.
- Keep one simple `Delivery` event and assert one row written.

Decision rule:

- Implement only if it takes a small helper reuse from verifier tests or local duplication remains minimal.
- If it requires exporting too much test-only signing machinery, skip and document that the verifier unit test covers the live service boundary with injected cert fetch.

Acceptance if implemented:

- No real network calls.
- Real verifier code path is exercised through the webhook handler.

## Validation plan

Run targeted tests after each phase or coherent group:

```sh
pnpm test apps/service/src/ses/sns-verifier.test.ts --testTimeout=20000
pnpm test apps/service/src/ses/webhook-routes.test.ts apps/service/src/ses/process-event.test.ts --testTimeout=20000
pnpm test apps/service/src/sending/ses-lifecycle.integration.test.ts --testTimeout=20000
```

Run service typecheck after signature/process changes:

```sh
pnpm --filter @nusend/service typecheck
```

Final validation:

```sh
pnpm test --testTimeout=20000
pnpm check
git diff --check
grep -R "sns-validator" apps/service/src package.json apps/service/package.json pnpm-lock.yaml || true
pnpm why sns-validator || true
pnpm why @types/sns-validator || true
git diff --cached --name-only
```

Expected lint state:

- `pnpm check` may still report the pre-existing `apps/service/src/main.integration.test.ts` `no-await-in-loop` warnings, but should introduce no new warnings.

## Manual/staging validation recommendation

Default CI should remain local/offline. Separately, before production rollout, perform one manual interoperability check if AWS access is available:

1. Subscribe a staging endpoint to an SNS topic with SignatureVersion 2.
2. Capture a `SubscriptionConfirmation` or `Notification` envelope without secrets/customer data.
3. Verify the new first-party verifier accepts that captured envelope with the AWS certificate fetch path enabled.
4. Confirm `Subject` shape in real payloads, especially whether absent vs explicit `null` occurs.

If no AWS staging is available, document that validation relied on AWS validator source compatibility plus offline crypto fixtures.

## Subagent/delegation opportunities for implementation

Recommended single-writer sequence for Phases 1–4:

- Canonicalization and verifier test changes are security-sensitive and tightly coupled; keep one writer.
- `process-event.ts` allowlist flow touches webhook behavior; keep sequential until targeted tests pass.

Safe parallel read-only review opportunities:

- Reviewer A: SNS canonicalization/security review after Phases 1–3.
- Reviewer B: Route/lifecycle test review after Phases 4–5.

Optional implementation split only with isolated worktrees:

- Worker 1: verifier canonicalization/cert-fetch tests.
- Worker 2: lifecycle fixture polish.

Avoid multiple writers in the same active worktree.

## Risks and mitigations

- **Docs/source conflict on trailing newline**: document the decision in tests/progress. Mitigate with independent canonical fixture and reviewer prompt that cites AWS JS/PHP validators.
- **Prechecking unverified TopicArn could look like trusting unauthenticated data**: use it only for early rejection, never acceptance. Still verify signature before processing any allowlisted message.
- **Keeping defensive post-verify allowlist check might duplicate logic**: duplication is intentional defense-in-depth and low cost.
- **Reader cancellation can mask oversize error**: avoid letting `cancel()` failure replace the intended error.
- **Over-realistic fixtures could bloat tests**: only make fake fixtures visually SigV2-looking; do not require real signatures outside verifier-focused tests.
- **Manual AWS validation may be unavailable**: not a blocker for deterministic CI, but should be noted before deployment.

## Definition of Done

- `buildSnsStringToSign()` includes trailing newline after every signed field value.
- Verifier success tests sign with independent AWS-validator-style canonicalization, not production helper reuse.
- Exact canonical string assertions include trailing newline.
- Certificate fetch requires HTTP 200 exactly and cancels oversize stream reads where practical.
- Unallowlisted SNS `TopicArn` is rejected before verifier/cert fetch; tests prove verifier is not called.
- Lifecycle test asserts the worker-produced SES message id used by bounce processing.
- Fake SNS fixtures are SigV2-looking where easy and no longer confusing.
- Targeted tests, full tests, `pnpm check`, and `git diff --check` pass.
- Independent review finds no blockers or remaining production-breaking SNS interoperability risks.
