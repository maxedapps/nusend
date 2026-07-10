# Fix All Review Findings: First-Class CLI, API Keys, Device Login

Date: 2026-07-09. Source review: `.reviews/add-first-class-cli-review.md` (including the addendum evaluating external feedback). Evidence: `.progress/add-first-class-cli-review.md`. Planning notes: `.progress/fix-cli-review-findings-plan.md`.

## Summary

Fix every issue — all priorities — found in the review of the `.plans/add-first-class-cli.md` implementation, plus the two scope additions the user confirmed:

1. Implement `GET /api/mailings` and `GET /api/mailings/:id` (the review flagged that `mailings:read` currently gates nothing) and read-only `nusend mailings list/get` CLI commands.
2. Extract CLI commands into `apps/cli/src/commands/*` modules (populating the empty scaffold directories) instead of keeping the 387-line monolithic `main.ts`.

The remaining domain command families (lists, suppressions, operations, SES CLI) stay deferred to a separate follow-up plan, per the user's answer.

## Confirmed requirements (user answers, 2026-07-09)

- Scope: all review fixes + mailings read API. **Not** the full Phase 11–13 backlog.
- CLI structure: extract command modules (`commands/`, `testing/` populated).
- Everything else in this plan uses vetoable defaults, labeled `Decision:` inline and collected under "Vetoable decisions".

## Research and evidence

All empirical checks were run in this planning session and recorded in `.progress/fix-cli-review-findings-plan.md`:

- **better-auth 1.6.23 sign-in mechanics** (installed source: `apps/service/node_modules/better-auth/dist/api/routes/sign-in.mjs`):
  - Only `POST /sign-in/social` exists; there is no `GET /sign-in/google`. Body: `{ provider, callbackURL?, disableRedirect?, ... }`.
  - It accepts **JSON only** (unlike `signInEmail`, which whitelists `application/x-www-form-urlencoded`; `signInSocial` has no `allowedMediaTypes`). A plain HTML `<form method="post">` will not work.
  - It responds `200 {"url": "...", "redirect": true}` (a `Location` header is set but the status is 200, so browsers will not follow it). The client must navigate to `url` itself → the fix requires a small inline script, not a form or link.
  - **Empirically proven offline** (bun script, in-memory DB with all 5 migrations applied, real `createAuth`): `POST /api/auth/sign-in/social` with `{provider:"google", callbackURL:"/cli/activate?code=ABCD-1234"}` → 200, `url` on `accounts.google.com`, `redirect_uri=http://localhost:3000/api/auth/callback/google`. Relative `callbackURL` is accepted, avoiding trusted-origin pitfalls. This also proves the planned integration test needs no Google credentials.
- **Activation brute-force surface is authenticated-only**: `inspect`/`approve`/`deny` all run behind a signed-in Better Auth session (`activate-routes.ts` checks the session before touching `DeviceAuthorizations`), which shapes the lockout design below.
- **Mailings module scout** (full findings in the planning progress note): authoritative schema is migration `0002` (`mailings` columns: `id, purpose, state('scheduled'|'sending'|'completed'), name, subject, html, text, list_id, scheduled_at, created_at, updated_at`; `deliveries` has `mailing_id` FK, `status('queued'|'sending'|'sent'|'failed'|'suppressed')`, and a `deliveries_mailing_status_idx (mailing_id, status)` composite index ideal for count queries; per-recipient `vars_json` lives on `deliveries` and is **never** exposed by existing read models). Contacts (`contacts/{routes,read-model}.ts` + `packages/api-contract/src/contacts/schema.ts`) is the template for an offset-paginated, contract-backed list endpoint; shared helpers live in `apps/service/src/http/query.ts` (`parsePagination` — default 50, max 100 — and `paginationMeta()` → `{limit, offset, nextOffset}`).
- Entry-point guard failure empirically confirmed: `file://${process.argv[1]}` can never equal `import.meta.url` on Windows paths or paths containing spaces (URL-encoding); the built CLI is a silent no-op there. `pathToFileURL(argv[1]).href` fixes it.
- `pnpm check` baseline: passing (55 files / 332 tests) before any of this work starts.

## Traceability: finding → plan section

Every review finding maps to a phase task below. IDs used throughout:

