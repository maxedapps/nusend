# Plan: Fix Final Review Findings and Rebuild Test Quality from First Principles

## Summary

Resolve every finding in `.reviews/fix-implementation-review-findings-and-test-quality-implementation-review.md`, clean up the affected logging/sending/CLI code, and replace the current generated-style blanket test audit with a substantive, exact, machine-verifiable audit.

The implementation must preserve the production behavior already proven sound while closing four gaps:

1. the 490-row audit does not contain real per-test judgments;
2. raw CR/LF/control characters make exact identity reconciliation unreliable;
3. arbitrary failure metadata can enter structured logs;
4. a multi-reason post-dispatch Cause can be classified from only its first failure and become retryable.

It must also close the two Low gaps: assert defect sentinels are absent from actual formatted logs, and enforce the documented decimal-only CLI timeout grammar.

“Clean from the ground up” means the old Markdown audit is not patched row by row. Exact test identities and review topology move to a canonical JSON manifest generated from immutable Vitest reports; Markdown becomes a deterministic rendered view; every disposition is manually/substantively reviewed; weak tests are rewritten, merged, or deleted only after stronger evidence exists.

## Confirmed requirements

- Fix all six findings from the final implementation review; no finding is deferred.
- Preserve all already-correct browser activation, queue/dead-attempt, Bun lifecycle, CLI grammar/redirect, SES route, migration, and documentation behavior.
- Keep masked device-code storage, no-resend-after-possible-dispatch, no DB transaction across network I/O, and durable send-attempt/job/delivery audit invariants.
- Treat every unrecognized, mixed, defective, interrupted, empty, or conflicting post-dispatch Cause as terminal ambiguity.
- Emit only fixed, whitelisted structured error metadata; never copy arbitrary `_tag`, constructor name, message, stack, cause properties, headers, query values, bodies, tokens, or PII.
- `NUSEND_HTTP_TIMEOUT_MS` is either absent or an unpadded ASCII decimal safe integer `>= 1`. Invalid values fail with exit 2 before network activity, but local-only commands remain lazy and unaffected.
- Use high-value tests only. No raw test-count target, coverage percentage target, broad snapshots, call-order assertions, copied production logic, or synthetic requests that bypass production wiring.
- Re-audit every collected final test identity. A green full suite is validation evidence, never the sole rationale for retaining a test.
- Keep hosted exact-SHA CI as a separate external gate. Do not claim it passed without URL/ID, head SHA, event, conclusion, and date.
- No database schema/API response changes and no source-control workflow instructions.

## Non-goals

- Reworking already-correct activation, migration, rate-limit, SES protocol, or CLI command behavior without an audit-backed reason.
- Replacing Vitest, Effect, Hono, the logger backend, or the SES adapter architecture.
- Adding a general SQL parser, general error-serialization framework, coverage threshold, or permanent mutation-testing framework.
- Deleting tests merely to reduce counts or keeping tests merely to preserve counts.
- Claiming live SES/SNS validation from local fakes.

## Current-state findings

### Review status

- `.plans/fix-implementation-review-findings-and-test-quality.md` currently says implementation-local `Complete`, but the final review invalidates T35/T36/T39/T40.
- `.progress/fix-findings-test-quality-audit.md` contains 490 final rows, all marked `Retain`; all copy the test title as the invariant; 455 cite only a full-suite pass; all 86 added-key rows share one generic reason.
- `.progress/fix-findings-test-quality-final.json` is valid reporter output and preserves exact control characters. The Markdown conversion does not.

### Effect v4 evidence

Pinned dependency: `effect@4.0.0-beta.93`.

Installed source confirms:

- `Cause<E>.reasons` is a public `ReadonlyArray<Reason<E>>`;
- `Reason<E>` is `Fail<E> | Die | Interrupt`;
- `Fail<E>.error` is public;
- `Cause.findErrorOption` returns only the first error;
- `Cause.fromReasons` and `Effect.failCause` construct multi-reason failures for tests.

Implication: complete Cause classification must inspect every reason; `findErrorOption` cannot establish exclusivity.

### Existing strong boundaries to preserve

- Browser activation submits jsdom-derived rendered controls and has real-browser Approve/Deny evidence.
- D4 injects the exact outcome-write DB failure and verifies same-cycle dead/failed/ambiguous state.
- Bun body cap, in-flight drain, and stale entrypoints use real subprocess/HTTP/socket boundaries.
- CLI redirect tests use two local servers and prove the API key is not forwarded.
- SES multi-topic, UnsubscribeConfirmation, and scheduled-date normalization use mounted routes and durable DB assertions.
- Migration tests use the real CLI and SQLite state.

## Chosen strategy

Use five vertical work packages, followed by a suite-wide audit and final evidence pass:

1. establish honest baseline/status and build exact audit tooling;
2. make CLI timeout syntax strict with no new test seam;
3. extract and lock down safe structured log metadata;
4. extract and make transport Cause classification total and ambiguity-biased;
5. perform the real suite-wide audit, apply evidence-backed test cleanup, and regenerate exact final evidence.

Production changes stay surgical. “Ground up” applies primarily to the audit architecture and to extracting the two safety classifiers into pure modules. The current audit Markdown is superseded as a source of truth rather than incrementally repaired.

## Alternatives considered

### Patch the existing Markdown rows

Rejected. Markdown cannot safely own raw control-character identities, and editing generic prose in place would not prove exact multiset reconciliation or prevent another blanket audit.

### Use only a generated test-name list plus human notes

Rejected. It preserves names but cannot verify baseline-to-final retain/rewrite/merge/delete topology, deletion replacements, or unresolved manual review.

### Add JSON Schema plus a separate executable validator

Rejected as unnecessary dual maintenance. A small runtime validator owns shape and cross-record invariants; adversarial tests document the contract.

### Keep Cause handling inline

Rejected. The no-resend decision is a security/data-integrity boundary with subtle Effect semantics. A pure classifier is easier to review and test without duplicating DB-state assertions.

