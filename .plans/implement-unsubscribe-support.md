# Implement Self-Managed Unsubscribe Support

**Status:** Reviewed with Claude (`claude-fable-5`, high effort); review findings incorporated.

## Implementation Progress

- [x] 2026-07-08: Read full plan before editing; selected feature/build loops with targeted tests plus final `pnpm check`.
- [x] 2026-07-08: Started read-only scout subagent for implementation map; no code changes delegated yet.
- [x] Loop 1: config/service/token/URL foundation.
  - Added unsubscribe config parsing, service/layers, test runtime defaults, HMAC token signing/verification, and URL builder.
  - Verification: `pnpm test -- apps/service/src/config.test.ts apps/service/src/unsubscribe/token.test.ts apps/service/src/unsubscribe/url.test.ts` passed (Vitest reported 28 files / 183 tests due project filtering behavior).
  - Independent review: Claude session `0323a340-d820-405a-a308-cfdc1c1ad1aa` found a typecheck break in `app.test.ts` and missing signed-malformed-payload tests. Fixed both; follow-up review confirmed resolved.
  - Follow-up verification: `pnpm --filter @nusend/service typecheck` passed; targeted Vitest command including `app.test.ts` passed (28 files / 184 tests).
- [x] Loop 2: mailing creation compliance gate and render/prepare headers.
  - Added marketing creation gates for unsubscribe config and `{{ unsubscribe.url }}` HTML placeholder, renderer support for `unsubscribe.url`, rendered URL propagation, and RFC 8058 headers in prepared marketing email.
  - Decision/deviation: did not enforce `NUSEND_SES_MARKETING_CONFIGURATION_SET` at creation yet to avoid making the web runtime depend on SES sending config; send-time config-set enforcement remains planned.
  - Verification: `pnpm --filter @nusend/service typecheck` passed; `pnpm test -- apps/service/src/sending/render.test.ts apps/service/src/sending/prepare.test.ts apps/service/src/mailings/routes.test.ts` passed (30 files / 193 tests).
  - Independent review: Claude session `0b1b1532-9cb6-4e24-872d-2fcc5c3878c1` flagged missing-config policy ordering for Loop 3, base-URL query/fragment fragility, and a missing prepare guard test. Fixed query/fragment rejection plus test and prepare guard test; follow-up review confirmed resolved/deferred appropriately.
  - Follow-up verification: `pnpm --filter @nusend/service typecheck` passed; `pnpm test -- apps/service/src/config.test.ts apps/service/src/sending/prepare.test.ts` passed (30 files / 195 tests).
- [x] Loop 3: send-time policy gates and process retry/suppress behavior.
  - Replaced blanket marketing block with retryable missing unsubscribe-config/config-set gates, send-time suppression checks for transactional vs marketing scopes, and processor handling for retryable policy failures.
  - Added coverage for missing unsubscribe config retry, missing SES marketing config-set retry, marketing success with headers, and post-create unsubscribe suppression.
  - Verification: `pnpm --filter @nusend/service typecheck` passed; `pnpm test -- apps/service/src/sending/process-delivery.test.ts` passed (30 files / 198 tests).
  - Independent review: Claude session `737bf92f-6568-49a7-a6ba-fe31a5e23595` confirmed retryable config ordering and requested extra suppression-branch tests plus URL-build failure hardening. Added both; follow-up review confirmed no blockers.
  - Follow-up verification: `pnpm --filter @nusend/service typecheck` passed; `pnpm test -- apps/service/src/sending/process-delivery.test.ts` passed (30 files / 202 tests).