| ID | Finding (review section) | Fixed in |
|---|---|---|
| MF1 | Dead activation sign-in link (404) | Phase 2.1 |
| MF2 | Missing start throttling + user-code lockout | Phase 2.2–2.4 |
| MF3 | Approve not approve-once (addendum) | Phase 2.5 |
| MF4 | CLI entrypoint guard no-op on Windows/spaced paths (addendum) | Phase 5.2 |
| SEC1 | CSRF cookie missing `Secure` | Phase 2.6 |
| SEC2 | Unknown device code conflated with `expired_token` | Phase 1.3 + 2.7 + 5.6 |
| SEC3 | `api-keys create` defaults to no expiry | Phase 5.7 |
| SEC4 | `isSameOriginPost` passes with no Origin and no Referer (addendum) | Phase 2.6 |
| IMP1 | Plan-required test gaps (full list) | Phase 6 (+ tests inside Phases 2–5) |
| IMP2 | PROJECT.md stale ×5 | Phase 7.1 |
| IMP3 | Phantom refs: docs "CLI wrappers"; `nusend config repair-permissions` doesn't exist | Phase 7.2 (docs) + 5.8 (implement command) |
| API1 | `mailings:read` gates nothing (no GET endpoints) | Phase 4 (+ CLI in 5.9) |
| Q1 | `http.ts` untyped `schema: unknown` + casts | Phase 5.3 |
| Q2 | `polled as {...}` cast in login | Phase 5.3 |
| Q3 | Dead code `redactSecret`/`OutputMode` | Phase 5.4 |
| Q4 | Hardcoded VERSION / missing package.json version | Phase 5.4 |
| Q5 | Two contract pagination shapes; api-keys list fabricates pagination | Phase 1.2 + 3.3 |
| Q6 | Rotation: "(rotated)" name accumulation; expired-key rotation 400s | Phase 3.1 |
| Q7 | Login writes config before credential; overwrites activeProfile | Phase 5.5 |
| Q8 | `HOSTNAME` env instead of `os.hostname()` | Phase 5.4 |
| Q9 | Error-output mode inconsistency (both directions) | Phase 5.6 |
| Q10 | `logout` errors when not logged in | Phase 5.5 |
| Q11 | `html()` status-as-never cast | Phase 2.8 |
| Q12 | Empty `commands/`/`testing/` dirs; monolithic main.ts (addendum) | Phase 5.1 |
| Q13 | `whoami` human mode omits permissions (addendum) | Phase 5.4 |
| Q14 | `last_used_at` write amplification (addendum) | Phase 3.2 |
| Q15 | Loose `PermissionSetSchema`; duplicated `validatePermissions` in two service modules | Phase 1.1 |
| DOC1 | Exit codes undocumented | Phase 7.3 |
| DOC2 | production-readiness.md / ses-readiness.md untouched | Phase 7.4 |

## Chosen strategy and rationale

**Contract-first, then service security, then service features, then CLI, then tests-completion, then docs.** All breaking contract changes (pagination shape, new token status, new error code, permission-schema tightening, mailings schemas) land in one phase so the workspace compiles exactly once per breaking change instead of rippling. Security must-fixes go next because they are independent of the CLI restructure and unblock the manual verification the original plan demanded. The CLI restructure is one phase so command extraction and all CLI-side fixes happen in a single pass over `main.ts` rather than fixing code that is about to move. Everything is in-repo with no external consumers, so breaking contract changes are safe (verified: CLI and service are the only consumers of `@nusend/api-contract`).

**Ship as one change set.** Two known transient inconsistencies exist between phases and are acceptable only because nothing is released mid-stream: (a) after Phase 2.7 the service can return `{status:"invalid_grant"}` while the CLI only learns to handle it in Phase 5.3 — the unfixed CLI would crash on the unknown-code path; (b) between Phases 1.2 and 3.3 the contract's `ListApiKeysResponseSchema` declares `nextOffset` while the service still returns `hasMore` (no test decodes the live response against the contract in that window). Neither state may be tagged/released.

### Alternatives considered