### Classify multi-reason typed failures by precedence

Rejected. There is no adapter contract for conflicting simultaneous outcomes. Any conflict or extra reason means provider acceptance is not safely known; ambiguity is the conservative outcome.

### Add real cross-process tests for every synthetic defensive branch

Rejected as a blanket rule. A synthetic test may remain when it honestly protects a defensive branch that cannot be deterministically produced at a stronger boundary. It must be named/classified as synthetic and cannot be cited as real concurrency/provider evidence.

## Canonical audit model

### Identity

The canonical identity is a JSON tuple, never a delimiter-parsed Markdown string:

```text
[
  "vitest-json-v1",
  repoRelativePosixFile,
  exactReporterFullName,
  occurrence
]
```

- `exactReporterFullName` is copied from Vitest JSON without trimming, newline conversion, Unicode normalization, or reconstruction from title fields.
- `occurrence` is zero-based among identical `(file, fullName)` entries in reporter order, preserving historical duplicates.
- `id` is SHA-256 over `JSON.stringify(tuple)` for compact references.
- The validator rejects report file paths outside the repository and ambiguous normalization.
- Final test names must be unique by `(file, fullName)`; baseline duplicates remain representable through occurrence ordinals.

### Portable, reviewable evidence layout

Commit the canonical evidence so a clean checkout can review and validate it:

- `docs/test-audit/baseline-inventory.json`
- `docs/test-audit/final-inventory.json`
- `docs/test-audit/manifest.json`
- `docs/test-audit/audit.md` (generated)
- `docs/test-audit/README.md` (format, provenance, commands, evidence limits)

Keep raw Vitest reporter output under ignored `.progress/` because it contains machine-specific absolute paths and nondeterministic timing. Record each raw report’s SHA-256, command, runtime versions, and local/archive path in the portable inventory metadata. A clean checkout validates committed portable identities and can collect a new current report for comparison.

The committed manifest contains:

- `schemaVersion`
- `identityAlgorithm`
- `reports.baseline` / `reports.final`: raw-report SHA-256, Vitest version, collection command/date, success, declared files/tests; **no absolute repository root**
- references to the committed baseline/final inventory files
- `dispositions[]`
- `additions[]`
- `reviewBatches[]`: files fully/partially read, reviewer/artifact, sample method, unresolved limits
- `mutations[]`
- generated-view path/version

Derive the current repository root at runtime with `realpath`. Convert reporter file paths to validated repo-relative POSIX paths before identity hashing. Reject paths outside that real root, `..` traversal, symlink escapes, and ambiguous normalization. Do not persist or hash the absolute root. Document that path matching is byte/case-sensitive after POSIX normalization; case-only collisions fail validation.

Every test receives a concise classification:

- identity edge: `operation`, `from`, `to`;
- concrete invariant/risk (not the title);
- actual boundary **and limitation**;
- exact production wiring path/symbol;
- replacement/removal reason when changed;
- evidence reference.

Use richer detail only for changed, synthetic, security/privacy, concurrency/crash, migration, runtime, and external-protocol tests. New final tests use `additions[]` with exactly one final ID. Batch review records carry reviewer/date/files-read metadata rather than repeating self-attestation 490 times.

Mutation entries retain the eight historical categories and record whether evidence is imported or independently replayed. Imported narrative evidence must never be labeled independently reproduced.

### Strict validator rules

`audit:validate` must fail if:

- a committed inventory/manifest hash, declared total, exact string, occurrence, or computed ID differs;
- a recorded raw-report hash is malformed or lacks provenance; when the exact optional raw report path is supplied, its SHA-256 must match, but clean-checkout validation does not require ignored raw files;
- any baseline ID lacks exactly one disposition source edge;
- any final ID lacks exactly one disposition target or addition;
- an ID is dangling, duplicated, overlapped, or has invalid operation cardinality;
- a retain edge changes identity;
- a rewrite/merge/delete lacks a concrete replacement/removal rationale;
- `invariant` equals the title/full name or contains only it;
- known generic phrases from the invalid audit appear;
- production wiring is absent, points only to tests, or does not resolve;
- evidence is only “full suite passed”;
- a known generic placeholder is used or required concrete fields are empty;
- any record remains unresolved in strict mode;
- the deterministic Markdown view is stale;
- final duplicate names remain;
- hosted status claims `passed` but lacks URL/ID/SHA/event/conclusion/date. Explicit `external-unvalidated` is valid for implementation-local strict validation.

These checks prevent obvious mechanical approval but do not score prose or prove semantic quality. Do not add length quotas or paraphrase detectors that incentivize filler. Objective completion additionally requires exact multiset equality, zero unresolved records, batch files-read inventories, concrete rationales for every changed test, focused run/mutation evidence, and independently sampled review with the sample method recorded.

## Phase 0 — Restore honest status and freeze the new baseline

### Files

- `.plans/fix-implementation-review-findings-and-test-quality.md`
- `.progress/fix-implementation-review-findings-and-test-quality-implementation-review.md`
- `.progress/fix-final-review-findings-and-rebuild-test-audit.md` (new implementation tracker)
- `.progress/final-review-test-quality-baseline.json` (new immutable report)
- `.progress/final-review-remediation-start/` (dirty-worktree snapshot and hashes)

### Tasks

1. Change the old plan’s implementation status from `Complete` to `Superseded / partial after final review`; link this plan and the final review. Do not rewrite historical command results.
2. Create the new tracker with one row per task in this plan. No row starts `Verified` merely because old evidence exists; old evidence may be linked and revalidated.
3. Before source/test edits, snapshot the dirty worktree without changing it:
   - save `git status --porcelain=v1 -z`;
   - save tracked/staged binary patches;
   - copy every pre-existing untracked file into `.progress/final-review-remediation-start/files/` preserving relative paths;
   - record SHA-256 and size for every modified/untracked path;
   - classify each path as initially in scope or protected/unrelated.