- [x] Loop 4: unsubscribe persistence and public routes.
  - Added token inspection/unsubscribe persistence, idempotent marketing suppression insert, optional list-membership timestamp update, public GET/POST unsubscribe routes, and dedicated HTML route runner.
  - Added route coverage for GET no-mutation, invalid/stale links, one-click URL-encoded + multipart bodies, human confirmation, garbage rejection/no redirect; added persistence coverage for idempotency, case-insensitive suppression uniqueness, list membership update, transactional no-op, invalid/expired results.
  - Updated driver parity to exercise the new SQLite partial-index `ON CONFLICT ... WHERE ... DO NOTHING` statement under both drivers.
  - Verification: `pnpm --filter @nusend/service typecheck` passed; `pnpm test -- apps/service/src/unsubscribe/unsubscribe.test.ts apps/service/src/unsubscribe/routes.test.ts` passed (32 files / 210 tests); `pnpm test -- apps/service/src/unsubscribe apps/service/src/db/driver-parity.test.ts` passed (32 files / 210 tests).
  - Independent review: Claude session `3cc293b6-3a47-4a07-aaf1-a65c50768f36` confirmed core correctness and suggested privacy headers, honest non-marketing messaging, empty POST coverage, and invalid-token no-write assertion. Fixed all; follow-up review confirmed no blockers.
  - Follow-up verification: `pnpm --filter @nusend/service typecheck` passed; `pnpm test -- apps/service/src/unsubscribe/unsubscribe.test.ts apps/service/src/unsubscribe/routes.test.ts` passed (32 files / 210 tests).
- [x] Loop 5: integration/fake workflow coverage and docs.
  - Added fake marketing workflow coverage from API create through fake worker and operations detail, including unsubscribe headers/rendered URL.
  - Updated `PROJECT.md` and `README.md` to reflect implemented unsubscribe support, env vars, 13-month delivery retention, and remaining live SES/Gmail DKIM + bounce/complaint ingestion gates before real marketing volume.
  - Formatted targeted changed files with `pnpm exec oxfmt --write ...`.
  - Verification: `pnpm --filter @nusend/service typecheck` passed; targeted workflow/mailings/unsubscribe/driver-parity test command passed (32 files / 211 tests).
- [x] Full validation: initial `pnpm check` found one formatting issue in `apps/service/src/sending/policy.ts`; after `pnpm exec oxfmt --write apps/service/src/sending/policy.ts`, `pnpm check` passed (format, lint with pre-existing warnings in `main.integration.test.ts`, typecheck, 32 files / 211 tests).
- [x] Final independent review: Claude session `0c62226c-50b0-4cb3-9790-282e0fc999cc` found no blockers, suggested adding marketing retry/dead-job monitoring docs, and mistakenly flagged an already-escaped regex. Added monitoring docs, reran `pnpm check`, and follow-up review confirmed no material blockers.
- [x] Post-review feedback fixes: reconciled conformance docs, hardened public base URL validation, switched unsubscribe token payload decoding to Schema, removed signer config footgun, shared HTML escaping helper, deduplicated list/contact test fixture, documented non-persisted unsubscribe source, checked suppressions before config gates, renamed `wroteSuppression`, added config-absent route coverage, masked GET confirmation email, and fixed idempotent replay-before-compliance behavior.
- [x] Final independent review complete.

Notes:

- No human checkpoint required up front: plan gives decisions/recommendations; actions are local code/tests only.
- Deviation candidates will be recorded here before/after implementation if required.

## Summary

Implement Nusend-owned unsubscribe support so marketing mailings can be safely unblocked without moving subscription state into Amazon SES. The milestone adds RFC 8058 one-click unsubscribe headers, a required marketing unsubscribe template placeholder, signed public unsubscribe routes, idempotent local suppression writes, and send-time policy gates that prevent already-queued deliveries from sending after a recipient unsubscribes.

This milestone unblocks the application-level marketing send path only when compliance config is present. Before real marketing volume, perform live SES/Gmail DKIM verification and implement SES bounce/complaint ingestion.

## Confirmed requirements and assumptions

- Marketing SES sending remains blocked until unsubscribe compliance is implemented and configured.
- Transactional sending remains independent of marketing unsubscribe state; transactional sends honor only global `scope='all'` suppressions.
- Nusend keeps unsubscribe truth in local SQLite tables rather than SES managed contact lists.
- `EmailTransport` stays purpose-agnostic; marketing-specific unsubscribe behavior belongs in route/render/prepare/policy layers.
- Unsubscribe tokens must not expose email addresses or list names in URLs.
- GET unsubscribe links must not mutate state because link scanners/prefetchers may fetch them.
- POST one-click unsubscribe is unauthenticated, does not rely on cookies/session/context, and never redirects.
- Public unsubscribe URLs used in email headers must be HTTPS.
- Delivery rows must be retained long enough for old unsubscribe links to remain usable; target retention floor: at least 13 months.

