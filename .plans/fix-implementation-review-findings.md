# Fix All Findings from the Implementation Review

Date: 2026-07-10. Source review: `.reviews/fix-cli-review-findings-implementation-review.md` (all findings independently verified in that session — every item below carries confirmed file:line evidence from it). Planning notes: `.progress/fix-implementation-review-findings-plan.md`.

## Summary

Fix **every** finding from the review of the `.plans/fix-cli-review-findings.md` implementation: the one must-fix (`login --json` dead-end), all six improvements, both security minor observations, all four test gaps, all three docs items, and all eight optional-polish nits. Each finding gets a traceability row: a fix task, or an explicitly recorded no-op with rationale. No contract-schema changes are needed; response shapes stay identical (only *when* `nextOffset` is null changes, becoming exact everywhere).

## Confirmed requirements

- User instruction (2026-07-10): fix **ALL** issues identified in the review — must-fix, improvements, security observations, test gaps, docs, and polish.
- Behavior choices are encoded as vetoable decisions (defaults below), matching this repo's established plan style.

## Traceability: finding → plan task

| ID | Review finding | Fixed in |
|---|---|---|
| MF-A | `login --json` never shows verification URL/code (functional dead-end) | 2.1 |
| C-I1 | Base URLs with path prefix silently truncated | 2.2 |
| C-I2 | `readOption` consumes a following flag as value | 2.3 |
| C-I3 | Env-credential logout deletes stored credential while claiming `loggedOut:false` | 2.4 |
| C-I4 | `api-keys list` silently truncates at server default 50 | 2.5 |
| S-I1 | Pagination semantics diverge (contacts/lists/suppressions phantom `nextOffset` on exact-full final page) | 1.1 |
| S-I2 | Corrupt stored `permissions_json` → 400 on api-keys list; escapes to raw 500 on verify | 1.2 |
| SEC-O1 | POST `/cli/activate` unknown action returns 200 | 1.3 |
| SEC-O2 | Spoofable `x-forwarded-proto` on misdeployed direct exposure | 5.4 (doc-only per V9) |
| TG-1 | JSON-mode login pre-approval phase untested | 2.1 (test) |
| TG-2 | Login credential-before-config ordering not asserted | 4.1 |
| TG-3 | `repair-permissions` win32 branch untested | 4.2 |
| TG-4 | Activation GET with *expired* code untested | 4.3 |
| D-1 | README CLI enumeration omits mailings + `config repair-permissions`; no mailings example | 5.1 |
| D-2 | `docs/cli.md:32` logout wording wrong for env-credential path | 5.2 (after 2.4) |
| D-3 | `docs/troubleshooting.md:9` lumps 403 into 401 "rejected" wording | 5.3 |
| N-1 | `main.ts` 137 lines vs ~120 target / tracker claimed 131 | No-op, recorded (V7) |
| N-2 | (= TG-2) ordering test | 4.1 |
| N-3 | (= TG-3) win32 test | 4.2 |
| N-4 | `--version`/`--help` matched anywhere in argv | 3.1 (V5; the `--help` half is a recorded accepted edge) |
| N-5 | `--opt=value` syntax unsupported, unhelpful error | 3.2 |
| N-6 | `logout --revoke` failure warning is plain text in `--json` mode | 3.3 |
| N-7 | Bare `nusend mailings` reports auth (3) before usage (2) | 3.4 |
| N-8 | `service-bridge.ts` references Bun-only `fetch.preconnect` | 3.5 |
| Q-A | `ApiKeysService.list` returns limit+1 rows, route slices (leaky) | 1.4 |
| Q-B | Vitest `@nusend/api-contract` alias prefix-match footgun | 3.6 |

## Vetoable decisions (defaults chosen; veto before implementation)