4. Establish an initial remediation allowlist for only the exact files in Phases 1–4 and status/docs. Phase 5 may expand it only after a manifest disposition names the test and reason. Unrelated protected paths must remain byte-identical to the starting hash.
5. Explicitly prohibit `git reset`, `git checkout`, `git restore`, `git clean`, deletion of pre-existing untracked files, or bulk formatting outside the allowlist.
6. Before deleting/merging any test, retain its starting blob/patch in the snapshot and record the replacement or intentional-removal rationale.
7. Before source/test edits, collect a fresh Vitest JSON report from the current dirty worktree. Do not assume it still has 72 files/490 cases.
8. Hash and retain the report unchanged. Record command, runtime versions, result, file/test totals, and hash.

### Validation

```sh
pnpm exec vitest run --reporter=json --outputFile=.progress/final-review-test-quality-baseline.json
git diff --check
```

This phase is evidence-only; it must not claim a green code checkpoint beyond the baseline run itself. Before every later phase, compare all protected/unrelated paths to the frozen hashes and stop on drift.

## Phase 1 — Build exact, adversarially tested audit tooling

### Files

Create:

- `scripts/test-quality-audit/core.mjs`
- `scripts/test-quality-audit/cli.mjs`
- `scripts/test-quality-audit/core.test.mjs`
- `scripts/test-quality-audit/independent-check.mjs`
- `scripts/test-quality-audit/fixtures/vitest-identities.json`
- `docs/test-audit/baseline-inventory.json`
- `docs/test-audit/manifest.json`
- `docs/test-audit/audit.md`
- `docs/test-audit/README.md`

Create only after final freeze:

- `docs/test-audit/final-inventory.json`

Rewrite:

- root `package.json` (audit commands only)
- `.github/workflows/ci.yml` after final evidence exists, adding portable audit validation/current-inventory comparison

Retain as historical/local provenance:

- `.progress/fix-findings-test-quality-baseline.json`
- `.progress/fix-findings-test-quality-final.json`
- `.progress/fix-findings-test-quality-audit.md`
- `.progress/fix-findings-test-quality-mutations.md`
- new raw reporter outputs under `.progress/`

### Tool behavior

`core.mjs` owns:

- runtime-derived `realpath` repository root;
- exact reporter inventory extraction;
- validation that absolute reporter paths resolve beneath that root;
- repo-relative POSIX conversion before identity hashing;
- rejection of symlink escapes, `..`, case-only collisions, and ambiguous normalization;
- occurrence assignment before sorting;
- tuple hashing;
- manifest validation and baseline→final ledger topology;
- strict anti-placeholder/anti-blanket checks;
- deterministic visible escaping for Markdown (`\\`, `\r`, `\n`, `\t`, `\u0000`–`\u001f`, `\u007f`, Unicode separators);
- deterministic Markdown rendering.

`cli.mjs` supports noninteractive commands:

```text
import --snapshot baseline|final --report <path> --inventory <path>
validate --manifest <path> [--strict]
compare-report --snapshot final --report <path> --inventory <path>
render --manifest <path> --out <path> --write|--check
```

`independent-check.mjs` imports only Node built-ins and shares no audit-core code. It supports `--mode baseline` before a final inventory exists and `--mode final` after freeze. It parses committed inventories/manifest directly, recomputes tuple IDs and multisets, prints input/script hashes plus missing/extra/multiplicity deltas, and exits nonzero on disagreement.

Rules:

- `import` creates portable inventories and unresolved candidates; it never approves retains or generates substantive rationales.
- baseline→final is the only canonical disposition graph. Optional pre-cleanup reports are working evidence, not graph nodes.
- `validate` never rewrites files.
- `render --write` is the only writer for generated Markdown.
- `render --check` compares bytes and exits nonzero if stale.
- diagnostics identify the exact record/ID and violated rule.

Add package scripts with committed paths:

```json
{
  "audit:test": "vitest run scripts/test-quality-audit/core.test.mjs",
  "audit:validate": "node scripts/test-quality-audit/cli.mjs validate --strict --manifest docs/test-audit/manifest.json",
  "audit:render": "node scripts/test-quality-audit/cli.mjs render --manifest docs/test-audit/manifest.json --out docs/test-audit/audit.md --write",
  "audit:render:check": "node scripts/test-quality-audit/cli.mjs render --manifest docs/test-audit/manifest.json --out docs/test-audit/audit.md --check",
  "audit:independent": "node scripts/test-quality-audit/independent-check.mjs --mode final --manifest docs/test-audit/manifest.json"
}
```

Committed portable evidence makes validation/review possible from a clean checkout. Audit-tool tests remain in ordinary Vitest collection and receive final dispositions. After final freeze, CI additionally creates a temporary ignored Vitest JSON report and compares it with `docs/test-audit/final-inventory.json`; remove the temporary report after comparison.

### High-value tooling tests

Use one adversarial fixture with:

- two identical `(file, fullName)` entries;
- CR, LF, tab, NUL, `U+0001`, `U+2028`, and `U+2029` names;
- a path outside repo and a symlink escape;
- copied-title invariant;
- generic full-suite-only evidence;
- orphan baseline/final IDs;
- overlapping edges;
- invalid retain/rewrite/merge/delete cardinality;
- stale Markdown.

Test distinct failure classes, not every field independently. Required cases:

1. exact import preserves all strings/multiplicity and assigns deterministic occurrences/IDs;
2. rendered Markdown visibly escapes controls and is never parsed back as identity;
3. strict validation accepts one complete valid ledger;
4. one table of invalid ledger/quality fixtures exits with specific diagnostics;
5. changed report bytes/hash and stale rendered output are rejected;
6. the independent checker agrees on the valid fixture and catches a deliberately changed occurrence/control string without importing `core.mjs`.

### Bootstrap

1. Import the new baseline into `docs/test-audit/baseline-inventory.json`; store raw-report hash/provenance but no absolute root.
2. Reference old baseline/final reports only as historical provenance; do not use the old final report as this plan’s final graph node.
3. Initialize every baseline classification unresolved; non-strict validation may check identity/shape, while strict validation intentionally fails.
4. Import historical mutation prose as `historical/imported-not-replayed`.
5. Generate the first Markdown view with a prominent `GENERATED — DO NOT EDIT` header.