## Research findings

- AWS SES v2 `SendEmail` Simple mode supports custom headers via `Content.Simple.Headers`; `List-Unsubscribe` and `List-Unsubscribe-Post` do not require raw MIME in the current transport.
  - https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
- SES `ListManagementOptions` can manage unsubscribe state, but would create a second source of truth outside Nusend's SQLite contacts/lists/suppressions.
  - https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html
- RFC 8058 requires one HTTPS URI in `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, a POST target that can complete unsubscribe from URI data alone, no cookie/auth/context reliance, hard-to-forge URI data, no POST redirects, and DKIM coverage for unsubscribe headers.
  - https://www.rfc-editor.org/rfc/rfc8058.html
- Gmail requires one-click unsubscribe for marketing/promotional mail, not transactional mail; body/mailto links alone do not satisfy one-click; unsubscribe requests should be honored within 48 hours.
  - https://support.google.com/a/answer/14229414

## Current-state findings

- `apps/service/src/sending/policy.ts` currently blocks all marketing sends with `Marketing sending requires unsubscribe support.`
- `apps/service/src/mailings/create-mailing.ts` already filters suppressions at creation:
  - marketing: `scope IN ('all', 'marketing') OR (scope = 'list' AND list_id = $listId)`
  - transactional: `scope = 'all'`
  - list recipient resolution excludes `list_memberships.unsubscribed_at IS NOT NULL`.
- Send-time policy currently only checks global suppressions; this must change or queued deliveries can send after an unsubscribe.
- `PreparedEmail.headers` exists in `apps/service/src/services/email-transport.ts`.
- `apps/service/src/services/email-transport-ses.ts` maps headers to SES `Content.Simple.Headers` and validates custom headers.
- SES tests already prove `List-Unsubscribe` and `List-Unsubscribe-Post` headers are accepted.
- Rendering in `apps/service/src/sending/render.ts` currently supports `{{ user.email }}` and `{{ vars.* }}` only.
- The send pipeline in `apps/service/src/sending/process-delivery.ts` is: load context → start attempt → policy → render → prepare → transport.
- Public routes are wired in `apps/service/src/app.ts`; authenticated API routes live under `/api/*`.
- `runRoute` in `apps/service/src/http/respond.ts` is the HTTP Effect run boundary; public HTML unsubscribe responses should not pollute the JSON API error envelope contract.

## Chosen strategy

Use self-managed, delivery-token-based unsubscribe:

- Add optional unsubscribe config loaded by both web app and send worker.
- Generate signed tokens from `{ v: 1, d: deliveryId }` only.
- Resolve email/contact/mailing/list from the DB at unsubscribe time.
- Add public `GET` and `POST` unsubscribe routes.
- For initial one-click and confirmation behavior, unsubscribe from **all marketing** (`scope='marketing'`) rather than only the originating list. This is more conservative for deliverability and avoids recipients continuing to receive other marketing lists after pressing a generic “Unsubscribe” control.
- For list-originated deliveries, optionally also mark the originating membership `unsubscribed_at` as secondary state, but enforcement is via `scope='marketing'`.
- Generate one-click headers during marketing preparation.
- Require marketing templates to include `{{ unsubscribe.url }}` and fail creation/preparation otherwise.
- Replace the blanket marketing block with config/compliance gates plus send-time suppression checks.

## Alternatives considered

### SES `ListManagementOptions`

Rejected for now. It reduces route/token code, but creates an SES-side source of truth, is hard to test in fake workflows, and conflicts with Nusend's existing suppression scopes and operations model.

### List-scoped one-click unsubscribe

Rejected for the initial one-click path. It is narrower, but a recipient who clicks a generic email-client “Unsubscribe” button can still receive other marketing lists, increasing spam-report risk. A future preference center can offer “this list only” vs “all marketing”.

### Token payload with email/list/mailing claims

Rejected. It leaks or exposes decodable PII in URLs/logs and can diverge from DB truth. Delivery ID lookup keeps the token small and opaque.

### Aggressive token expiry

Rejected. Old emails should keep working for unsubscribe. Use long delivery retention and current+previous secret verification instead.

### Auto-appended HTML footer

Rejected for the initial implementation. It is brittle with arbitrary HTML. Explicit `{{ unsubscribe.url }}` is more predictable and testable.

## Implementation tasks

### 1. Add unsubscribe config and service

Likely files:

- `apps/service/src/config.ts`
- `apps/service/src/config.test.ts`
- new `apps/service/src/unsubscribe/config.ts` or `apps/service/src/services/unsubscribe-config.ts`
- `apps/service/src/main.ts`
- `apps/service/src/sending/worker-main.ts`
- `apps/service/src/testing/layers.ts`

Tasks:

1. Add `unsubscribeConfig: Effect.Effect<Option.Option<UnsubscribeConfig>, Config.ConfigError>`.
2. Env vars:
   - `NUSEND_PUBLIC_BASE_URL`
   - `NUSEND_UNSUBSCRIBE_SECRET`
   - optional `NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET`
3. All-or-nothing semantics:
   - no base URL and no current secret => `Option.none()`.
   - exactly one required value set => hard config error.
   - both set => `Option.some(...)`.
4. Validate:
   - public base URL is absolute HTTPS. Do not rely on `NODE_ENV`; RFC/Gmail header URLs need HTTPS regardless.
   - strip trailing slash for canonical URL construction.
   - current and previous secrets are at least 32 chars.
   - previous secret differs from current secret.
5. Use `Redacted` for secrets.
6. Add a Context service/layer that always exists and contains `Option.Option<UnsubscribeConfig>` so transactional-only deployments can start without unsubscribe env.
7. Wire the layer into web app runtime and send worker runtime.
8. Update test runtime helpers with configurable fake unsubscribe config.

Acceptance checks:

- Tests cover missing, partial, invalid URL, HTTP URL rejection, short secret, previous=current rejection, previous-secret support, and valid config.
- App/worker still start in transactional-only test mode with `Option.none()`.

### 2. Add token signing and verification

Likely files:

- new `apps/service/src/unsubscribe/token.ts`
- new `apps/service/src/unsubscribe/token.test.ts`

Tasks:

1. Define payload:
   ```ts
   type UnsubscribeTokenPayload = { v: 1; d: string };
   ```
2. Token format:
   ```txt
   base64url(JSON payload).base64url(HMAC-SHA256(payloadPart, secret))
   ```
3. Implement signing with current secret and verification against current then previous secret.
4. Verify HMAC before any DB lookup.
5. Use `crypto.createHmac("sha256", secret)` and `crypto.timingSafeEqual`.
6. Handle signature length explicitly before `timingSafeEqual`; unequal length is an invalid signature, not a defect path.
7. Enforce max token length, exactly two dot-separated parts, valid JSON object, `v === 1`, and bounded non-empty delivery ID string.
8. Do not add expiry.

Acceptance checks:

- Round trip succeeds.
- Tampered payload/signature fails.
- Truncated/malformed tokens fail.
- Wrong secret fails.
- Previous secret verifies old tokens.
- Current secret signs new tokens.
- Signature-length mismatch is tested and does not throw through to a route defect.

### 3. Add unsubscribe URL builder

Likely files:

- new `apps/service/src/unsubscribe/url.ts` or combined unsubscribe service
- related unit tests

Tasks:

1. Implement `buildUnsubscribeUrl(deliveryId: string)`:
   - requires configured unsubscribe service.
   - signs delivery ID.
   - returns `${publicBaseUrl}/unsubscribe/${token}`.
2. Use path-segment tokens, not query strings.
3. Ensure generated URLs contain no email address and are safe for SES header values.

Acceptance checks:

- URL uses canonical base without duplicate slashes.
- URL is HTTPS.
- Token verifies back to delivery ID.

### 4. Gate marketing mailing creation for compliance UX

Likely files:

- `apps/service/src/mailings/routes.ts`
- `apps/service/src/mailings/schema.ts` if adding helper validation
- `apps/service/src/mailings/routes.test.ts`
- `apps/service/src/http/respond.ts` if route dependencies change

Tasks:

1. Before `createMailingIdempotent`, reject marketing mailings when unsubscribe config is absent.
2. Reject marketing mailing creation when HTML template does not include the `unsubscribe.url` placeholder.
   - This is a UX/preventative gate, not the only safety check.
3. Keep send-time gates authoritative because jobs can be seeded, scheduled, or affected by later config changes.
4. Decide if `NUSEND_SES_MARKETING_CONFIGURATION_SET` should also be required at creation. Recommendation: yes, because SES event routing/observability will depend on it.

Acceptance checks:

- Marketing create request without unsubscribe config returns 400/422 with a clear error.
- Marketing create request missing `{{ unsubscribe.url }}` returns 400/422.
- Transactional create requests do not require unsubscribe config or placeholder.
- Idempotency behavior remains correct for rejected requests.

### 5. Extend rendering with `unsubscribe.url`

Likely files:

- `apps/service/src/sending/render.ts`
- `apps/service/src/sending/schema.ts`
- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/sending/render.test.ts`

Tasks:

1. Add `unsubscribe.url` to the render model for marketing deliveries.
2. Prefer keeping `render.ts` pure by passing `unsubscribeUrl` explicitly, e.g. `renderDeliveryEmail(context, { unsubscribeUrl })`.
3. Update `RenderedEmail` to include `unsubscribeUrl: string | null`.
4. Transactional templates using `unsubscribe.url` should fail as unsupported.
5. Preserve existing HTML escaping.
6. Add a code comment that the later `html.includes(unsubscribeUrl)` check assumes path-token URLs without query parameters.

Acceptance checks:

- Existing placeholders still work.
- Marketing HTML can render `<a href="{{ unsubscribe.url }}">Unsubscribe</a>`.
- Transactional use of `unsubscribe.url` fails.
- Missing unsubscribe config for marketing fails before transport send.

### 6. Add marketing headers and rendered-link checks in preparation

Likely files:

- `apps/service/src/sending/prepare.ts`
- `apps/service/src/sending/prepare.test.ts`
- `apps/service/src/sending/process-delivery.test.ts`

Tasks:

1. For marketing mailings:
   - require `rendered.unsubscribeUrl !== null`.
   - require `rendered.html.includes(rendered.unsubscribeUrl)`.
   - document that this verifies URL presence, not perfect visual visibility; stronger HTML visibility checks can be future work.
2. Add headers:
   ```ts
   "List-Unsubscribe": `<${unsubscribeUrl}>`
   "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
   ```
3. Transactional mailings get no unsubscribe headers.
4. Keep `EmailTransport` unchanged.
5. Continue relying on SES transport header validation; add local CR/LF/length assertions only if it keeps error messages closer to the preparation failure.

Acceptance checks:

- Marketing prepared email has both headers.
- Transactional prepared email has no unsubscribe headers.
- Marketing preparation fails when rendered HTML lacks the generated URL.
- SES transport tests still pass.

### 7. Update send-time policy gates

Likely files:

- `apps/service/src/sending/policy.ts`
- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/queue/runner.ts` type dependencies if needed
- related process/worker/fake workflow tests

Tasks:

1. Replace the blanket marketing block with:
   - missing unsubscribe config => retryable infrastructure/compliance failure, not permanent recipient failure.
   - recipient suppression => permanent `suppressed` delivery status.
2. Extend policy decisions if needed, e.g. `Allow | BlockPermanent | BlockRetryable`.
3. For missing config at send time:
   - record retryable failure with delivery status reset to `queued`.
   - fail the processor so the queue job is retried by existing backoff.
   - This protects against an ops mistake permanently killing a mailing.
4. For recipient suppression at send time:
   - transactional checks `scope='all'`.
   - marketing checks:
     ```sql
     scope IN ('all', 'marketing')
     OR (scope = 'list' AND list_id = $listId)
     ```
5. Keep `scope='list'` checks because legacy/future list-specific suppressions can still exist.
6. Optionally require marketing configuration set presence in this policy gate as retryable/misconfiguration until the env is fixed.

Acceptance checks:

- Transactional suppression behavior remains unchanged.
- Marketing without unsubscribe config is retried, not permanently failed.
- Marketing with config and no suppression is allowed.
- Marketing with global/marketing/list suppression is marked `suppressed` and not sent.
- Unsubscribe after creation but before worker processing prevents the send.

### 8. Add unsubscribe persistence logic

Likely files:

- new `apps/service/src/unsubscribe/unsubscribe.ts`
- new `apps/service/src/unsubscribe/unsubscribe.test.ts`

Tasks:

1. Implement an Effect function such as `unsubscribeByToken(token, source)`:
   - verify token.
   - load delivery + mailing context by delivery ID.
   - invalid signature/malformed token => invalid-token result.
   - valid token but missing delivery => expired-link result; do not fake success.
   - non-marketing delivery => success without suppression write.
   - marketing delivery => write suppression state.
2. Initial suppression behavior:
   - Insert `scope='marketing'`, `list_id=NULL`, `reason='unsubscribe'` for the delivery email.
   - For list-originated deliveries with a known/resolved contact, optionally also set the originating `list_memberships.unsubscribed_at` as secondary state.
3. Use a DB transaction for suppression insert + membership update.
4. Use `currentIso` for timestamps.
5. Use precise SQLite conflict handling, not `INSERT OR IGNORE`:
   - for marketing/global rows, target the partial unique index with `ON CONFLICT (email, scope) WHERE list_id IS NULL DO NOTHING`.
   - for any list-specific writes, target `ON CONFLICT (email, list_id) WHERE scope = 'list' DO NOTHING`.
   - This ensures CHECK constraint bugs are not silently ignored.
6. If `delivery.contact_id` is null and a membership update is needed, look up contact by email.
7. Do not delete jobs/deliveries; send-time policy gates suppress pending jobs when they run.

Acceptance checks:

- Marketing unsubscribe writes one marketing suppression.
- Optional list membership timestamp update works for list-originated delivery.
- Double unsubscribe is idempotent.
- Same email with different case respects NOCASE uniqueness.
- Transactional token does not create marketing suppression.
- Valid token with deleted delivery returns expired-link result.
- Invalid token writes nothing.

### 9. Add public unsubscribe routes

Likely files:

- new `apps/service/src/unsubscribe/routes.ts`
- new `apps/service/src/unsubscribe/routes.test.ts`
- `apps/service/src/app.ts`
- `apps/service/src/http/respond.ts`

Routes:

- `GET /unsubscribe/:token`
  - Verify token and load delivery context enough to render a confirmation page.
  - Never mutate state.
  - Valid token + missing delivery returns an honest expired-link HTML response, e.g. `410 Gone`.
  - Invalid token returns generic `404` HTML.

- `POST /unsubscribe/:token`
  - Accept one-click body in URL-encoded or multipart form: `List-Unsubscribe=One-Click`.
  - Accept human confirmation form field, e.g. `confirm=unsubscribe`.
  - Reject empty/garbage body with 400 and no mutation.
  - Never require auth/cookies/session/CSRF.
  - Never redirect.
  - Success returns `200` HTML/text.
  - Invalid token returns generic `404` HTML.
  - Valid token + missing delivery returns `410 Gone` HTML.

Tasks:

1. Mount routes in `app.ts` outside `/api/*` auth routes. `app.notFound()` is fallback-only; route registration order relative to `notFound` is not semantically important.
2. Add a small POST `bodyLimit`, e.g. 8 KiB.
3. Add a dedicated HTML route responder in `http/respond.ts` or a small helper that uses the existing runtime boundary. Do not reuse the JSON API `runRoute` envelopes for human unsubscribe pages.
4. Keep `Effect.run*` calls inside approved boundaries (`http/respond.ts`, tests, CLIs). If a new boundary is unavoidable, update the conformance gate documentation in `.plans/migrate-to-effect-v4-bun.md`.
5. Avoid logging full token paths.
6. Document that some security gateways may trigger RFC one-click POSTs; this is an accepted behavior of RFC 8058, not something the app can distinguish.

Acceptance checks:

- GET valid token returns confirmation HTML and writes nothing.
- GET invalid token returns generic 404 HTML.
- GET valid stale token returns 410/expired HTML.
- POST URL-encoded RFC body unsubscribes.
- POST multipart RFC body unsubscribes.
- POST human confirmation form unsubscribes.
- POST empty/garbage body does not mutate and returns 400.
- Double POST is idempotent.
- No POST response redirects.

### 10. Update fake workflow and integration coverage

Likely files:

- `apps/service/src/sending/fake-workflow.integration.test.ts`
- `apps/service/src/sending/process-delivery.test.ts`
- `apps/service/src/sending/worker.test.ts`
- `apps/service/src/mailings/routes.test.ts`
- `apps/service/src/app.test.ts`

Tests to add/adjust:

1. Marketing creation without unsubscribe config is rejected.
2. Marketing creation missing `{{ unsubscribe.url }}` is rejected.
3. Marketing worker without unsubscribe config retries rather than permanently failing delivery.
4. Marketing workflow with config and required placeholder sends via fake transport.
5. Captured fake email has both unsubscribe headers and rendered HTML contains the URL.
6. Transactional workflow still sends without unsubscribe config and has no unsubscribe headers.
7. Unsubscribe after creation before send suppresses the queued delivery.
8. Route tests cover GET no-mutation, POST body matrix, stale token, invalid token, idempotency, and case-insensitive email uniqueness.
9. Driver parity catches new SQLite `ON CONFLICT ... WHERE ... DO NOTHING` statements under both node:sqlite and bun:sqlite.

### 11. Update docs/project state

Likely files:

- `PROJECT.md`
- `.plans/migrate-to-effect-v4-bun.md` only if a new `Effect.run*` boundary is introduced

Tasks:

1. Mark unsubscribe routes/pages as implemented in `PROJECT.md` once done.
2. Note that marketing is still operationally gated pending live SES/Gmail DKIM verification and SES bounce/complaint ingestion.
3. Document env vars and the 13-month delivery retention requirement.
4. Document accepted limitation: `List-Unsubscribe` is HTTPS-only initially; no `mailto:` fallback or inbound unsubscribe processing in this milestone.

## Files/modules likely to change

Core config/services:

- `apps/service/src/config.ts`
- `apps/service/src/config.test.ts`
- `apps/service/src/main.ts`
- `apps/service/src/sending/worker-main.ts`
- new unsubscribe modules under `apps/service/src/unsubscribe/`

HTTP app:

- `apps/service/src/app.ts`
- `apps/service/src/http/respond.ts`
- new `apps/service/src/unsubscribe/routes.ts`
- new route tests

Mailing API:

- `apps/service/src/mailings/routes.ts`
- `apps/service/src/mailings/routes.test.ts`

Sending pipeline:

- `apps/service/src/sending/policy.ts`
- `apps/service/src/sending/render.ts`
- `apps/service/src/sending/prepare.ts`
- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/sending/schema.ts`
- possible `apps/service/src/queue/runner.ts` dependency type updates

Tests/helpers:

- `apps/service/src/testing/layers.ts`
- `apps/service/src/testing/email-transport.ts` if fake config shape changes
- sending/render/prepare/policy/process/worker/fake workflow tests

Docs:

- `PROJECT.md`
- `.plans/migrate-to-effect-v4-bun.md` only if boundary allow-list changes

## Data/schema changes

No migration is expected for the initial implementation.

Existing tables support the feature:

- `suppressions(scope, list_id, reason='unsubscribe')`
- `list_memberships.unsubscribed_at`
- `deliveries.email/contact_id/mailing_id`
- `mailings.purpose/list_id`

Future, out-of-scope schema additions:

- unsubscribe audit/event table
- preference center tables
- token/key-id table
- rate-limit tables

## API/interface changes

New public endpoints:

- `GET /unsubscribe/:token`
- `POST /unsubscribe/:token`

New template placeholder:

- `{{ unsubscribe.url }}` for marketing templates.

New env vars:

- `NUSEND_PUBLIC_BASE_URL`
- `NUSEND_UNSUBSCRIBE_SECRET`
- optional `NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET`

Changed behavior:

- Marketing mailing creation requires unsubscribe config and placeholder.
- Marketing sends require unsubscribe config and recipient not suppressed at send time.
- Marketing emails include RFC 8058 headers.
- Transactional emails remain independent of unsubscribe config and marketing/list suppressions.

## Testing and verification plan

Automated validation after implementation:

```sh
pnpm check
```

Automated test areas:

- config parsing
- token signing/verification
- URL builder
- render placeholder
- preparation/header behavior
- policy send-time suppression and retryable config failures
- unsubscribe persistence
- public routes
- fake workflow integration
- driver parity for new SQLite statements

Manual/local verification:

1. Start service with unsubscribe config using an HTTPS public base URL.
2. Create a marketing mailing containing `<a href="{{ unsubscribe.url }}">Unsubscribe</a>`.
3. Run worker once.
4. Inspect captured/prepared email for headers and visible URL.
5. Open GET unsubscribe page.
6. Submit POST confirmation.
7. Verify suppression row and any membership timestamp.
8. Verify a pending delivery for the same recipient is suppressed at send time.

Production go/no-go before real marketing volume:

1. Configure SES Easy DKIM and marketing configuration set.
2. Send one real marketing test to Gmail.
3. Inspect Gmail “Show original”:
   - `List-Unsubscribe` present.
   - `List-Unsubscribe-Post` present.
   - DKIM `h=` covers both unsubscribe headers.
4. Confirm Gmail recognizes one-click unsubscribe when eligible.
5. Confirm one-click POST writes local suppression.
6. Do not scale marketing traffic until SES bounce/complaint ingestion exists or an explicit risk decision is made.

## Rollout notes

- Deploy code with no unsubscribe env first if desired; marketing creation/send remains blocked or retrying.
- Configure HTTPS `NUSEND_PUBLIC_BASE_URL` and `NUSEND_UNSUBSCRIBE_SECRET` to enable the compliance path.
- Keep `NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET` during rotations so old emails continue to work.
- Retain delivery rows for at least 13 months.
- If delivery retention deletes old rows, valid old tokens should return an expired-link response rather than fake success.

## Risks and mitigations

### Already-queued sends after unsubscribe

Mitigation: send-time marketing suppression check in `runPolicyGates()`.

### Missing config killing mailings permanently

Mitigation: reject marketing creation when config is absent and treat send-time missing config as retryable, not permanent.

### Link scanners

Mitigation: GET never mutates. RFC one-click POSTs from security gateways may still unsubscribe; this is an accepted RFC 8058 tradeoff and cannot be distinguished reliably.

### Token leakage in logs

Mitigation: token contains only signed delivery ID; avoid logging full paths/tokens.

### PII in tokens

Mitigation: payload contains no email/list data.

### DKIM header coverage uncertainty

Mitigation: make live SES/Gmail DKIM inspection a go/no-go before real marketing traffic. If SES Simple/Easy DKIM does not cover custom headers, plan raw MIME fallback.

### Missing bounce/complaint ingestion

Mitigation: schedule SES event ingestion immediately after this milestone and avoid real volume before it lands.

### Public unauthenticated mutating endpoint

Mitigation: verify HMAC before DB lookup, reject malformed bodies, keep tokens high entropy through HMAC secret, and consider per-IP rate limiting as follow-up if traffic appears.

### Secret rotation

Mitigation: support current + previous secret and avoid token expiry.

### Mid-send race

Mitigation: accepted small race window; policy check happens shortly before transport send.

## Non-goals

- SES bounce/complaint event ingestion.
- Preference center or “this list only” choice UI.
- Inbound `mailto:` unsubscribe processing.
- `mailto:` fallback in `List-Unsubscribe` header.
- Contact/list management APIs.
- Raw MIME SES sending unless live DKIM verification proves it necessary.
- Rate-limit infrastructure unless already available.
- Full unsubscribe audit/event table.

## Remaining open decisions

1. **Marketing configuration set requirement:** Recommendation: require `NUSEND_SES_MARKETING_CONFIGURATION_SET` before marketing creation/send, because SES event ingestion and observability will depend on it.
2. **Text-part unsubscribe URL:** Recommendation: require HTML URL for this milestone; document that text bodies should include it when present, but do not block initial implementation on text enforcement.