| # | Decision | Fallback if vetoed |
|---|---|---|
| V1 | `login --json` emits **one JSON line to stderr** before polling: `{"verification":{"uri","uriComplete","userCode","expiresAt"}}`; stdout remains exactly one final JSON document (D13-consistent) | Reject `--json` on `login` with a usage error |
| V2 | **Reject path-carrying base URLs** at `normalizeBaseUrl` with a clear error ("Base URL must not include a path; deploy Nusend at a domain root"). Rationale (reviewer-found): CLI-side joining alone cannot fix sub-path deployments — the *server* builds the verification URI from the request origin only (`device-auth/routes.ts:33`) and the activation form posts to absolute `/cli/activate` (`activate-routes.ts:218`), so login would still 404 behind a prefix-stripping proxy. Rejecting removes the silent lie coherently | Full sub-path support: CLI string-concat join **plus** server-side prefix awareness (configurable public base URL used for verification URIs and form actions) |
| V3 | Env-credential logout becomes **non-destructive**: never deletes the stored file credential; reports that the env key stays active and (if present) that a stored credential was kept; `store.delete` becomes a no-op when `credentials.json` doesn't exist | Keep deleting but report the deletion in output/JSON |
| V4 | Corrupt **stored** `permissions_json` (api-keys list/verify, device-auth stored permissions) → `DatabaseError` → existing 500 `internal_error` mapping + `logCause` log. User-*supplied* validation keeps `RequestValidationError`/400 | Skip corrupt rows in list (log each), 500 only on verify |
| V5 | Narrow **only `--version`/`-v`** to the first token after global options; keep whole-argv scanning for `--help`/`-h` (reviewer-found: first-token-only `--help` would make `nusend login --help` throw "Invalid base URL" via `normalizeLoginBaseUrl("")` and `nusend config --help` → "Unknown config command" — worse UX than today's global help). The swallowed-positional edge for `--help` is documented as accepted | Also narrow `--help` and add per-family help output first |
| V6 | `logout --revoke` failure warning in `--json` mode becomes one JSON line on stderr: `{"warning":{"code":"revoke_failed","message"}}`; human mode unchanged | Keep plain-text stderr warning in both modes |
| V7 | `main.ts` length: **no-op**. The file is pure dispatch/wiring; shrinking to ≤120 lines is make-work. The stale "131 lines" tracker claim is corrected by this plan's record | Extract the dispatch table to `commands/dispatch.ts` |
| V8 | Add `--opt=value` parsing as a **single argv pre-pass** that splits `--x=y` into `--x y` before *any* parsing (reviewer-found: patching individual readers would miss `optionValues`/`--permission` at `context.ts:96-102`, silently creating keys with `{}` permissions). Known boolean flags given `=value` → usage error | Reject `=`-forms with a usage error naming the space-separated syntax |
| V9 | SEC-O2 stays **doc-only** (trusted proxy must set/overwrite `x-forwarded-proto`); impact is availability-only on a misdeployment | Honor `x-forwarded-proto` only when a trusted-proxy config flag is set |

## Current-state evidence (from the review; spot-verified)

- `apps/cli/src/commands/login.ts:27-32` — URL/code printed only when `!options.json`; nothing else before approval.
- `apps/cli/src/client/http.ts:29` — `new URL(input.path, baseUrl + "/")` drops any base path (empirically: `/prefix` + `/api/me` → `host/api/me`); `apps/cli/src/config/profiles.ts:51-58` deliberately preserves the path.
- `apps/cli/src/commands/logout.ts:10-23` — env path deletes stored credential, reports `loggedOut:false`.
- `apps/cli/src/commands/context.ts:91-94` — `readOption` returns `args[index+1]` unconditionally; contrast `globalOptionValue` (`context.ts:60-66`) which rejects `--`-prefixed values. Call sites: `login.ts:22`, `api-keys.ts:27,29`, `mailings.ts:10-11`, `contacts.ts:10-12`.
- `apps/service/src/http/query.ts:16-26` — `paginationMeta(itemsLength, pagination, hasMore = itemsLength === pagination.limit)`; default-relying call sites: `contacts/read-model.ts:59`, `suppressions/read-model.ts:69`, `lists/read-model.ts:60,124`. Exact call sites (explicit `hasMore`): `mailings/read-model.ts:93`, `api-keys/routes.ts:41`.
- `apps/service/src/api-keys/service.ts:144` — `rowToMetadata` → `parseStoredPermissions` → `RequestValidationError` → 400 for the whole list; on `verify`, the same error escapes `requirePrincipal`'s `catchTags` (`auth/middleware.ts:56-69`) into the defect path. `DatabaseError` already maps to 500 `internal_error` (`http/respond.ts:179,224`) so V4 needs **no** respond.ts change.
- `apps/service/src/device-auth/service.ts:318-333` — `parseStoredPermissions` same pattern (stored data → `RequestValidationError`).
- `apps/cli/src/main.ts:34-42` — `parsed.rest.includes("--help"|"--version")` scans everywhere; `main.ts:71-84` resolves credentials before subcommand parsing.
- `apps/cli/src/testing/service-bridge.ts:9` — `fetch.preconnect` (Bun-only).
- `vitest.config.ts` — bare `@nusend/api-contract` alias is an unanchored string find.

## Chosen strategy and rationale

**Service first, then CLI behavior, then CLI polish, then tests, then docs.** The service fixes (1.x) are independent of the CLI and change no response *shape*, so nothing ripples into the contract package. CLI behavior fixes (2.x) and polish (3.x) are one pass over the same files (`context.ts`, `main.ts`, `login.ts`, `logout.ts`, `http.ts`) — doing behavior and polish in adjacent phases avoids re-touching freshly reviewed code. Docs go last so they describe final behavior (especially D-2, which depends on the 2.4 logout decision). Everything ships as one change set; no transient inconsistencies exist because no cross-package contract changes are made.

### Alternatives considered

- **Docs-first for D-2/D-3**: rejected — D-2's correct wording depends on the V3 behavior choice; writing it first risks a second docs pass.
- **New `StoredDataError` tag instead of reusing `DatabaseError` (V4)**: rejected — `DatabaseError` already carries an `operation` field, is in every relevant error union, and maps to 500; a new tag would ripple through `respond.ts` unions and `catchTags` for zero behavioral difference.
- **Server-side pagination for `api-keys list` CLI via auto-following `nextOffset`**: rejected — silent full-listing hides the same information; explicit `--limit/--offset` + a "more available" hint matches contacts/mailings and the docs.

---

## Phase 1 — Service fixes

**Files:** `apps/service/src/http/query.ts`, `apps/service/src/{contacts,lists,suppressions,mailings}/read-model.ts`, `apps/service/src/api-keys/{service.ts,routes.ts,routes.test.ts}`, `apps/service/src/device-auth/{service.ts,activate-routes.ts}` + tests.

### 1.1 Exact pagination everywhere (S-I1)

- `http/query.ts`: make `hasMore` a **required** third parameter of `paginationMeta` (delete the default). Compile errors then enumerate every lagging call site — that's the point.
- Convert `contacts/read-model.ts`, `suppressions/read-model.ts`, `lists/read-model.ts` (both call sites) to the limit+1 probe already used by mailings/api-keys: fetch `limit + 1` rows, `hasMore = rows.length > limit`, slice to `limit` **before** decode/mapping, pass explicit `hasMore`.
- Tests (each module): seed exactly `limit` rows for the final page → `nextOffset: null`; seed `limit + 1` → non-null and the extra row not returned.
- **Known test breakage (reviewer-found, fix in the same task):** `apps/service/src/lists/routes.test.ts:111` asserts the phantom `nextOffset: 1` after seeding exactly one list with `limit: 1` — update to `nextOffset: null`. (Other pagination assertions — contacts:164, suppressions:192, lists:258 — seed 3 rows and survive.)

### 1.2 Corrupt stored permissions → internal error (S-I2, V4)

- Change both `parseStoredPermissions` helpers to fail with `DatabaseError({ operation: "…:parseStoredPermissions", cause })` (the constructor requires `{operation, cause}` — `errors.ts:3-6`) instead of `RequestValidationError`.
- **All four call sites change status 400 → 500 (reviewer-enumerated; each gets a test):**
  1. api-keys `list` via `rowToMetadata` (`api-keys/service.ts:144`);
  2. api-keys `verify` (already surfaced as 500 through `requirePrincipal`'s defect path — this makes the type honest);
  3. api-keys `rotate` (`api-keys/service.ts:175`) — corrupt permissions on rotate now 500 instead of 400;
  4. device-auth `token` (`device-auth/service.ts:281`) — a poll against a corrupt-permissions authorization now returns 500; CLI sees `CliHttpError` exit 4 (acceptable: corrupt server data is not a usage problem). Check `device-auth/routes.test.ts` for assertions this breaks.
- Union cleanup, precisely: `RequestValidationError` can be **removed** from api-keys `list`/`verify` and device-auth `inspect` (their only source was stored-JSON parsing); it **stays** on api-keys `rotate` (user-supplied name/permissions/expiry validation, `service.ts:86-98`) and device-auth `token` (nested `apiKeys.create` validation) and on `approve`/`deny` (user-code validation).
- Tests: seed a real key via `realApiKeys`, corrupt `permissions_json` by direct SQL (`runTestSql`); assert `GET /api/api-keys` → 500 `internal_error`; a request authenticated with the corrupted key → 500; a *different valid* key still succeeds; rotate of the corrupted key → 500; device-auth poll with corrupt stored permissions → 500. **The device-auth poll test must approve the authorization first** — `token` only reaches `parseStoredPermissions` after the `approved_at`/`approved_by_user_id` check (`device-auth/service.ts:277-281`); an unapproved poll returns `authorization_pending` and the test would be green-but-vacuous.

### 1.3 Unknown activation action → 400 (SEC-O1)

- `activate-routes.ts:110`: `activationResult(renderMessage("Unknown activation action."), 400)`.
- Test: POST with `action=frobnicate` + valid CSRF/origin → 400, page body says unknown action, no limiter failure recorded.

### 1.4 Tighten `ApiKeysService.list` contract (Q-A)

- `api-keys/service.ts` `list` accepts `{limit, offset}` as today but returns `{ items, hasMore }` — the service does the limit+1 probe *and* the slice; `api-keys/routes.ts:39-41` just forwards to `paginationMeta(items.length, pagination, hasMore)`. Existing route tests keep passing unchanged (shape identical).

## Phase 2 — CLI behavior fixes

**Files:** `apps/cli/src/commands/{login.ts,logout.ts,context.ts,api-keys.ts}`, `apps/cli/src/client/nusend-api.ts`, `apps/cli/src/config/profiles.ts`, `apps/cli/src/credentials/file-store.ts`, `apps/cli/src/commands/help.ts` + tests.

### 2.1 Fix `login --json` (MF-A, V1, TG-1)

- In `login.ts`, replace the `if (!context.options.json)` guard with both branches: human mode unchanged (stdout); JSON mode writes **one** line to stderr via `console.error(JSON.stringify({ verification: { uri: started.verificationUri, uriComplete: started.verificationUriComplete ?? null, userCode: started.userCode, expiresAt: started.expiresAt } }))` before polling starts.
- Tests (`login.test.ts`): JSON-mode login with scripted `pending → approved`: stderr contains exactly one verification JSON line emitted **before the first poll** — observable because the scripted fetch's poll handler records whether the stderr spy has already fired (the only way to assert ordering with the existing test style); stdout is exactly one final JSON document; human mode unchanged (regression).
- e2e: extend `e2e/cli-service.e2e.test.ts` with a `--json` login asserting the stderr verification line parses and contains the user code.

### 2.2 Reject path-carrying base URLs (C-I1, V2)

- `config/profiles.ts` `normalizeBaseUrl`: after the protocol check, reject when the pathname is anything other than slashes (`!/^\/+$/.test(url.pathname)`) with `Error("Base URL must not include a path (got /prefix). Deploy Nusend at a domain root, e.g. https://nusend.example.com.")`. Slashes-only inputs (`https://host/`, `https://host//` — note `new URL("https://host//").pathname === "//"`) normalize to `https://host`.
- `http.ts:29` stays unchanged (`new URL(path, base + "/")` is correct once base URLs are guaranteed path-free).
- This propagates everywhere automatically: `login` (via `normalizeLoginBaseUrl` → usage exit 2) and required commands (via `resolveProfileForCli`). A **stored** legacy prefixed base URL now errors at use time with the same clear message — acceptable (re-login fixes it); mention in docs (5.2).
- Tests: `nusend login https://host/nusend` → exit 2 with the message; `https://host` and `https://host/` accepted; stored prefixed profile → clear error, not a 404.

### 2.3 Harden `readOption` (C-I2)

- `context.ts:91-94`: if the next token is `undefined` or starts with `--`, throw `UsageError("Missing value for <name>.", 2)` — mirroring `globalOptionValue`. (The V8 pre-pass in 3.2 runs before this, so `--name=value` never reaches this check; phases ship as one change set.)
- Tests: `api-keys create --name --no-expiry` → exit 2 usage error (regression for the exact review repro). The `--name=value` happy-path test lives in 3.2.

### 2.4 Non-destructive env-credential logout (C-I3, V3)

- `logout.ts:10-23`: remove the `store.delete` call in the env path. Output: human — "NUSEND_API_KEY remains active; unset it to log out." plus, when a stored credential exists for the profile, "Stored credential for profile <p> was kept."; JSON — `{ loggedOut: false, reason: "environment_credential", storedCredentialKept: <bool> }`.
- `file-store.ts` `delete`: return early (no write) when the credentials file doesn't exist — needs an explicit existence check (`load()` returns `{credentials:{}}` for both missing and empty files, `file-store.ts:56`, so it can't distinguish).
- Tests: env-set logout leaves a pre-existing stored credential intact (read it back); no `credentials.json` is created when none existed; JSON shape asserted.

### 2.5 Paginate `api-keys list` (C-I4)

- `nusend-api.ts` `listApiKeys` accepts optional `{limit, offset}` and appends query params; `commands/api-keys.ts` list reads `--limit/--offset` (via the hardened `readOption`), passes through, and in human mode appends `More keys available: rerun with --offset <nextOffset>.` when `pagination.nextOffset` is non-null. `--json` already includes `pagination`.
- `help.ts:10`: document the flags.
- Tests: URL/query building; the "more available" hint appears iff `nextOffset` non-null.

## Phase 3 — CLI polish

**Files:** `apps/cli/src/main.ts`, `apps/cli/src/commands/{context.ts,logout.ts}`, `apps/cli/src/testing/service-bridge.ts`, `vitest.config.ts` + tests.

### 3.1 Narrow `--version` position (N-4, V5)

- `main.ts:34-42`: `--version`/`-v` recognized only when it is `parsed.rest[0]`; `--help`/`-h` scanning stays whole-argv (see V5 rationale — first-token-only `--help` degrades `login --help`/`config --help`).
- Tests: `nusend contacts --version` → exit 2 "Unknown contacts command: --version" (with 3.4's subcommand table this needs **no** credential fixture — usage is checked before auth); `nusend --version` / `-v` unchanged; `nusend contacts get --help` still prints global help (regression pin).

### 3.2 `--opt=value` syntax (N-5, V8)

- One argv **pre-pass** at the top of `runCli` (before `parseGlobalOptions`): rewrite each `--x=y` token into `--x`, `y` pairs — splitting on the **first** `=` only, so values containing `=` survive (`--name=a=b` → `--name`, `a=b`). Short-form `-v=x`/`-h=x` is deliberately not handled (contrived; falls through to existing unknown-token handling). Known boolean flags (`--json`, `--no-expiry`, `--revoke`, `--help`, `--version`) given `=value` → `UsageError(…, 2)`. No per-reader changes needed — `parseGlobalOptions`, `readOption`, `optionValues` (`context.ts:96-102`, backing `--permission`), and `commandPositionals` all see normalized tokens.
- Tests: global `--base-url=…`; command `--name=…`; `--permission=contacts:read` grants the permission (regression against the silent-`{}`-permissions failure the reviewer found); `--json=true` → exit 2.

### 3.3 JSON revoke warning (N-6, V6)

- `logout.ts:39-43`: in JSON mode emit `{"warning":{"code":"revoke_failed","message"}}` (one line, stderr); human unchanged. Test asserts stderr parses as JSON in `--json` mode.

### 3.4 Usage before auth for bare families (N-7)

- `main.ts`: before credential resolution, validate the subcommand: define per-family known-subcommand sets (export a small `const subcommands` from each command module or one table in `main.ts` — prefer the table, single file, ~6 lines) and throw `UsageError("Unknown <family> command: …", 2)` when `rest[0]` is missing/unknown. Command modules keep their internal dispatch as a defensive fallback. Test: `nusend mailings` with no credential → exit 2, not 3.

### 3.5 `service-bridge.ts` portability (N-8)

- Copy `preconnect` **conditionally** (`"preconnect" in realFetch`, no type assertion) rather than dropping it — the bridge is assigned to `globalThis.fetch`, whose Bun typing may require the property; conditional copy satisfies both runtimes. Keep the file dependency-free.

### 3.6 Anchor vitest aliases (Q-B)

- `vitest.config.ts`: change the bare alias `find` to the regex `/^@nusend\/api-contract$/` (keep the `/permissions` alias, or generalize to `/^@nusend\/api-contract\/(.*)$/` → `packages/api-contract/src/$1.ts`). Verify with the full suite.

## Phase 4 — Remaining test gaps

### 4.1 Login write-ordering test (TG-2)

- `login.test.ts`: partial-mock `../config/profiles.js` (`vi.mock` with `importActual`) so `saveConfig` records invocation order alongside a recording credential store; assert `store.write` happens strictly before `saveConfig`. This is the primary path; if ESM mocking fights back, fall back to a `saveConfig` that throws via the mock (not via filesystem tricks — config and credentials share one directory tree) and assert the credential file exists while config is unchanged.

### 4.2 win32 `repair-permissions` test (TG-3)

- `config.test.ts`: call with the injectable `platformName: "win32"` (`config.ts:10`); assert "not applicable on Windows" output, exit 0, and no chmod attempted (fake fs or assert files untouched).

### 4.3 Expired-code activation test (TG-4)

- `activate-routes.test.ts`: start a real authorization, direct-SQL its `expires_at` into the past, GET `/cli/activate?code=…` signed in → the "invalid or expired" page, and a lockout failure **is** recorded (documenting current intended behavior).

## Phase 5 — Docs truth pass

1. **README.md:120 (D-1)**: enumerate the full CLI surface (login, logout, whoami, api-keys incl. list pagination, contacts, mailings list/get, config repair-permissions); add a mailings example to the example block.
2. **docs/cli.md (D-2 + new behavior)**: rewrite the logout paragraph for V3 (env credential kept, stored credential kept, how to actually log out); document `login --json`'s stderr verification line (V1), `api-keys list --limit/--offset`, `--opt=value` syntax (V8), the JSON warning envelope (V6), `--version` position (V5), and — for V2 — that path-carrying base URLs are rejected (users with a stored prefixed base URL must re-login with a root URL).
3. **docs/troubleshooting.md:9 (D-3)**: split "keys are rejected" into 401 (invalid/revoked/expired) vs 403 (valid key, missing permission), naming both envelope codes.
4. **docs/deployment.md (SEC-O2, V9)**: extend the trusted-proxy section — the proxy must also **set/overwrite `x-forwarded-proto`** (a direct-exposed plain-HTTP deployment letting clients spoof it would mark the activation CSRF cookie `Secure` and break activation; availability-only impact). Also state that sub-path deployments are unsupported (V2) — deploy at a domain root/subdomain.
5. **docs/api.md**: note corrupt-stored-data responses are 500 `internal_error` (V4). No pagination wording change needed — `docs/api.md:38` *already* claims `nextOffset` is null on the final page; 1.1 makes that claim true (record it as a doc-truth fix, not a new statement).
6. Sweep: `grep -ri "loggedOut\|nextOffset\|--limit" docs README.md` — every hit consistent with final behavior.

## Phase 6 — Validation

1. `pnpm check` (expect new totals > 377 tests; only the 3 pre-existing lint warnings).
2. Clean build (`pnpm build`) + `./apps/cli/dist/main.js --help`/`--version`.
3. Manual smoke via e2e additions (2.1) — no browser flow is touched by this plan, so no agent-browser run is required; record that explicitly.

## Subagent / delegation plan

- Scouting already done in-session (call-site maps recorded above and in the progress note) — no further scout agents needed.
- Single writer for implementation: Phases 1–3 share `context.ts`/`main.ts`/`query.ts`; parallel writers would conflict.
- Read-only reviewer checkpoints: after Phase 2 (CLI behavior — highest regression risk: login/logout flows) and after Phase 6 (cumulative).
- Phase 4 tests and Phase 5 docs may be delegated to one read-write agent each **after** Phase 3 lands, if parallelism is wanted; docs agent must read final behavior, not this plan, as source of truth.

## Data / API / interface changes

- No contract-schema changes. No DB changes.
- HTTP behavior changes: exact `nextOffset` on contacts/lists/suppressions final pages (stale clients unaffected — same shape); corrupt-stored-permissions responses move 400 → 500 on api-keys list (honest server-error semantics); unknown activation action 200 → 400.
- CLI: new stderr JSON lines in `--json` mode (verification, revoke warning) — stdout contract unchanged (exactly one JSON document); `--version` positional narrowing; `=`-syntax accepted; path-carrying base URLs rejected (previously silently mis-targeted).
- Internal: `paginationMeta` gains a required parameter; `ApiKeysService.list` returns `{items, hasMore}`; both are in-repo only.

## Risks and mitigations

- **`vi.mock` ESM partial mocking (4.1) can be brittle** → fallback assertion path specified in the task.
- **V2 breaks users with an already-stored path-prefixed base URL** → they were already broken (requests silently mis-targeted); the new error message tells them exactly what to do; documented in 5.2.
- **`hasMore` required param (1.1) breaks compiles until all call sites are updated** → intended; the compiler enumerates the work (grep confirms: only the five service modules call it). One runtime test assertion also breaks — enumerated in 1.1.
- **1.2 changes device-auth `token` poll status for corrupt stored permissions (400 → 500)** → CLI maps it to exit 4 either way; check `device-auth/routes.test.ts` for affected assertions (task 1.2).
- **Corrupt-permissions 500 (V4) makes one bad row fail the whole key list** → deliberate honesty; the fallback (skip + log) is recorded if operational experience disagrees.

## Definition of Done

- Every traceability row implemented or its recorded no-op (V7) acknowledged; all vetoable decisions implemented as defaulted unless vetoed.
- `login --json` proven usable: unit tests assert the stderr verification line precedes polling and stdout carries exactly one JSON document; the e2e asserts the stderr line parses and contains the user code. (The e2e's synchronous in-bridge approval means it cannot literally drive approval *from* the stderr output — reviewer-confirmed; the unit-level ordering assertion carries that burden.)
- Exact `nextOffset` proven by final-page tests in all five list modules.
- `pnpm check` green; clean build; built CLI help/version run.
- Docs sweep clean; no doc statement contradicted by final behavior.

## Open questions

None blocking — V1–V9 are vetoable defaults.

## Implementation Progress

Tracker created 2026-07-10 (implementation session). Status: `todo` / `in-progress` / `done` / `no-op`.

| Task | Status | Notes |
| --- | --- | --- |
| 1.1 Exact pagination everywhere | done | limit+1 probe in contacts/suppressions/lists (both); lists test phantom `nextOffset:1` fixed; exact-final + probe tests added in all three (mailings/api-keys already had them). Deviation: `paginationMeta` dropped the now-unused `itemsLength` param instead of keeping it dead. |
| 1.2 Corrupt stored permissions → 500 | done | Both `parseStoredPermissions` → `DatabaseError`; unions tightened (api-keys list/verify, device-auth inspect, middleware); tests: list 500, corrupted-key auth 500, valid key OK, rotate 500, approved-poll 500. |
| 1.3 Unknown activation action → 400 | done | 400 + test (10 unknown-action POSTs record no lockout failure). |
| 1.4 ApiKeysService.list returns {items, hasMore} | done | Service probes+slices; route just forwards. |
| 2.1 login --json verification line | done | Stderr line before polling; unit test asserts ordering via fetch-mock recording stderr-spy count; human-mode regression extended; e2e `--json` login added. |
| 2.2 Reject path-carrying base URLs | done | `normalizeBaseUrl` rejects non-slashes pathname; `//` normalizes to root (`/\/+$/`). Unit + CLI-level tests incl. stored prefixed profile → exit 2, no fetch. |
| 2.3 Harden readOption | done | Throws `Missing value for <name>.` (exit 2); regression test for `--name --no-expiry`. |
| 2.4 Non-destructive env logout | done | No delete on env path; `storedCredentialKept` in JSON + human line; `delete`/`hasStored` skip missing credentials file (no file created). |
| 2.5 Paginate api-keys list | done | `--limit/--offset` pass-through, "More keys available" hint iff nextOffset non-null; help.ts updated. |
| 3.1 Narrow --version position | done | First-rest-token only; `--help` stays whole-argv (V5); tests incl. `contacts get --help` pin, no credential fixture needed. |
| 3.2 --opt=value pre-pass | done | `expandEqualsSyntax` before `parseGlobalOptions`, first-`=` split, boolean flags reject `=value`; tests cover `--base-url=`, `--name=a=b`, `--permission=`, `--json=true`. |
| 3.3 JSON revoke warning | done | One `{"warning":{"code":"revoke_failed",...}}` line on stderr in `--json`; human unchanged; test added. |
| 3.4 Usage before auth for bare families | done | Subcommand table in main.ts checked before credential read; `nusend mailings` → exit 2. Command modules keep internal dispatch as fallback. |
| 3.5 service-bridge preconnect portability | done | Deviation: conditional copy alone fails Bun's `typeof fetch` typing (requires `preconnect`), so real-or-noop fallback used — no type assertion, works on both runtimes. |
| 3.6 Anchor vitest aliases | done | Bare alias → `/^@nusend\/api-contract$/`; full suite green. |
| 4.1 Login write-ordering test | done | Deviation: lives in new `login-order.test.ts` (not login.test.ts) so the `vi.mock` of profiles.js cannot leak into other login tests; primary vi.mock+importActual path worked, no fallback needed. |
| 4.2 win32 repair-permissions test | done | Direct `runConfigCommand` call with `platformName: "win32"`; asserts message + untouched modes. |
| 4.3 Expired-code activation test | done | Landed early with 1.3 (same file): expired GET → invalid/expired page; 10 attempts → lockout recorded (403 on fresh code). |
| 5.x Docs truth pass | done | README CLI surface + mailings/config examples; cli.md (logout V3, login --json V1, list pagination, `=` syntax V8, warning envelope V6, --version position V5, base-URL rejection V2 + re-login note); troubleshooting 401 vs 403; deployment x-forwarded-proto + sub-path unsupported (V9); api.md exact-nextOffset truth + corrupt-data 500 (V4). Sweep `loggedOut|nextOffset|--limit` clean. |
| 6 Validation (pnpm check, build, CLI smoke) | done | `pnpm check` green: 398 tests after review fixes (was 377 pre-plan, 395 pre-review-fixes), 3 pre-existing lint warnings only. Clean build; built CLI smoke: --help/--version, path-URL exit 2, `contacts --version` exit 2, bare `mailings` exit 2, `--json=true` exit 2, `--name --no-expiry` exit 2, plus post-fix guards (`logout --version`, `whoami` args, `--name=`, trailing `--permission`, JSON error for `--json=true`). No browser flow touched → agent-browser run not required (recorded per plan). |
| N-1 / V7 main.ts length | no-op | Recorded: pure dispatch/wiring; tracker "131 lines" claim superseded by this plan. |
| Review checkpoint after Phase 2 | done | Fresh-context agent (read-only, background), verdict "no blockers"; 3 minors + 3 nits, ALL FIXED (see log). |
| Final cumulative review | done | Same reviewer session, round 2: all six round-1 fixes verified RESOLVED (incl. empirically on the rebuilt binary); Phase 5 docs checked statement-by-statement against code — no contradictions; DoD confirmed item by item; validation independently reproduced (398/398). Verdict: no blockers, no material concerns. Two cosmetic nits: stale "395" in tracker row (fixed) and residual space-syntax empty values (`--name ""` fails server-side exit 4, `--limit ""` falls back to server default) — ACCEPTED/deferred: outside the plan's V8 scope (the `=`-form was the target class), fails closed, and docs/cli.md scopes the usage-error claim to the `=` form so no doc statement is false. |

### Log

- 2026-07-10: Session start. Plan + planning notes read in full. Index verified clean (`git diff --cached` empty). Working tree carries the prior uncommitted CLI implementation this plan amends. Delegation decision per plan: single writer (Phases 1–3 share `context.ts`/`main.ts`/`query.ts`); reviewer checkpoints after Phase 2 and at the end.
- 2026-07-10: Advisor tool unavailable this session (errored on invocation); relying on the plan's two prior review rounds plus the independent agent-review checkpoints below.
- 2026-07-10: Phase 1 done; only predicted breakage occurred (lists/routes.test.ts phantom `nextOffset:1`). Typecheck enumerated no additional `paginationMeta` call sites beyond the five known.
- 2026-07-10: Phases 2–4 done as one change set. One unpredicted issue: Bun `typeof fetch` typing forced the 3.5 real-or-noop deviation (see row). e2e stdout/stderr assertions filter CLI JSON lines from app console logs.
- 2026-07-10: Phase 1–4 review checkpoint launched (fresh-context general-purpose agent, read-only, background) while Phase 5 docs (out of review scope) were written. Phase 6 validation done: `pnpm check` green (395 tests), clean build, built-CLI smoke of all new usage errors.
- 2026-07-10: Review round 1 returned — **no blockers**; all traceability rows independently confirmed. 3 minors + 3 nits, all accepted and fixed: (1) `logout --version` destructive fallthrough → logout rejects unknown options, whoami rejects any argument; (2) empty `--opt=` inconsistencies (incl. `--permission=` silently creating `{}`-permission keys) → pre-pass rejects empty values, `optionValues` hardened like `readOption`; (3) env-credential revoke warning now `{"warning":{"code":"revoke_unsupported"}}` in `--json`; (4) `hasStored` added to `CredentialStore` interface; (5) `runMain` detects `--json=` for error formatting; (6) mailings read-model slices before decode. Tests added for 1–3 + 5; docs/cli.md updated for the `=`-empty rule and `revoke_unsupported`. Re-validated: `pnpm check` green (398 tests), rebuild + built-binary smoke of every new guard.