### Green checkpoint

```sh
pnpm audit:test
node scripts/test-quality-audit/cli.mjs validate --manifest docs/test-audit/manifest.json
pnpm audit:render
pnpm audit:render:check
node scripts/test-quality-audit/independent-check.mjs --mode baseline --manifest docs/test-audit/manifest.json
```

At bootstrap, non-strict validation and the explicit baseline-mode independent check may pass; strict final topology must remain red until final inventory and substantive review are complete.

## Phase 2 — Make CLI timeout parsing exactly match the documented grammar

### Files

- `apps/cli/src/client/http.ts`
- `apps/cli/src/main.test.ts`
- `PROJECT.md`

### Implementation

1. Remove trimming from `parseHttpTimeoutMs`.
2. Validate the original string with ASCII `^\d+$`.
3. Convert the original string and require `Number.isSafeInteger(parsed) && parsed >= 1`.
4. Preserve:
   - absent value → `30_000`;
   - dependency-neutral `Result` return;
   - command-layer `UsageError` mapping;
   - lazy parsing only when an HTTP client is needed;
   - login/authenticated/revoke composition;
   - timeout/network error envelopes.
5. Clarify in `PROJECT.md` that surrounding whitespace is invalid.

### High-value tests

- Extend the existing invalid-timeout composition table with representative padded values: one space-padded numeric and one tab/newline-padded numeric.
- Keep the existing authenticated/login/revoke loop and assert exit 2 plus zero fetches.
- Do not add a separate pure parser test; composition coverage is stronger and already proves lazy/no-network behavior.
- Retain the hung-fetch timeout test because it protects AbortSignal wiring, a distinct invariant.

### Green checkpoint

```sh
pnpm exec vitest run apps/cli/src/main.test.ts apps/cli/src/client/http.test.ts
pnpm --filter @nusend/cli typecheck
pnpm --filter @nusend/cli build
git diff --check -- apps/cli PROJECT.md
```

## Phase 3 — Rebuild safe structured failure metadata around fixed values

### Files

Create:

- `apps/service/src/observability/safe-log-fields.ts`
- `apps/service/src/observability/safe-log-fields.test.ts`

Rewrite:

- `apps/service/src/http/respond.ts`
- `apps/service/src/http/respond.test.ts`
- `apps/service/src/app.ts`
- `apps/service/src/app.test.ts`
- affected imports in auth/activation tests if needed

Delete/merge after replacement:

- move pure path/method/operation sanitization assertions from `http/respond.test.ts` into `safe-log-fields.test.ts`;
- remove `defectName`, `taggedName`, and arbitrary `getTag` helpers from `respond.ts`;
- do not delete production-wired `createApp`/`runRoute` exactly-once tests.

### Fixed metadata contract

`safe-log-fields.ts` owns:

- `sanitizedLogPath`;
- `safeRequestMeta`;
- `safeLogFields`;
- fixed operation allowlists/prefixes.

Failure classification:

- first record the concrete `logCause` call-site inventory:
  - `runRoute` / auth middleware: `AuthError`, `DatabaseError`;
  - `runHtmlRoute` / activation: `DatabaseError` and auth/database failures that escape the program;
  - `runWebhookRoute`: `DatabaseError`, `SnsConfirmationError`;
  - Hono `onError`: defect only;
- whitelist only classes proven by that inventory (`AuthError`, `DatabaseError`, `SnsConfirmationError`);
- use an exception-safe `safeInstanceOf` wrapper; a Proxy with a throwing `getPrototypeOf` must fall back to `Unknown` rather than defecting the logger;
- emit fixed literals for known classes and `Unknown` for every other failure value;
- expose an allowlisted operation only for known classes and existing safe operation rules.

Defect classification:

- fixed built-in literals only (`TypeError`, `RangeError`, `ReferenceError`, `SyntaxError`, generic `Error`), ordered most-specific first;
- fixed primitive categories where useful;
- every arbitrary object/function/custom Error subclass falls back to `Error` or `Unknown` without reading constructor names, `_tag`, message, stack, symbols, getters, or custom properties;
- wrap the entire classifier in a nonthrowing boundary; even hostile Proxy traps return fixed `Unknown`;
- mixed/multiple reasons emit a fixed `Multiple` or `Unknown`, never derived text.

Preserve existing access-log behavior except import movement caused by extracting `sanitizedLogPath`. Do not broaden this phase into access-method policy changes. Preserve one error event plus one access-completed event.

### High-value tests

`safe-log-fields.test.ts`:

1. hostile defect/failure objects with sentinel `_tag`, custom constructor, throwing getters, and a Proxy whose `getPrototypeOf` throws; mapper returns fixed fields and never throws or contains sentinels;
2. one table for known internal classes and safe/unsafe operation values;
3. request path/method sanitization, including unsubscribe token, auth route, resource ID, query, and unknown method/path.

`respond.test.ts` / `app.test.ts`:

1. retain typed error-envelope mapping and exactly-once runtime behavior;
2. format captured `Logger.Options` through pinned `Logger.formatJson.log(entry)`—the same formatter behind `Logger.consoleJson`—and assert the complete emitted JSON excludes defect/query/header/body/token sentinels;
3. preserve one production-wired onError probe and one `runRoute` defect path because they protect distinct composition boundaries;
4. avoid full snapshots; assert fixed allowed fields and absence of sentinels.

### Fail-before proof

Before implementation, use a temporary ignored repro under `.progress/repros/` (or a one-off Node probe) that imports current production code and records the sentinel `_tag` leak. Record command, output, and repro hash, then delete only that newly created temporary artifact. Do not edit and restore any dirty tracked file for fail-before evidence. After implementation, run the real tracked regression test and record the pass in the new mutation ledger.

### Green checkpoint