- **Fix-by-priority order (all must-fix first, then medium, then low)**: rejected — it touches the same files repeatedly (e.g. `main.ts` in four separate passes) and forces contract changes mid-stream.
- **Durable DB-backed user-code attempt counters** (per original plan's columns): rejected for the default. Failed guesses match *no* row, so per-row counters are the wrong shape (this is why the columns were never wired). The activation surface requires an authenticated session, so a per-user in-memory limiter is proportionate for a single-user, single-process instance. The unused columns are dropped (migration 0006). Veto path: if durable/state-survives-restart limiting is required, add a small `auth_throttle` table instead — noted as fallback.
- **Form-POST to Better Auth for sign-in**: rejected — empirically, `signInSocial` accepts JSON only and returns 200 (no browser navigation). Inline JS fetch is required.
- **Implement full Phase 11–13 now**: rejected by user answer (separate follow-up plan).

## Vetoable decisions (defaults chosen; veto before implementation)

| # | Decision | Fallback if vetoed |
|---|---|---|
| D2 | Start throttling: DB-count based (global: max 30 non-expired authorizations; per-fingerprint: max 5, fingerprint = HMAC(hashSecret, **last** `x-forwarded-for` hop — appended by our own proxy, not client-forgeable — or `"direct"`)); user-code lockout: in-memory per-user (10 failed lookups / 15 min); migration 0006 drops `user_code_attempts`/`last_user_code_attempt_at` | Durable `auth_throttle` table keyed by scope+key |
| D4 | Unknown device code → new token status `"invalid_grant"` (breaking contract union change; CLI maps to exit 3) | Keep `expired_token` and document the conflation |
| D7 | Default expiry applied CLI-side (create + login flows unchanged server-side); `--no-expiry` opts out | Server-side default for all API creates |
| D8 | Rotation keeps the original name (lineage via `rotated_from_id`); expired/past expiry → fresh now+365d, future expiry preserved, `null` preserved | Suffix once (idempotent), or refuse expired rotation |
| D9 | Single pagination shape `{limit, offset, nextOffset}` everywhere; contract constants aligned to service reality (default 50, max 100) | Keep both shapes, document them |
| D13 | `--json` errors: one `{"error":{code,message}}` JSON object to **stderr** for all error classes; human mode: plain text | Errors to stdout in JSON mode |
| D16/D17 | `logout` is idempotent; login writes credential before config and preserves an existing `activeProfile` | — |
| D26 | Mailings detail includes `subject`/`html`/`text` (explicit single-owner choice per original plan); list omits bodies; `vars_json` never exposed anywhere | Detail omits bodies like ops endpoints |

---

## Phase 0 — Baseline

1. Reuse `.progress/fix-cli-review-findings-plan.md` as the implementation tracker (append an implementation log section).
2. Run `pnpm check` and record the baseline (expected: 55 files / 332 tests, pre-existing `no-await-in-loop` warnings only).
3. Single writer in the worktree throughout; read-only reviewer subagents at the checkpoints named per phase.

## Phase 1 — Contract package changes (all breaking changes in one slice)

**Files:** `packages/api-contract/src/{permissions.ts, pagination.ts, errors.ts, routes.ts, index.ts, auth/device.ts, api-keys/schema.ts, contacts/schema.ts}`, new `packages/api-contract/src/mailings/schema.ts`; ripple: `apps/service/src/api-keys/service.ts`, `apps/service/src/device-auth/service.ts`, `apps/cli/src/client/nusend-api.ts`, service `http/query.ts`, tests.

### 1.1 Tighten permission schema; single shared validator (Q15)

- **Do NOT use a `Schema.Struct` of optional per-resource fields** — reviewer-verified pitfall: Effect v4 structs default to `onExcessProperty: "ignore"`, so `{"bogus":["x"]}` would decode successfully with the unknown resource **silently stripped**, regressing today's 400 into a silent partial success (the service validator would never see the stripped key).
- Instead: keep the base shape `Schema.Record(Schema.String, Schema.Array(Schema.String))` and pipe it through a filter/check (same `Schema.makeFilter` pattern already used in `apps/service/src/mailings/schema.ts`) backed by a shared `validatePermissionSet(value): { ok: true } | { ok: false; message: string }` helper in `permissions.ts` that explicitly walks `Object.entries`: unknown resource or unknown action for that resource → readable failure (`Invalid permission mailings:delete`). Because the filter sees the full record, nothing is stripped and decode fails loudly → routes still return 400.
- Delete the duplicated `validatePermissions`/`isKnownResource` from `apps/service/src/api-keys/service.ts:295-311` and `apps/service/src/device-auth/service.ts:268-284`; both call the contract helper and wrap failures in `RequestValidationError` (stored-JSON re-validation keeps using the same helper).
- Behavior guard tests (this phase, not deferred): API-key create with unknown resource → 400; device start with unknown resource/action → 400 (also closes the review's missing device-start permission-validation test).

### 1.2 Unify pagination (Q5, first half)

- In `pagination.ts`: replace `PaginationMetaSchema {hasMore, limit, offset, total?}` with the real service shape `{limit: Number, offset: Number, nextOffset: NullOr(Number)}`; set `defaultPageLimit = 50`, `maxPageLimit = 100` (matching `apps/service/src/http/query.ts`, which currently disagrees with the contract's 200).
- Delete `DomainPaginationMetaSchema` from `contacts/schema.ts`; contacts imports the unified `PaginationMetaSchema`.
- `apps/service/src/http/query.ts` imports `defaultPageLimit`/`maxPageLimit` from `@nusend/api-contract` instead of declaring its own (contract becomes the source of truth; values unchanged).
- `api-keys/schema.ts` `ListApiKeysResponseSchema.pagination` now uses the unified shape (service change in Phase 3.3).

### 1.3 New token status + error code (SEC2, MF2 prerequisite)

- `auth/device.ts`: add `Schema.Struct({ status: Schema.Literal("invalid_grant") })` to `DeviceAuthorizationTokenResponseSchema` union.
- `errors.ts`: add `"rate_limited"` to `ErrorCodeSchema`.

### 1.4 Mailings contract schemas + route builders (API1)

New `mailings/schema.ts` (exported from `index.ts`):

```ts
MailingCountsSchema = Struct({ queued, sending, sent, failed, suppressed: Number })
MailingListItemSchema = Struct({ id, purpose: Literals(["transactional","marketing"]),
  state: Literals(["scheduled","sending","completed"]), name: NullOr(String), subject: String,
  listId: NullOr(String), scheduledAt: NullOr(String), createdAt, updatedAt: String,
  counts: MailingCountsSchema })
MailingsListResponseSchema = Struct({ items: Array(MailingListItemSchema), pagination: PaginationMetaSchema })
MailingDetailResponseSchema = Struct({ mailing: Struct({ ...list item fields incl. counts, html: String, text: NullOr(String) }) })
```

- `routes.ts`: `mailings` becomes `{ create: "/api/mailings", list: "/api/mailings", byId: (id) => \`/api/mailings/${encodeURIComponent(id)}\` }` (grep for existing `routes.mailings` consumers — none in CLI today).

**Validation:** `pnpm --filter @nusend/api-contract typecheck && pnpm -r --if-present typecheck && pnpm test` (expect compile ripple fixed within this phase; no behavior change yet except stricter 400s on malformed permission payloads).

## Phase 2 — Service security must-fixes (device auth + activation)

**Files:** `apps/service/src/device-auth/{activate-routes.ts, service.ts, routes.ts}`, new `apps/service/src/device-auth/attempt-limiter.ts`, new migration `apps/service/src/db/migrations/sql/0006_device_auth_throttle_cleanup.sql`, `apps/service/src/errors.ts`, `apps/service/src/http/respond.ts`, tests alongside.

### 2.1 Fix the dead sign-in link (MF1)

In `renderSignIn` (`activate-routes.ts:101-109`), replace the `<a href="/api/auth/sign-in/google...">` anchor with a button plus minimal inline script:

```html
<button id="signin" type="button">Sign in with Google</button>
<p id="signin-error" hidden>Sign-in failed. Reload and try again.</p>
<noscript><p>JavaScript is required to sign in.</p></noscript>
<script>
  document.getElementById("signin").addEventListener("click", async () => {
    try {
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: CALLBACK }),
      });
      const data = await res.json();
      if (res.ok && data.url) { window.location.assign(data.url); return; }
      throw new Error("bad response");
    } catch { document.getElementById("signin-error").hidden = false; }
  });
</script>
```

- `CALLBACK` is the **relative** path `/cli/activate` (+ `?code=...` when present). Embedding rule (do not HTML-escape inside `<script>` — entities are not decoded there and would corrupt the value): first validate the query `code` against the user-code shape (`normalizeUserCode` + `/^[A-Z2-9]{4}-[A-Z2-9]{4}$/`; anything else is treated as absent), then embed with `JSON.stringify(callback).replaceAll("<", "\\u003c")` to prevent `</script>` breakout. The charset validation alone already excludes `<`, quotes, and slashes; the replace is belt-and-braces.
- Keep the page free of the raw device code as before.
- **Integration test** (new, e.g. `apps/service/src/device-auth/signin-social.integration.test.ts`): real `createAuth` + migrated in-memory DB (pattern proven in planning; see research), assert `POST /api/auth/sign-in/social {provider:"google", callbackURL:"/cli/activate?code=X"}` → 200 with `url` containing `accounts.google.com` and correct `redirect_uri`. Also assert `GET /api/auth/sign-in/google` → 404 as a canary against regressing to the link form.
- **Page test**: activation page HTML contains the social-sign-in fetch call and no `sign-in/google` href.

### 2.2 Rate-limit device-authorization start (MF2a)

- New tagged error `RateLimitedError` in `errors.ts`; map in `respond.ts` to 429 + envelope code `"rate_limited"`; extend the `AuthError`-style handling in `requirePrincipal` only if needed (start route is public, uses `runRoute`).
- In `DeviceAuthorizations.start` (`service.ts`):
  - Compute `requesterFingerprintHash = hashDeviceAuthCode(clientAddress ?? "direct", hashSecret)` where `clientAddress` is the **last** `x-forwarded-for` hop — the one appended by our own reverse proxy — not the first (the first hop is client-supplied and freely forgeable, which would make the per-fingerprint cap decorative). Assumption documented in `docs/deployment.md`: exactly one trusted reverse proxy; direct exposure (no header) collapses to the `"direct"` bucket, i.e. effectively the global cap. The route passes the value in (extend `start` input with `requesterFingerprint?: string`). Never log or return it.
  - Global cap: `SELECT COUNT(*) FROM device_authorizations WHERE expires_at > $now` ≥ 30 → fail `RateLimitedError` (uses existing `device_authorizations_expires_at_idx`).
  - Per-fingerprint cap: same count filtered `AND requester_fingerprint_hash = $fp` ≥ 5 → `RateLimitedError`.
  - Store the fingerprint on insert (column exists since 0005).
  - Opportunistic cleanup: `DELETE FROM device_authorizations WHERE expires_at < $nowMinus24h` at the top of `start`.
- Tests: 31st concurrent pending start → 429 `rate_limited`; 6th start with same fingerprint → 429; different fingerprint still allowed under global cap; cleanup removes stale rows.

### 2.3 User-code attempt lockout (MF2b)

- New `apps/service/src/device-auth/attempt-limiter.ts`: pure in-process sliding-window limiter — `makeAttemptLimiter({ max: 10, windowMs: 15*60_000, now?: () => number })` with `recordFailure(key)`, `isLocked(key)`; injectable `now` for tests.
- Wire into `activate-routes.ts` (one limiter instance per `createActivationRoutes` call), keyed by session `userId`:
  - Before `inspect`/`approve`/`deny`: if locked → render "Too many attempts. Try again later." (403).
  - Record a failure whenever a submitted code resolves to no valid authorization (inspect returns null, approve/deny fail validation).
  - Reset window naturally (sliding window; no explicit unlock needed).
- Document the accepted limitation in `docs/auth-and-api-keys.md`: per-process memory, resets on restart; acceptable because the surface requires an authenticated owner session.
- Tests: 10 bad codes → 11th rejected with lockout message even for a *valid* code; window expiry (fake `now`) unlocks; failures keyed per user.

### 2.4 Migration 0006 (MF2c)

`0006_device_auth_throttle_cleanup.sql`:

- up: `ALTER TABLE device_authorizations DROP COLUMN user_code_attempts; ALTER TABLE device_authorizations DROP COLUMN last_user_code_attempt_at;` (never-written columns; wrong shape — failed guesses match no row; `requester_fingerprint_hash` stays and is now used).
- down: re-add both columns with their 0005 definitions.
- Update `apps/service/src/db/migrate.integration.test.ts`: final schema asserts the two columns are gone, `requester_fingerprint_hash` present; **add the index assertions the review found missing** for `api_keys` (`user_id`, `revoked_at`, `last_used_at` idx) and `device_authorizations` (`expires_at`, `approved_user` idx); down-migration restores columns.

### 2.5 Approve-once (MF3)

- `service.ts` `approve`: extend the guard to reject when `row.approved_at` is already set (same "invalid or expired" message — don't leak state), and add `AND approved_at IS NULL` to the UPDATE's WHERE.
- Test: approve, approve again → error; `approved_by_user_id` unchanged in DB.

### 2.6 Cookie + origin hardening (SEC1, SEC4)

- `html()` in `activate-routes.ts`: append `; Secure` to the CSRF cookie when the request is HTTPS (`x-forwarded-proto === "https"` or `new URL(request.url).protocol === "https:"`) — pass the request (or an `isSecure` flag) into `html()`.
- `isSameOriginPost`: reject when **both** Origin and Referer are absent (browser-only page; strictly tighter). Update the existing malformed-referer test; add both-absent → 403 test; header-carrying legit POST tests keep passing.

### 2.7 Distinguish unknown device code (SEC2)

- `service.ts` `token`: unknown `device_code_hash` (no row) → `{ status: "invalid_grant" }`; row exists but consumed/expired → `expired_token` (unchanged); update route test: unknown code → `invalid_grant` (this also closes the review's missing invalid-device-code test).

### 2.8 Type polish in this file while touched (Q11)

- Replace `status?: never` + `status as never` in `html()` with Hono's `ContentfulStatusCode` type.

**Checkpoint:** read-only security reviewer subagent over Phase 2 diff (device flow + activation). Then `pnpm test` + `pnpm check`.

## Phase 3 — API-key service semantics

**Files:** `apps/service/src/api-keys/{service.ts, routes.ts, routes.test.ts}`.

### 3.1 Rotation rules (Q6)

- Keep the original `name` (drop the `"(rotated)"` suffix; lineage remains queryable via `rotated_from_id`).
- Expiry on rotate: future `expires_at` preserved; `null` preserved; past/malformed → fresh `now + 365d` (rotation of an expired-but-unrevoked key now succeeds — the review noted the current 400).
- Tests: rotate preserves name + future expiry; rotate expired key succeeds with ~365d expiry; rotate null-expiry stays null.

### 3.2 `last_used_at` debounce (Q14)

- `verify`: `UPDATE ... SET last_used_at = $now WHERE id = $id AND (last_used_at IS NULL OR last_used_at < $cutoff)` with `cutoff = now − 60s`. Test: two immediate verifies produce one write (assert unchanged value on second), a verify after cutoff updates.

### 3.3 Real pagination for the list endpoint (Q5, second half)

- `GET /api/api-keys` accepts `limit`/`offset` via the shared `parsePagination` helper; SQL gains `LIMIT $limit OFFSET $offset`; response `pagination` uses `paginationMeta()` (`{limit, offset, nextOffset}`), matching the unified contract schema from 1.2.
- Tests: page split with seeded keys; `nextOffset` null on final page; invalid `limit` → 400.

## Phase 4 — Mailings read API (API1)

**Files:** new `apps/service/src/mailings/read-model.ts`, `apps/service/src/mailings/routes.ts`, `apps/service/src/mailings/routes.test.ts`, `apps/service/src/app.test.ts` (route inventory if asserted).

Follow the contacts template (scouted; see research):

- `read-model.ts`: `listMailings(query)` and `getMailingDetail(id)` returning `Effect<..., DatabaseError | NotFoundError, DatabaseService>`.
  - List SQL: explicit column projection (`id, purpose, state, name, subject, list_id, scheduled_at, created_at, updated_at`) — **never `SELECT *`** (protects `html`/`text` from the list; `vars_json` lives on `deliveries` and is never selected anywhere).
  - Counts: one query per page — `SELECT mailing_id, status, COUNT(*) AS count FROM deliveries WHERE mailing_id IN (...page ids) GROUP BY mailing_id, status` (uses `deliveries_mailing_status_idx`); fold into `{queued, sending, sent, failed, suppressed}` with zero defaults.
  - Order: `created_at DESC, id DESC LIMIT $limit OFFSET $offset`; optional filters deferred (none in this slice).
  - Detail: same fields + `html`, `text` (Decision D26: single-owner instance; ops endpoints continue omitting bodies) + counts; missing id → `NotFoundError`.
- `routes.ts`: `requireMailingsRead = requirePrincipal({ permissions: { mailings: ["read"] }, ... })`; `GET /` and `GET /:id` via `runRoute`, decoding query with `parsePagination`/`parseRouteId`.
- Tests (mirror `contacts/routes.test.ts` seeding style with fixed timestamps): 401 unauthenticated; 403 for key without `mailings:read`; session OK; API key with `mailings:read` OK (this doubles as the review's missing "real key against a real permission-gated route" test — use a **real** key via `realApiKeys` test option, not the fake); list omits `html`/`text`; detail includes them; counts correct incl. suppressed; pagination `nextOffset`; 404 unknown id; response decodes against the contract schemas.

## Phase 5 — CLI restructure and all CLI fixes

**Files:** `apps/cli/src/main.ts` (shrinks to parse/dispatch/error-map), new `apps/cli/src/commands/{context.ts, login.ts, logout.ts, whoami.ts, api-keys.ts, contacts.ts, mailings.ts, config.ts}`, new `apps/cli/src/testing/service-bridge.ts` (Phase 6 uses it), `apps/cli/src/client/{http.ts, nusend-api.ts}`, `apps/cli/src/output/format.ts`, `apps/cli/src/credentials/file-store.ts`, `apps/cli/package.json`, `apps/cli/src/main.test.ts` (split per command as `commands/*.test.ts` where natural).

### 5.1 Extract command modules (Q12)

- `commands/context.ts`: shared `CommandContext` `{ options: GlobalOptions, env, store, config, api?: NusendApi }` plus `UsageError` (moves out of main).
- One module per command family; `main.ts` keeps: global-arg parsing, help/version, command table dispatch, credential resolution **only for commands that need it** (see 5.5), and the error → exit-code mapping (5.6). Target ≤ ~120 lines.
- The previously empty `commands/` and `testing/` directories become real; nothing else ships empty.
- Build hygiene while touching the CLI build: `apps/cli/tsconfig.build.json` currently includes `src/**/*.ts`, so `dist/` already ships `main.test.js` (reviewer-verified). Add `exclude` for `**/*.test.ts` and `src/testing/**` so the bin package's `dist/` contains only runtime code.

### 5.2 Entrypoint guard (MF4)

- Extract a pure helper `isMainEntry(argv1: string | undefined, importMetaUrl: string): boolean` implemented with `pathToFileURL(argv1).href === importMetaUrl` (false for undefined argv1); `main.ts` calls it.
- **Unit-test the pure function** (no build needed, `pnpm check` never builds): spaced path (`/tmp/with space/main.js`), plain path, mismatch, undefined. Windows-style verification via the same URL-encoding property. The real spawn check of the built artifact (including a spaced temp dir) stays in Phase 8.2 where `pnpm build` has run.

### 5.3 Typed HTTP client (Q1, Q2)

- `http.ts`: `request<A, I = A>(input: { schema: Schema.Codec<A, I>; ... }): Promise<A>` (use the effect v4 schema type that `decodeUnknownSync` accepts); delete `as never`/`as A`/`schema: unknown`.
- `nusend-api.ts`: signatures unchanged, casts removed; add `listMailings`/`getMailing` (Phase 4 schemas).
- `login.ts`: replace the `polled as {...}` cast with `if (polled.status === "approved")` narrowing; handle new `invalid_grant` → `UsageError("Device code not recognized by the server.", 3)`.

### 5.4 Small fixes bundle (Q3, Q4, Q8, Q13)

- Delete `redactSecret` + `OutputMode` (dead) — keep `printJson`.
- Add `"version": "0.1.0"` to `apps/cli/package.json`; `main.ts` reads it via `createRequire(import.meta.url)("../package.json").version` (resolves correctly from both `src/` and `dist/`); delete the hardcoded const. Test: `--version` output equals package.json version.
- Client name: `os.hostname()` (fallback `"local"`).
- `whoami` human mode prints permissions: `permissions: owner` for sessions; sorted `resource:action` list for keys.

### 5.5 Login/logout flow fixes (Q7, Q10, D16, D17)

- Login success ordering: `store.write(credential)` **before** `saveConfig`; `activeProfile` set only when the config had none (existing active profile preserved).
- `logout` no longer requires a stored credential: without one it prints `No credential stored for profile <p>.` and exits 0; `--revoke` with a credential calls the API then deletes locally (revoke failure → still delete locally, warn on stderr, exit 0 — decision: local logout must always succeed).
- Command table has **three** credential classes: required (`whoami`, `api-keys`, `contacts`, `mailings` — fail exit 3 with hint when absent), none (`login`, `config`), and **lazy/optional** (`logout` — builds a client only when `--revoke` is passed AND a credential exists; otherwise proceeds without one). This fixes the odd "Authentication required" on logout without recreating its mirror image for `--revoke`.
- Login polling: `sleep(Math.min(intervalMs, clamp))` where `clamp` comes from `NUSEND_LOGIN_POLL_INTERVAL_MS` when set (test affordance; undocumented except a code comment + e2e usage).

### 5.6 Consistent error output + exit codes (Q9, D13)

- `main.ts` parses global options first and passes `json` into a single `printError(error, json)`:
  - `--json`: exactly one `{"error":{"code","message"}}` JSON object to stderr for **all** error classes (`UsageError` → code `"usage"` or `"unauthenticated"` for exit-3 cases; `CliHttpError` → its envelope code; unexpected → `"internal_error"`).
  - Human: `Error: <message>` (+ hint line for auth errors), no JSON.
- Exit codes unchanged: 0 / 1 unexpected / 2 usage / 3 auth / 4 API error. Tests: each class × both modes.

### 5.7 Default expiry for created keys (SEC3, D7)

- `api-keys create`: when `--expires-at` absent and `--no-expiry` not passed → default `now + 365d`; `--no-expiry` sends `expiresAt: null`. Human output prints the applied expiry. Server untouched. Tests: default request body contains a ~365d ISO date; `--no-expiry` sends null; explicit `--expires-at` passthrough.

### 5.8 `nusend config repair-permissions` (IMP3b)

- New `commands/config.ts` subcommand: `chmod 0700` config dir, `0600` `config.json` + `credentials.json` when present (POSIX; on win32 print "not applicable on Windows", exit 0). The `file-store.ts:76` error message now points at a real command. Tests: broken modes repaired; subsequent read succeeds.

### 5.9 Mailings read commands (API1)

- `nusend mailings list [--limit --offset]` (human: `id  state  purpose  subject  sent/total`), `nusend mailings get <id>` (human: key-value summary **without printing full html**; `--json` returns the full document). Help text updated. Tests with mocked fetch: URL/query building + JSON decode.

**Checkpoint:** read-only CLI reviewer subagent over Phase 5 diff.

## Phase 6 — Close every remaining test gap (IMP1)

Service (files: respective `*.test.ts`):

1. `/api/me`: session principal → `{kind:"session", permissions:"owner"}`; no credentials → 401 (new `auth/me-routes.test.ts` or fold into api-keys routes test).
2. Stored-key expiry at auth time: seed real key with past `expires_at` (via `realApiKeys` + direct DB update) → request → 401. Same for malformed stored `expires_at`.
3. Device start: invalid permission payload → 400 (may already land in Phase 1.1; ensure present).
4. Activation via HTTP: `action=deny` POST → `denied_at` set; invalid/expired code GET renders the error message page.
5. Migration index assertions (done in Phase 2.4 — verify).
6. Real-key-on-gated-route (done in Phase 4 tests — verify).

CLI (files: `apps/cli/src/commands/*.test.ts`, `apps/cli/src/config/{paths,profiles}.test.ts`):

7. Login success flow: fake fetch scripted `pending → slow_down → approved`; assert both intervals respected (clamped), credential + profile persisted, raw key not printed in human mode beyond the confirmation line, `--json` prints exactly one final JSON document to stdout.
8. Login denied → exit 3; `invalid_grant` → exit 3.
9. Logout: with credential (deleted), without credential (idempotent), `--revoke` (API called then deleted; API failure still deletes).
10. `api-keys list` / `revoke` / `rotate` command tests (request/response handling, raw key printed once on rotate).
11. `contacts get/update/delete` command tests.
12. `whoami` unauthenticated hint + exit 3.
13. Paths: macOS/Linux `~/.config` fallback (no XDG), Windows `APPDATA` and `LOCALAPPDATA` branches (pure function tests with fake env/platform injection — refactor `configDirectory` to accept a `platform` param for testability).
14. Profiles: `loadConfig`/`saveConfig` round-trip in temp dir; malformed config file → clear error.
15. Exit-code/error-envelope mapping matrix (from 5.6).

End-to-end smoke (new, repo root — avoids a package dependency between `apps/cli` and `apps/service`):

16. `e2e/cli-service.e2e.test.ts`: boot real in-process service app (`withTestApp` with `realApiKeys` + `realDeviceAuthorizations` + fake session auth), stub `globalThis.fetch` to dispatch into `app.request(...)` (generic handler-in/fetch-out helper in `apps/cli/src/testing/service-bridge.ts` — it imports nothing from the service, preserving the dependency rule; the e2e test wires the service app in), temp `XDG_CONFIG_HOME`, `NUSEND_LOGIN_POLL_INTERVAL_MS=10`. Flow: `login` (start → approve → poll) → `whoami` → `api-keys create` (default expiry visible) → `contacts create` → `mailings list`.
    - **Deadlock avoidance (reviewer-found blocker):** the service records `last_poll_at` on *every* `/token` poll and returns `slow_down` for any poll within 5s of the previous one — sub-second polling would loop on `slow_down` forever. Therefore the fetch bridge must perform the **HTTP activation approval synchronously inside the intercepted `POST /api/device-authorizations` start call** (GET `/cli/activate?code=...` for the CSRF cookie/token → POST approve) *before* returning the start response to the CLI. The CLI's **first** poll then finds `last_poll_at = NULL` (`tooSoon` false) and an approved row → `approved` immediately, deterministically, with no wall-clock wait. Do not rely on the poll-interval clamp to escape the slow_down window — it cannot.
    - The bridge's approve POST must satisfy Phase 2.6's tightened checks: send a same-origin `Origin` header alongside the CSRF cookie + hidden token from the preceding GET, and **assert the approval success message in the response HTML** — a silently swallowed 403 here would reproduce the pending→slow_down hang.
    - Vitest picks the file up via the default include (verified: root `vitest.config.ts` sets no custom `include`). **Typecheck coverage:** add `e2e/tsconfig.json` (extends `tsconfig.base.json`, includes the folder) and extend the root `typecheck` script to `pnpm -r --if-present typecheck && tsc --noEmit -p e2e/tsconfig.json` so the file isn't permanently un-typechecked.

## Phase 7 — Documentation truth pass

1. **PROJECT.md (IMP2)**: add all new routes to the route inventory (`/api/api-keys*`, `/api/me`, `/api/device-authorizations*`, `/cli/activate`, full `/api/operations/ses/*` family, new `GET /api/mailings*`); rewrite the Auth Tables section (first-party `api_keys` keyed by `user_id`; `device_authorizations`; Better Auth owns only users/sessions/accounts/verifications); fix "being replaced" → implemented; move the completed CLI/auth roadmap phase to done and describe current CLI surface (auth + api-keys + contacts + mailings-read); remove "workspace foundation" understatement.
2. **Phantom refs (IMP3a)**: `docs/operations.md:1` and `docs/troubleshooting.md:21` — replace "CLI wrappers" with accurate wording ("HTTP routes; CLI wrappers planned for a follow-up"); `docs/troubleshooting.md` mentions `nusend config repair-permissions` now that it exists.
3. **docs/cli.md (DOC1 + behavior changes)**: exit-code table (0/1/2/3/4), JSON error envelope contract (stderr), default key expiry + `--no-expiry`, `repair-permissions`, mailings commands, login `invalid_grant`/denied behavior, logout idempotency.
4. **docs/api.md + docs/auth-and-api-keys.md + docs/deployment.md**: new mailings GET endpoints + response shapes; `invalid_grant` status; `rate_limited` (429) error code + start-throttle limits; unified pagination shape (limit/offset/nextOffset, max 100); rotation semantics (name kept, expiry rules); user-code lockout description + restart caveat. **docs/production-readiness.md (DOC2)**: add CLI/API-key validation steps (login, whoami, scoped-key create, revoke). `docs/ses-readiness.md`: intentionally unchanged (no SES CLI commands yet) — note recorded here rather than silently skipped.
5. Sweep: `grep -ri "mailings:create\|CLI wrappers\|repair-permissions\|hasMore" docs README.md PROJECT.md` returns only intended hits.

## Phase 8 — Final validation

1. `pnpm check` (format, lint, typecheck, full tests) — new totals recorded.
2. Clean build: `rm -rf packages/api-contract/dist apps/cli/dist && pnpm build`; run `./apps/cli/dist/main.js --help`, `--version`; run the spaced-path spawn test manually once.
3. **Manual browser verification (closes the original plan's unmet DoD item)**: start local service with temp DB + real auth env; with agent-browser: open `/cli/activate?code=...` signed-out → click "Sign in with Google" → **assert navigation to accounts.google.com** (full Google round-trip needs real credentials; the redirect handoff is the previously broken part). If real Google test credentials are available, complete the loop: sign in → approve → CLI poll succeeds. Stop server + close browser after.
4. Confirm traceability: walk the finding table above; every ID has a merged change or an explicitly recorded veto.

## Subagent / delegation plan (implementation time)

- Single writer for all edits (shared files across phases).
- Read-only reviewer subagents after Phase 2 (security: throttling, approve-once, sign-in flow) and Phase 5 (CLI credential/flow handling) — same checkpoints the original plan used.
- No parallel implementation agents: Phases 1→5 are order-dependent (contract ripples); Phase 6 tests could be parallelized across two agents (service tests vs CLI tests) only if desired, with the e2e test written last.

## Data / API / interface changes (breaking, in-repo only)

- Contract: pagination meta shape (`hasMore/total` → `nextOffset`), `maxPageLimit` 200→100, token union + `invalid_grant`, error codes + `rate_limited`, `PermissionSetSchema` tightened, mailings schemas added, `routes.mailings` string → object. Consumers (service, CLI) updated in the same phases; no external consumers exist (grep-verified in the review).
- DB: migration 0006 drops two never-written columns (down-migration restores).
- HTTP: `POST /api/device-authorizations` can now return 429 `rate_limited`; token endpoint can return `{status:"invalid_grant"}`; `GET /api/api-keys` honors `limit`/`offset`; new `GET /api/mailings`, `GET /api/mailings/:id`. Stale clients (none known) polling with an unknown code would see `invalid_grant` instead of `expired_token` — both terminal, fail-safe.

## Risks and mitigations

- **Inline sign-in script breaks under a future CSP**: no CSP is set on this page today; if one is added later, move the script to a nonce'd block. Recorded here so the constraint isn't lost.
- **In-memory lockout resets on restart** (D2): documented; surface requires an authenticated session; veto path = durable table.
- **Global start cap (30 pending) can lock out the owner's `nusend login` during a deliberate, sustained flood**: an attacker who keeps 30 pending authorizations alive denies device login until the flood stops (caps self-heal in ≤10 min via TTL). The per-fingerprint cap only stops naive attackers — with last-hop keying it is honest per-source limiting, but a distributed flood still saturates the global cap. Accepted residual for a single-user instance (documented in docs/troubleshooting with the workaround: pre-created API keys via a browser session are unaffected). Escalation path if it ever matters: require an authenticated session or a static bootstrap secret to start device authorizations.
- **Pagination shape change silently breaking an unnoticed consumer**: grep for `hasMore` across the repo in Phase 1; only api-keys list + its tests + CLI decode use it.
- **`ALTER TABLE ... DROP COLUMN` requires SQLite ≥ 3.35**: Bun's bundled SQLite is ≥ 3.44 — safe; migration integration test proves it.
- **Tightened permission schema**: the filter-based Record schema is the mandated primary design (Phase 1.1) precisely because Struct-of-optionals silently strips unknown keys in Effect v4; no Struct fallback exists. Residual risk is only message quality — ensure the filter surfaces the helper's `Invalid permission <resource>:<action>` text.

## Definition of Done

- Every finding ID in the traceability table is implemented (or explicitly vetoed by the user and recorded).
- Signed-out activation hands off to Google from the page — browser-verified navigation to `accounts.google.com` (full consent round-trip only when real Google credentials are available; without them the redirect handoff, which is the previously broken part, is the proof); the social sign-in integration test passes offline.
- Start throttling + user-code lockout enforced with passing tests; migration 0006 applied with updated schema tests (including index assertions).
- CLI: extracted command modules, no empty directories, guard fixed (spaced-path test passes), consistent `--json` errors, documented exit codes, default key expiry, idempotent logout, `repair-permissions` implemented, mailings read commands working.
- `GET /api/mailings` + `/:id` live under `mailings:read` with contract schemas and tests; `vars_json` provably never exposed.
- All Phase 6 test gaps closed; e2e smoke green; `pnpm check` green; clean rebuild + built CLI run green.
- Docs and PROJECT.md contain no statement contradicted by the code (sweep in 7.5 clean).

## Open questions

None blocking — all choices are encoded as vetoable decisions above (D2, D4, D7, D8, D9, D13, D16/D17, D26).