```sh
pnpm exec vitest run apps/service/src/observability/safe-log-fields.test.ts apps/service/src/http/respond.test.ts apps/service/src/app.test.ts
pnpm --filter @nusend/service typecheck
git diff --check -- apps/service/src/observability apps/service/src/http apps/service/src/app.ts apps/service/src/app.test.ts
```

## Phase 4 — Make post-dispatch Cause classification total and ambiguity-biased

### Files

Create:

- `apps/service/src/sending/transport-failure.ts`
- `apps/service/src/sending/transport-failure.test.ts`

Rewrite:

- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/sending/process-delivery.test.ts`
- `apps/service/src/testing/layers.ts` only if a reusable formatted-log capture helper is justified

### Pure classifier

Define a closed decision type:

```text
{ kind: permanent | retryable | ambiguous; message: fixed string; explicit: boolean }
```

Inspect `cause.reasons` directly using `Cause.isFailReason`, `Cause.isDieReason`, and `Cause.isInterruptReason`.

Rules:

1. One or more reasons, all safely recognized as `Fail(EmailTransportError)`, all with the same validated `kind` → preserve that explicit kind and fixed `Email transport <kind> failure.` message. Wrap `instanceof` and `kind` access in one exception-safe helper; a hostile Proxy or getter falls back to ambiguity rather than defecting after dispatch.
2. Empty cause → unexpected terminal ambiguity.
3. Any `Die` or `Interrupt` → unexpected terminal ambiguity.
4. Any Fail whose error is not `EmailTransportError` → unexpected terminal ambiguity.
5. Multiple typed failures with conflicting kinds → unexpected terminal ambiguity.
6. Never inspect/persist/log nested `cause`, operation, message, stack, or arbitrary properties for the unexpected branch.
7. Unexpected message remains exactly `Unexpected email transport failure after dispatch.`

`processSendDeliveryJob` switches on this decision:

- permanent → record permanent and return handled;
- ambiguous → record ambiguous and return handled;
- retryable → record retryable and fail with sanitized `SendProcessorError`;
- any ambiguity-write `DatabaseError` propagates to D4 recovery unchanged.

Remove `Cause.findErrorOption`/`Option` from this boundary.

### High-value tests

`transport-failure.test.ts` covers classifier-only branches not already proven through expensive DB scenarios:

- multiple identical typed failures preserve one kind;
- one fallback table covering empty, die, interrupt, untyped fail, mixed typed/untyped, conflicting typed kinds, and a Proxy that throws during `instanceof`/kind access.

Existing process-delivery tests already prove singular permanent/ambiguous/retryable integration behavior; do not duplicate those in the pure table.

`process-delivery.test.ts`:

1. retain the existing ordinary-defect and typed-looking-defect rows because they protect two prior distinct regressions; share one assertion helper instead of copying setup/assertions;
2. add one mixed multi-reason `Effect.failCause(Cause.fromReasons(...))` integration row with retryable typed + untyped failure;
3. each row proves the boundary-specific outcome: one dispatch, finished ambiguous attempt, failed delivery, terminal job/mailing, zero second-cycle claims/sends;
4. pass a captured logger sink and format entries with the production JSON formatter; assert provider sentinels are absent from persistence and logs;
5. retain existing typed permanent/retryable/ambiguous tests and do not create another DB integration file.

### Fail-before proof

Create a temporary ignored repro under `.progress/repros/` that wires a retryable typed reason first plus an untyped reason through the current worker boundary. Record its hash, command, and requeue/redispatch failure, then delete only the temporary repro. Do not modify/restore dirty tracked source for fail-before evidence. After implementation, the tracked integration row records terminal behavior and no sentinel.

### Green checkpoint

```sh
pnpm exec vitest run apps/service/src/sending/transport-failure.test.ts
pnpm --filter @nusend/service test src/sending/process-delivery.test.ts --testTimeout=30000
pnpm --filter @nusend/service test src/queue/runner.test.ts --testTimeout=30000
pnpm --filter @nusend/service typecheck
git diff --check -- apps/service/src/sending apps/service/src/queue
```

## Phase 5 — Perform the substantive suite-wide audit and apply test cleanup

This is the largest phase and must not be replaced by generated prose.

### Stable inputs

After Phases 1–4 and focused greens:

1. optionally collect `.progress/final-review-test-quality-working.json` for reviewer convenience; it is working evidence only and never a manifest graph node;
2. rename any raw-control or duplicate parameterized test names before final dispositions:
   - in `apps/service/src/services/email-transport-ses.test.ts`, use explicit labels such as `CR`, `LF`, and `U+0001` rather than interpolating raw values;
   - preserve adversarial values in test inputs/assertions;
   - require unique final `(file, fullName)` identities.

### Review method

Partition the suite into bounded read-only review batches:

1. CLI/config/credentials/e2e;
2. HTTP/auth/API keys/contacts/lists/mailings/suppressions;
3. database/migrations/queue/sending;
4. AWS/SES/SNS/unsubscribe;
5. test/audit tooling and shared harnesses.

Each reviewer must:

- read every test file in its batch and relevant production callers in full;
- list files fully/partially read and skipped;
- provide one manifest-ready record per collected identity;
- identify the concrete invariant/distinct failure mode;
- name the strongest actual boundary, not an aspirational boundary;
- name production paths/symbols whose breakage would fail the test;
- state mocking/synthetic limitations;
- choose retain/rewrite/merge/delete/add;
- name replacements and smallest safe changes;
- flag uncertainty instead of approving by default.

The main implementation lane is the sole manifest/test writer. It spot-verifies every delete/merge/rewrite and a risk-based sample of retains. Review artifacts are inputs, not accepted dispositions.

### Retention criteria

Retain a test only if it distinctly protects at least one:

- public HTTP/CLI behavior;
- security/privacy/permission invariant;
- durable DB/queue/sending state;
- concurrency/crash recovery;
- production runtime/driver/lifecycle behavior;
- external protocol/contract behavior;
- migration/rollout safety;
- canonical audit-tool/evidence integrity.

Rewrite/merge/delete tests that:

- combine independent commands/failures so an early assertion masks later behavior;
- reconstruct requests/forms instead of submitting generated output;
- clone production middleware/classification logic;
- assert only mocks, call order, SQL text, or helper implementation;
- repeat a stronger boundary with no distinct failure mode;
- use a sentinel absent from all inputs and call it redaction coverage;
- call a synthetic branch real concurrency/provider/entrypoint coverage;
- retain assertion noise merely because the test passes.

A combined test may remain when one scenario/transaction naturally protects a single invariant and splitting would duplicate expensive setup without improving diagnosis.

### Mandatory reassessment queue

Read and explicitly decide, without assuming deletion:

- `apps/cli/src/commands/contacts.test.ts` combined get/update/delete scenario;
- broad/combined error and grammar cases in `apps/cli/src/main.test.ts`;
- numeric/default/config issue tables in `apps/service/src/config.test.ts`;
- CRUD aggregations in contacts/lists/API-key/operations/mailings route tests;
- `apps/service/src/mailings/idempotency.test.ts` synthetic UNIQUE-insert recovery test:
  - retain only as honestly named branch-injection coverage;
  - strengthen to assert the complete replayed DTO and rolled-back durable state;
  - do not claim real cross-process concurrency unless a deterministic real two-connection test replaces it;
- setup-guide’s removed `secret-value` assertion: record intentional removal as assertion noise because the sentinel never entered the input; do not restore it;
- SNS verifier URL/cache/fetch-failure matrices and webhook combined cases;
- shared test-layer helper tests: retain only for distinct harness/lifecycle invariants and never count them as production behavior.

### Applying dispositions

For every rewrite/merge/delete:

1. add or identify the stronger replacement first;
2. run the owning focused suite;
3. delete/merge only after the replacement passes;
4. update manifest topology and rationale immediately;
5. ensure no behavior is silently dropped;
6. do not create a new test solely to keep totals stable.

### Audit evidence quality

- A full-suite pass may appear as final validation but never as the only evidence.
- Critical invariants require mutation/fail-before or real runtime/manual evidence where feasible.
- Synthetic branch tests explicitly say `synthetic` in boundary/risk fields.
- Historical mutations remain `imported-not-replayed` unless rerun in this phase.
- The logging and mixed-Cause mutations from Phases 3–4 must be newly replayed and linked to exact final IDs.

### Completion gate

Strict validation remains red until:

- every baseline ID has exactly one disposition;
- every final ID has exactly one admission edge;
- no unresolved classification remains;
- no generic/copied rationale remains;
- no unresolved duplicate final names remain;
- generated Markdown is byte-current;
- batch records list every test/source file read or skipped;
- every changed test has a concrete replacement/removal rationale and focused result;
- the two new regressions have recorded mutation/repro evidence;
- an independent reviewer samples all security/concurrency/migration/runtime/synthetic entries plus a deterministic sample from every other batch; the sample algorithm/seed, reviewed IDs, findings, and residual limits are recorded. Reviewer feedback is residual assurance, not mathematical proof.

## Phase 6 — Regenerate final reports, reconcile, and correct documentation/status

### Files

- `.progress/final-review-test-quality-final.json` (local raw report)
- `docs/test-audit/final-inventory.json`
- `docs/test-audit/manifest.json`
- `docs/test-audit/audit.md`
- `docs/test-audit/README.md`
- `.progress/fix-final-review-findings-and-rebuild-test-audit.md`
- `.plans/fix-implementation-review-findings-and-test-quality.md`
- `PROJECT.md`
- `docs/observability.md` only if its existing structured-log safety contract needs fixed-category clarification
- `.github/workflows/ci.yml`

### Tasks

1. Freeze all production tests and audit-tool code/tests before final collection.
2. Collect the final raw JSON report; do not hand-edit it. Import it into committed `final-inventory.json` and complete the direct baseline→final graph.
3. If any test or audit-tool test changes afterward, invalidate the raw report/final inventory, recollect, and reconcile again. Repeat until one collection is followed by no test-source changes.
4. Run strict validation and deterministic render check.
5. Run `independent-check.mjs`; record its script SHA, report/inventory/manifest hashes, exact multiset hashes, and zero deltas. It must not import audit-core code.
6. Record baseline/final totals only as reconciliation metadata.
7. Update user/operator docs narrowly:
   - `PROJECT.md`: timeout values permit no surrounding whitespace and list portable audit commands;
   - `docs/observability.md`: fixed safe categories only if needed to clarify its existing no-secret logging contract;
   - do not document internal Cause-classifier architecture unless an existing operator contract requires it.
8. Add CI steps that validate/render-check committed evidence, collect a temporary current report under the runner temp directory, and compare normalized identity multisets/totals/success to `final-inventory.json`—never raw report bytes/timing. Remove the temp report in an `if: always()` cleanup step (or equivalent `trap`/finally). This may rerun tests; correctness is preferred over hidden drift.
9. Keep the old plan marked historical/superseded; do not retroactively erase its incorrect completion period.
10. Mark this plan complete only when every implementation-owned row is verified.
11. Keep hosted CI external/unvalidated until exact evidence exists.

### Validation

```sh
pnpm exec vitest run --reporter=json --outputFile=.progress/final-review-test-quality-final.json
pnpm audit:validate
pnpm audit:render
pnpm audit:render:check
pnpm audit:test
pnpm audit:independent
node scripts/test-quality-audit/cli.mjs compare-report --snapshot final --report .progress/final-review-test-quality-final.json --inventory docs/test-audit/final-inventory.json
```

## Phase 7 — Final validation and independent review

### Focused gates

```sh
pnpm exec vitest run apps/cli/src/main.test.ts apps/cli/src/client/http.test.ts
pnpm exec vitest run apps/service/src/observability/safe-log-fields.test.ts apps/service/src/http/respond.test.ts apps/service/src/app.test.ts
pnpm exec vitest run apps/service/src/sending/transport-failure.test.ts apps/service/src/sending/process-delivery.test.ts apps/service/src/queue/runner.test.ts --testTimeout=30000
```

### Package/repository gates

```sh
pnpm --filter @nusend/service test
pnpm --filter @nusend/cli test
pnpm --filter @nusend/api-contract build
pnpm --filter @nusend/cli build
pnpm typecheck
pnpm check
pnpm audit:test
pnpm audit:validate
pnpm audit:render:check
pnpm audit:independent
node scripts/test-quality-audit/cli.mjs compare-report --snapshot final --report .progress/final-review-test-quality-final.json --inventory docs/test-audit/final-inventory.json
git diff --check
```

### Runtime/manual gates

- Rerun browser Approve and Deny only if audit-driven cleanup touches activation/test runtime code; otherwise retain the recent independently verified evidence and record why no rerun was needed.
- Rerun real Bun body-cap/drain/stale-entrypoint tests if shared logging/runtime/test-harness code changes affect them.
- Verify temporary servers, workers, browsers, and ports are closed.
- No live SES/SNS requirement is added; record that boundary as unvalidated.

### Independent reviews

Use fresh read-only reviewers for:

1. logging privacy/Effect correctness;
2. sending no-resend/state-machine correctness;
3. audit identity/topology/anti-blanket integrity;
4. adversarial test-quality sampling across all batches;
5. final plan-to-implementation reconciliation.

Reviewers must use reason-bearing disabled acceptance gates, inspect actual files/reports, and return path/line evidence. The test-quality reviewer inspects every changed, deleted, merged, synthetic, security/privacy, concurrency/crash, migration, runtime, and external-protocol entry, plus at least 10 unchanged entries per batch selected by the lexicographically lowest SHA-256 of `${finalInventorySha256}:${entryId}`. Record the inventory hash, selected IDs, files read/skipped, findings, and residual limits. Resolve material feedback and return to the same reviewer session where possible.

### External landing gate

When an ordinary hosted trigger exists, record:

- workflow URL and run ID;
- exact head SHA;
- event;
- `check` job conclusion;
- date.

Until then, status is `External/unvalidated`, not failed and not passed.

## File-operation manifest

| Path | Operation | Replacement / purpose |
|---|---|---|
| `.plans/fix-implementation-review-findings-and-test-quality.md` | Rewrite status only | Mark historical plan superseded/partial; link this remediation plan |
| `.progress/fix-final-review-findings-and-rebuild-test-audit.md` | Create | New implementation tracker |
| `.progress/final-review-test-quality-baseline.json` | Create | Immutable pre-change report |
| `.progress/final-review-remediation-start/` | Create local evidence | Dirty status, patches, untracked backups, per-path hashes/ownership |
| `.progress/final-review-test-quality-working.json` | Optional local evidence | Reviewer convenience only; never a graph node |
| `.progress/final-review-test-quality-final.json` | Create local evidence | Immutable final raw report |
| Existing `.progress/fix-findings-test-quality-*` | Retain historical | Never use as new canonical source |
| `docs/test-audit/baseline-inventory.json` | Create/commit | Portable exact baseline identities and raw-report provenance |
| `docs/test-audit/final-inventory.json` | Create/commit after freeze | Portable exact final identities and raw-report provenance |
| `docs/test-audit/manifest.json` | Create/commit | Canonical direct baseline→final dispositions/evidence |
| `docs/test-audit/audit.md` | Create/generated/commit | Human view rendered only from manifest |
| `docs/test-audit/README.md` | Create/commit | Format, commands, provenance, limitations |
| `scripts/test-quality-audit/core.mjs` | Create | Portable identity, topology, validator, renderer logic |
| `scripts/test-quality-audit/cli.mjs` | Create | Noninteractive import/validate/compare/render CLI |
| `scripts/test-quality-audit/independent-check.mjs` | Create | Node-built-in-only independent multiset checker |
| `scripts/test-quality-audit/core.test.mjs` | Create | Adversarial lifecycle/evidence tests |
| `scripts/test-quality-audit/fixtures/vitest-identities.json` | Create | Duplicates/control/path/ledger fixture |
| root `package.json` | Rewrite scripts only | Add explicit audit commands |
| `apps/cli/src/client/http.ts` | Rewrite | Strict untrimmed decimal parser |
| `apps/cli/src/main.test.ts` | Rewrite/merge | Add padded values to existing no-fetch matrix; audit cleanup |
| `PROJECT.md` | Rewrite narrowly | Strict timeout syntax and portable audit commands |
| `docs/observability.md` | Rewrite only if needed | Clarify existing fixed-safe-category/no-secret contract |
| `apps/service/src/observability/safe-log-fields.ts` | Create | Fixed pure whitelist mapping |
| `apps/service/src/observability/safe-log-fields.test.ts` | Create | Hostile metadata and safe request/operation tests |
| `apps/service/src/http/respond.ts` | Rewrite/clean | Consume safe mapper; remove arbitrary-name helpers |
| `apps/service/src/http/respond.test.ts` | Rewrite/merge | Keep route mapping; move pure mapper tests |
| `apps/service/src/app.ts` | Rewrite imports only if extraction requires | Preserve access-log policy; consume moved sanitizer |
| `apps/service/src/app.test.ts` | Rewrite | Assert production-formatted safe logs |
| `apps/service/src/sending/transport-failure.ts` | Create | Total Cause classifier |
| `apps/service/src/sending/transport-failure.test.ts` | Create | Compact full-Cause classification table |
| `apps/service/src/sending/process-delivery.ts` | Rewrite/clean | Switch on total decision; remove first-error logic |
| `apps/service/src/sending/process-delivery.test.ts` | Rewrite/merge | Mixed Cause, no resend, complete log redaction |
| `apps/service/src/services/email-transport-ses.test.ts` | Rewrite names only unless audit finds more | Replace raw-control titles with explicit labels |
| Other existing test files | Retain/rewrite/merge/delete only after full audit | Every operation recorded in canonical manifest |
| `vitest.config.ts` | Retain unless implementation proves exclusion necessary | Avoid separate project/self-reference complexity |
| `.github/workflows/ci.yml` | Rewrite after final freeze | Validate/render-check committed audit and compare temporary current report |
| No migration/API contract file | No change | No schema or public DTO change |

## Delegation and ownership

### Sequential / one writer

- Audit tooling core/manifest/rendering.
- Logging mapper plus shared respond/app tests.
- Sending classifier plus process-delivery tests.
- Test rewrites/deletions and canonical manifest updates.
- Final tracker/status synthesis.

### Safe parallel read-only work

- Per-subsystem test-quality batches.
- Effect Cause/source validation.
- Independent manifest/report multiset checker.
- Logging/sending/security review.
- Final plan-compliance review.

Do not launch parallel writers into the dirty worktree. Subagents may write only isolated output artifacts; the main lane synthesizes project changes.

## Traceability

| Final review finding / improvement | Plan coverage |
|---|---|
| High: blanket-retain audit | Phases 0, 1, 5, 6 |
| Medium: control-character identity mismatch | Phase 1 canonical tuple/escaping; Phase 5 descriptive test names |
| Medium: arbitrary `_tag`/constructor log leak | Phase 3 |
| Medium: first-error mixed Cause can retry | Phase 4 |
| Low: defect sentinel not checked in logs | Phase 3 production formatter contract + Phase 4 worker integration |
| Low: padded timeout accepted | Phase 2 |
| Plan-quality overclaim / mixed historical status | Phases 0 and 6 |
| Test cleanup / high-value-only request | Phase 5 retention rules and reassessment queue |
| Synthetic idempotency test improvement | Phase 5 mandatory reassessment |
| Raw-control parameterized titles | Phases 1 and 5 |
| Historical mutation honesty | Phases 1, 5, 6 |
| Hosted exact-SHA CI caveat | Phases 6–7 external gate |

## Risks and mitigations

- **Audit tooling creates a new false-confidence layer:** validator checks structure/anti-placeholders only; every disposition still requires actual test/source reading and independent review.
- **Huge manifest becomes unreviewable:** generated Markdown groups by subsystem/disposition/risk; JSON owns exact data; reviewers work in bounded batches.
- **Identity drift during cleanup:** baseline→final is the only graph; working reports are noncanonical; freeze all test/tool code before final collection and recollect whenever any test source changes afterward.
- **Occurrence instability:** occurrence is assigned before sorting; final duplicate names are forbidden and must be descriptively renamed.
- **Overfitting anti-blanket checks:** reject known placeholders/exact copies and require concrete fields, but do not encode arbitrary prose-length quotas as quality.
- **Logging observability becomes too vague:** enumerate only known internal classes and fixed built-ins; unknown remains safely `Unknown`; preserve allowlisted operation fields.
- **Getter/proxy side effects while classifying logs/sending:** guard every `instanceof`/typed-kind read in a nonthrowing helper; hostile proxies fall back to fixed `Unknown`/ambiguity.
- **Duplicate send regression:** any non-uniform complete Cause is terminal ambiguity; worker integration proves no second dispatch.
- **Effect beta API drift:** pin tests to installed `Cause.reasons`/Reason predicates and typecheck against beta.93; update intentionally with dependency upgrades.
- **Test count falls:** acceptable. Completion depends on protected invariants, exact reconciliation, and green gates.
- **Test count rises from tooling:** acceptable only because tooling tests protect audit/lifecycle integrity and receive substantive final dispositions.
- **Historical evidence overstated:** imported mutation/browser evidence carries explicit provenance; only rerun evidence is labeled independently reproduced.
- **Dirty-worktree damage:** snapshot dirty patches/untracked blobs and per-path hashes; use a narrow expandable allowlist; verify protected paths byte-identical; single writer; no reset/restore/checkout/clean.

## Definition of Done

### Implementation-owned completion

- All six final review findings are fixed and have fail-before or equivalent concrete evidence.
- Timeout grammar rejects padded numerics before fetch for authenticated, login, and revoke paths; local commands remain lazy.
- Structured internal-error logs emit only fixed allowlisted failure metadata, and production-formatted entries exclude hostile sentinels; existing access-event behavior remains regression-tested.
- Complete post-dispatch Causes are classified by all reasons; mixed/unknown/defect/interrupt/conflict paths cannot requeue or resend.
- D3 persistence and actual formatted logs contain no provider defect sentinel.
- Canonical JSON preserves exact reporter strings, control characters, paths, and duplicate multiplicity.
- Generated Markdown visibly escapes controls and is byte-current; it is never parsed as identity.
- Every baseline identity has one explicit disposition; every final identity has one admission edge.
- Every final test has a concise concrete invariant/risk, actual boundary/limitation, production wiring, operation, and evidence reference; changed/synthetic/critical tests carry richer rationale as specified.
- Every deleted/merged/rewritten test names a stronger replacement or explicit intentional removal.
- No generic/copied blanket rows, unresolved reviews, duplicate final identities, dangling IDs, or stale views remain.
- Every audit-identified weak/duplicated/false-confidence test has an applied disposition; synthetic tests are honestly labeled. No claim is made that test quality is mathematically complete beyond the recorded review scope and evidence.
- Focused tests, service/CLI tests, builds, typecheck, `pnpm check`, audit-tool tests, strict audit validation, render check, and `git diff --check` pass.
- Fresh reviewers complete the documented critical-plus-deterministic sample, material findings are resolved or explicitly bounded, and residual assurance limits are recorded.
- Committed `docs/test-audit/*` validates from a clean checkout; current-report comparison matches the frozen final inventory; the independent checker reports zero deltas.
- Protected dirty-worktree paths remain byte-identical to the starting snapshot unless explicitly admitted to the remediation allowlist.
- Temporary processes/tools are stopped.

### External completion

- Hosted CI succeeds for the exact reviewed SHA with recorded run evidence. Until available, this remains explicitly `External/unvalidated` and does not block honest implementation-local completion.
