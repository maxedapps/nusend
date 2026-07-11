# Plan: Correct Test-Audit Records, Renderer Lineage, and Completion Status

## Summary

Correct the finite set of demonstrably generic or inaccurate records in `docs/test-audit/manifest.json`, repair the false replacement explanation for deleted renderer test `f7ad7dc9…`, and restore honest implementation status through a manifest-only remediation and fresh independent review.

This plan implements only items **3–5** from the follow-up decision:

1. correct weak manifest records;
2. fix the renderer deletion record;
3. reopen status, revalidate, complete the scoped remediation, and keep the original tracker partial until excluded portability work is done.

It intentionally does **not** implement the separate portability work proposed in items 1–2: committing review artifacts or teaching strict validation to hash them.

## Confirmed requirements and assumptions

- Preserve production code and behavior.
- Default to a **manifest-only correction**: do not edit tests or audit-tool code unless source inspection proves an important behavior is genuinely unprotected.
- Shared boundary/limitation prose may remain when tests truly execute the same boundary. Every corrected record must still identify its own fixture, endpoint, error, state transition, or assertion.
- Do not rewrite all 615 records. Use the finite mandatory queue below plus an objective duplicate-risk scan.
- `docs/test-audit/audit.md` remains generated; never edit it directly.
- Keep the final raw report and `final-inventory.json` unchanged if no test or audit-tool test source changes.
- If any test or audit-tool test changes, stop the manifest-only path and follow the full refreeze branch defined below.
- Hosted exact-SHA CI and live SES/SNS remain `External/unvalidated`.
- No schema, API, CLI, migration, production logging, or sending behavior changes.
- No source-control workflow instructions.

## Current state

- Final inventory: 75 files / 615 tests; SHA-256 `5fa324c012bc0780a38cc5757abb96526db22f7d4467b59e7a090b72024a1672`.
- Final raw report: `.progress/final-review-test-quality-final.json`; SHA-256 `483ef42402f179707531e01e73c279bb10e5be51ad9538816eb47974f31b225b`.
- Canonical manifest currently passes strict structural validation but contains:
  - 12 records with generic “scenario block” evidence;
  - 8 records with bare/incomplete `expect(` fragments;
  - 5 SES authorization rows whose invariant/evidence does not identify the endpoint;
  - one renderer deletion record with inaccurate replacement lineage;
  - 10 additional duplicated-invariant records that require explicit source-backed differentiation.
- `.progress/fix-final-review-findings-and-rebuild-test-audit.md` currently marks overall status and T30/T31/T33/T34/T37/T39/T41 complete despite the later review.
- Existing production/test validation is green. This remediation is evidence correctness, not a production bug fix.

## Chosen strategy

Use a bounded, single-writer, manifest-only correction:

1. reopen the affected completion claims before editing canonical evidence;
2. build a checked queue of exact record IDs and final test identities;
3. rewrite each record from actual test assertions and production wiring;
4. correct the renderer deletion as an evidence/lineage decision without changing tests;
5. regenerate the Markdown view and run all identity/topology/full-suite gates;
6. obtain a fresh independent semantic review of every changed record and the unchanged inventory relationship;
7. append one scoped closure entry and leave the original implementation status honestly partial because portability items 1–2 remain unresolved.

This avoids invalidating the frozen 615-test inventory while still correcting every confirmed record defect.

## Alternatives considered

### Add a renderer test for `unsubscribeUrl === null`

Rejected by default. The removed assertion targets an intermediate `RenderedEmail` field. Higher-value existing behavior proves:

- ordinary `Max` substitution at the worker boundary (`apps/service/src/sending/process-delivery.test.ts:159-167`);
- transactional sends produce no unsubscribe headers (`apps/service/src/sending/fake-workflow.integration.test.ts:77-92`);
- marketing rendering still returns the unsubscribe URL (`apps/service/src/sending/render.test.ts:43-53`);
- missing unsubscribe URL fails when the placeholder is used (`apps/service/src/sending/render.test.ts:56-60`).

The deletion record should split its lineage: safe substitution has a stronger worker replacement; the direct null-field assertion is intentionally removed rather than replaced; empty headers and marketing/missing-URL cases are supporting behavioral evidence. If implementation review rejects that decision, use the refreeze branch rather than silently editing a test.

### Mechanically make every manifest field unique

Rejected. Shared mounted-Hono, Config, CLI, queue, or direct-function boundaries can be factually identical. Artificial uniqueness would add filler rather than review quality.

### Extend the validator with more phrase denylisting

Rejected for this scope. The confirmed defects can be fixed in canonical evidence without changing audit-tool tests and invalidating the final freeze. Item 2’s stronger artifact validation is explicitly out of scope.

## Phase 0 — Reopen status and freeze the correction inputs

### Files

- `.progress/fix-final-review-findings-and-rebuild-test-audit.md`
- `.progress/correct-test-audit-records-and-status.md` (new implementation tracker when execution begins)
- `.reviews/fix-final-review-findings-and-rebuild-test-audit-implementation-review.md` (read-only authority; do not rewrite)
- `.progress/fix-final-review-findings-and-rebuild-test-audit-implementation-review.md` (read-only review matrix; do not rewrite historical review results)

### Tasks

1. Create an implementation tracker with one row per phase and every mandatory record group below.
2. Record current SHA-256 values only for the canonical manifest/view and frozen report/inventory. Use the existing protected/freeze checks to prove no identity-bearing source changed; do not hash every consulted source file.
3. Before canonical edits, change the old implementation tracker:
   - overall status → `Partial after implementation review`;
   - T30, T31, T34, T39, and T41 → `Reopened` with a link to this plan and the review report;
   - keep T32 final reporter freeze verified because no identity-bearing source has changed;
   - preserve T33/T37/T40 historical `Verified` evidence, but add a current note that topology/full gates/protection must be rerun before scoped closure;
   - keep T35 CI, T36 focused production gates, and other unaffected historical rows intact.
4. Record the invariant: editing any `*.test.*` file or `scripts/test-quality-audit/core.test.mjs` invalidates T32 and switches execution to the full refreeze branch.
5. Do not use reset/restore/clean or broad formatting in the existing dirty worktree.

### Checkpoint

- Status is honestly partial before manifest correction.
- Frozen report/inventory hashes still match the recorded 615-test evidence.
- No test or audit-tool source changed.

## Phase 1 — Build and verify the finite correction queue

Create a machine-readable or Markdown queue in the new implementation tracker containing:

- record ID;
- operation and final target ID/name;
- current invariant/evidence;
- exact test declaration/assertion lines;
- production wiring symbol;
- correction reason;
- proposed invariant, boundary, limitation, evidence, and rationale changes;
- reviewer status.

### Group A — Replace generic “scenario block” evidence (12)

| Record | Final test identity | Required source-backed evidence |
|---|---|---|
| `retain-d292476107d3` | `requirePrincipal allows API keys with required permissions` | `mailings.write` key reaches mounted `/protected`, returns 200 and `{ ok: true }` |
| `retain-050525e3d278` | `requirePrincipal returns 403 for API keys missing permissions` | `mailings.read` key returns exact 403 `forbidden` envelope/message |
| `retain-85432a8dd5c8` | `runRoute … EmptyRecipientSetError` | reason `No recipients.` → 422 / `empty_recipient_set` / exact message |
| `retain-b21bb7c72b93` | `runRoute … ForbiddenError` | `Forbidden thing.` → 403 / `forbidden` / same message |
| `retain-e647956ed87d` | `runRoute … IdempotencyConflictError` | key `same-key` → 409 / `idempotency_conflict` / fixed conflict message |
| `retain-2896c88819fb` | `runRoute … ListNotFoundError` | list `missing` → 404 / `not_found` / `List not found.` |
| `retain-cd032d170219` | `runRoute … NotFoundError` | exact 404 / `not_found` / `Thing not found.` |
| `retain-469558cbc877` | `runRoute … RecipientLimitExceededError` | limit 5000 → 422 / `recipient_limit_exceeded` / exact maximum message |
| `retain-8873f8ca92ab` | `runRoute … RequestValidationError` | exact 400 / `invalid_request` / `Bad field.` |
| `retain-6108760266ec` | `decodeCreateMailingRequest rejects invalid request 5` | fixture `scheduledAt: "not a date"` produces `Result.isFailure === true` |
| `retain-85952a525cf2` | `decodeCreateMailingRequest rejects invalid request 8` | fixture email `two@@example.com` produces decoder failure |
| `retain-3cdf6a364ee4` | `suppressions routes deletes only manual suppressions` | seeded manual/complaint suppressions; manual DELETE 204, complaint 409 exact body, missing 404 |

Correct inaccurate source locations such as `test.ts:1`/`:18`; cite the actual declaration/assertion range or stable test path plus exact assertions.

### Group B — Replace bare/incomplete assertion evidence (8)

| Record | Required differentiated evidence |
|---|---|
| `retain-32040443e6d2` | list creation and marketing mailing creation statuses/bodies plus list linkage |
| `retain-43cfd498cfa6` | no-session 401, invalid-key 401, wrong permission 403, read-key GET success, write-key mutation access |
| `retain-73cf8b8d7782` | all four raw-presence distinctions: null+list, undefined, null recipients, null listId |
| `retain-dc2df0700ee0` | three exact presence-rule input/message pairs |
| `retain-12f1386300c3` | invalid-request fixture with empty recipients and decoder failure—not borrowed later assertions |
| `retain-a1083a0e4161` | three suppression 201 outcomes with normalized values; invalid all+listId 400; missing list 404 |
| `retain-e65048d1fdbe` | suppression auth matrix: 401/401/403/200 and read-only POST/DELETE `[403,403]` |
| `retain-4340bc06dbee` | all/marketing/list suppression effects: asserted 422/201/201/422/422 mailing outcomes |

### Group C — Differentiate SES endpoint authorization identities (5)

Records:

- `retain-5845a0106c93`
- `retain-2d7a3ca7b14e`
- `retain-e7e90b473f66`
- `retain-7399ab1cc5b0`
- `retain-0f780885fb48`

For each record:

- name the exact endpoint in the invariant and evidence;
- retain the legitimately shared mounted-app/auth boundary;
- state only what the test proves: unauthenticated 401, unrelated permission 403, owner session 200, `operations:read` API key 200;
- preserve `includeAws=false` in readiness/setup-guide records;
- do not invent response-body, AWS-call, or route-internal claims.

### Group D — Review and differentiate the additional duplicated invariants (10)

These records are mandatory risk review, not automatic prose churn:

- credential filesystem: `retain-3bf45f6fb978`, `retain-37eda4f5712e`;
- authenticated/login timeout composition: `retain-466a96c4fcbe`, `retain-f50e2ea2bbc7`;
- unrelated mutation lifecycles: `retain-3ffae70f5747`, `retain-327fd1bee431`, `retain-c9c54366a7b7` (`retain-3cdf6a364ee4` is already Group A);
- idempotency boundaries: `retain-22613579f906`, `retain-a076ea9e3fe9`, `retain-900271bc6cca`.

Rewrite any record whose shared invariant does not identify its own risk. Expected distinctions include:

- directory-permission refusal versus credential lifecycle/permission hardening;
- authenticated client timeout composition versus login client timeout composition;
- API-key rotation expiry, contact deletion snapshot/suppression preservation, and list CRUD/count behavior;
- service-level pre-check replay, wire-time normalization before hashing, and route-level same-key replay/no duplicate rows.

If a duplicated invariant is already fully accurate for both identities, retain it and record the source-backed reason in the tracker rather than forcing uniqueness.

### Queue acceptance

- Phase 1 contains exactly **35 retain records**: 25 confirmed weak retains plus 10 duplicate-risk retains.
- Phase 2 separately owns one delete disposition, for **36 total reconciled manifest records**.
- Every retain row resolves to exactly one frozen final identity. The delete row resolves to its baseline identity and retains `to: []`.
- No additional record enters scope without a concrete source-backed defect recorded in the tracker.
- Shared boundaries are not rewritten merely to create unique strings.

## Phase 2 — Correct the renderer delete disposition

### Canonical record

- `docs/test-audit/manifest.json` → `delete-f7ad7dc9d0f4`

### Source evidence

- Baseline deleted test: `apps/service/src/sending/render.test.ts:62-75` in the starting snapshot/HEAD version.
- Ordinary worker substitution: `apps/service/src/sending/process-delivery.test.ts:159-167`.
- Strongest transactional observable boundary: `apps/service/src/sending/fake-workflow.integration.test.ts:77-92`.
- Marketing renderer URL output: `apps/service/src/sending/render.test.ts:43-53`.
- Missing URL failure when referenced: `apps/service/src/sending/render.test.ts:56-60`.

### Decision

Use an evidence-only correction with explicit split lineage:

1. **Safe scalar substitution:** replaced by the named worker/fake-workflow identity that asserts ordinary `Max` substitution.
2. **Direct `RenderedEmail.unsubscribeUrl === null`:** not replaced; intentionally removed as a lower-level implementation-detail assertion.
3. **Supporting behavior only:** empty transactional transport headers, marketing URL presence, and missing-URL failure bound production behavior but are not replacements for the direct null field.

Also replace the false “existing escaped HTML” invariant, name exact final identities where the format permits, and do not claim the hostile-character escaping row is the same behavior.

### Decision checkpoint

If independent review concludes the null output is itself a public/stable invariant, stop and ask for approval to enter the full refreeze branch. Do not add an assertion opportunistically.

## Phase 3 — Apply manifest corrections and regenerate the view

### Files

- `docs/test-audit/manifest.json`
- `docs/test-audit/audit.md` (generated only)

### Rules

1. Keep all `from`, `to`, operation, IDs, report metadata, inventories, mutations, and topology unchanged.
2. Modify only quality fields required by this correction:
   - `invariant`;
   - `boundary` only when inaccurate;
   - `limitation` only when inaccurate;
   - `wiring` when the current symbol/path is wrong;
   - `evidence`;
   - `rationale` for `delete-f7ad7dc9d0f4`.
3. Do **not** edit `candidateReviewHistory` yet; closure evidence does not exist until Phase 4 finishes.
4. Do not manually edit inventory hashes or frozen report metadata.
4. Run non-strict then strict validation before rendering to catch malformed JSON/topology mistakes.
5. Generate `audit.md` only with `pnpm audit:render`, then verify byte freshness.

### Objective checks

Run a small read-only script that fails if:

- any of the 12 Group A records still contains `scenario block`;
- any Group B record contains bare evidence fragments such as `` `expect(` `` without a complete asserted expression/outcome;
- any Group C invariant/evidence omits its exact endpoint;
- the delete rationale still says hostile escaping is the same behavior;
- any of the 35 retain queue IDs is missing, duplicated, or does not resolve to its expected single final identity;
- the delete entry does not resolve to baseline `f7ad7dc9…` with `to: []`;
- a queue row lacks its source assertion reference, production symbol, and explicit result (`changed` or `retained-with-source-backed-reason`);
- the renderer row lacks the replaced/not-replaced/supporting-behavior split;
- topology/source/admission counts differ from 459 retain, 27 rewrite, one merge, two deletes, and 128 additions.

Semantic truth remains reviewer-owned; do not build a generalized prose validator. Do not turn this one-off reconciliation script into a committed audit-tool test, which would invalidate the final freeze.

### Green checkpoint

```sh
node scripts/test-quality-audit/cli.mjs validate --manifest docs/test-audit/manifest.json
pnpm audit:validate
pnpm audit:render
pnpm audit:render:check
pnpm audit:independent
node scripts/test-quality-audit/cli.mjs compare-report --snapshot final --report .progress/final-review-test-quality-final.json --inventory docs/test-audit/final-inventory.json
```

Expected: baseline 490, final 615, zero identity/multiplicity deltas, unchanged final inventory and raw-report hashes.

## Phase 4 — Independent semantic review of every changed record

Use fresh read-only reviewers; no parallel writers.

### Review lanes

1. **HTTP/auth/schema/suppressions/lists reviewer**
   - inspect every changed Group A/B/D resource record against actual tests and production callers;
   - verify exact fixture, status/body/state, boundary, limitation, and wiring.
2. **SES + renderer lineage reviewer**
   - inspect all five endpoint records and `delete-f7ad7dc9d0f4`;
   - verify no invented AWS/body claims and that safe substitution/null-output removal is accurately bounded.
3. **Audit/status reviewer**
   - verify queue cardinality, unchanged topology/inventory, generated view, manifest history, and reopened tracker rows.

### Required reviewer output

- every changed record ID reviewed;
- files fully/partially read and skipped;
- CONFIRMED findings with path/line evidence;
- explicit decision on renderer null-output removal;
- confirmation that legitimately shared boundaries were not mistaken for generic evidence;
- residual limits.

Resolve material feedback and return to the same reviewer sessions when possible. Any test/audit-tool edit triggered by review switches to the full refreeze branch.

## Phase 5 — Finalize closure evidence, validate, and restore honest scoped status

### Final manifest update and validation ordering

1. After Phase 4 review is clean, append exactly one `candidateReviewHistory` entry containing:
   - scope `items-3-5-only`;
   - the 36 reconciled record IDs;
   - review/follow-up run IDs;
   - accepted/rejected feedback;
   - renderer split-lineage decision;
   - explicit residual blocker: portable/hash-verified review artifacts remain unresolved under excluded items 1–2.
2. Make no further manifest edits after this closure entry.
3. Run validation in this order so the generated view contains the final history:

```sh
node scripts/test-quality-audit/cli.mjs validate --manifest docs/test-audit/manifest.json
pnpm audit:validate
pnpm audit:render
pnpm audit:render:check
pnpm audit:independent
node scripts/test-quality-audit/cli.mjs compare-report --snapshot final --report .progress/final-review-test-quality-final.json --inventory docs/test-audit/final-inventory.json
pnpm audit:test
pnpm check
python3 .progress/final-review-remediation-start/verify-protected.py
git diff --check
```

Also verify:

- no test or audit-tool source changed since the frozen report;
- final raw report/inventory hashes remain `483ef424…` / `5fa324c0…`;
- no temporary Vitest/report/review process remains;
- staged index remains untouched;
- hosted CI remains `External/unvalidated`.

### Status restoration

Only after validation and reviewer closure:

1. Mark every row in the **new scoped implementation tracker** verified; items 3–5 are complete.
2. Update `.progress/fix-final-review-findings-and-rebuild-test-audit.md`:
   - T30/T31/T34/T39/T41: `Partially remediated`, linked to corrected records/fresh review and the remaining portability blocker;
   - T33/T37/T40: retain historical `Verified` status and append current rerun results;
   - overall status remains `Partial after implementation review` because excluded items 1–2 still prevent the original portable suite-wide completion claim.
3. Preserve prior historical evidence and explain that T32 remained valid because no identity-bearing source changed.
4. Keep external hosted status unchanged.

Do not mark the original implementation `Complete` in this scoped plan. That requires a later plan for items 1–2.

## Full refreeze branch — only if a test or audit-tool test must change

This branch is not the default. Trigger it if implementation or independent review requires changing any collected test source or `scripts/test-quality-audit/core.test.mjs`.

1. Mark T32/T33 and all downstream evidence rows reopened.
2. Freeze all test/audit-tool source after the final edit.
3. Recollect:

```sh
pnpm exec vitest run --reporter=json --outputFile=.progress/final-review-test-quality-final.json
```

4. Import/rebuild `docs/test-audit/final-inventory.json`.
5. Reconcile every changed identity and addition; update direct baseline→final topology.
6. Recompute inventory/manifest/view/multiset hashes.
7. Rerun deterministic reviewer sampling using the new final-inventory hash.
8. Run strict/render/independent/current-report/full repository gates.
9. Repeat the freeze if any identity-bearing file changes afterward.

A body-only assertion change still triggers refreeze even if the reporter tuple remains unchanged.

## File-operation manifest

| Path | Operation | Purpose |
|---|---|---|
| `.plans/correct-test-audit-records-and-status.md` | Create | This implementation plan |
| `.progress/correct-test-audit-records-and-status-plan.md` | Retain/update | Planning research and review memory |
| `.progress/correct-test-audit-records-and-status.md` | Create during implementation | Execution tracker and 36-record queue |
| `.progress/fix-final-review-findings-and-rebuild-test-audit.md` | Rewrite status/evidence only | Reopen invalidated claims, append rerun evidence, retain overall partial status |
| `docs/test-audit/manifest.json` | Rewrite quality/history fields only | Correct weak records and renderer lineage |
| `docs/test-audit/audit.md` | Regenerate | Deterministic view of corrected manifest |
| `docs/test-audit/final-inventory.json` | Retain on default path | Frozen identities remain valid |
| `.progress/final-review-test-quality-final.json` | Retain on default path | Frozen raw report remains valid |
| `scripts/test-quality-audit/*` | No change | Tooling changes are outside scope and would trigger refreeze |
| Application production files | No change | Production behavior already validated |
| Application test files | No change by default | Existing stronger coverage supports evidence-only correction |

## Delegation and ownership

### Sequential / one writer

- status reopening;
- 36-record queue synthesis;
- canonical manifest edits;
- generated view;
- tracker/status restoration.

### Safe parallel read-only work

- source/evidence extraction for independent record groups;
- SES/renderer lineage review;
- post-edit semantic review;
- topology/hash/status verification.

No parallel agents may write `manifest.json`, `audit.md`, or the trackers.

## Traceability

| Requested item | Plan coverage |
|---|---|
| 3. Correct weak manifest records | Phases 1, 3, 4 |
| Differentiate five SES authorization records | Phase 1 Group C |
| Risk-sample repeated records without forcing uniqueness | Phase 1 Group D |
| 4. Fix renderer deletion record | Phase 2 |
| Decide null-output assertion honestly | Phase 2 decision checkpoint |
| 5. Restore honest status and revalidate | Phases 0, 4, 5 |
| Preserve frozen evidence when identities do not change | Phases 3, 5 |
| Full refreeze if any test/tool test changes | Explicit refreeze branch |

## Risks and mitigations

- **Accidental blanket rewrite:** scope is a 36-record queue; additions require a concrete defect and tracker entry.
- **Artificial prose uniqueness:** shared boundaries remain when accurate; identity-specific fixture/outcome belongs in invariant/evidence.
- **Incorrect parameter-row mapping:** resolve every target through `final-inventory.json`; do not infer table indices from titles alone.
- **Stale source line numbers:** prefer exact test names/assertions and stable symbols; line ranges are supporting evidence, not identity.
- **Hidden identity drift:** compare current frozen report to final inventory and verify no test/tool source diff; trigger refreeze on any such edit.
- **Generated-view drift:** only `pnpm audit:render` writes `audit.md`; `render:check` is mandatory afterward.
- **False renderer replacement claim:** cite ordinary substitution as replacement; classify transactional empty headers as supporting evidence and the direct null field as intentionally removed.
- **Premature completion:** reopen status first; complete only the scoped tracker after review/gates, while the original tracker remains partial.
- **External overclaim:** hosted CI and live SES/SNS remain external/unvalidated.

## Definition of Done

- The 35 retain records resolve to exactly one expected final target each; the separate delete record resolves to its baseline source with `to: []`.
- No Group A record contains generic “scenario block” evidence.
- No Group B record contains incomplete assertion fragments; evidence states exact input and outcome.
- Every Group C record names its exact endpoint and only claims the shared status/auth behavior actually asserted.
- Group D records either have identity-specific invariants/evidence or a source-backed reason why shared wording is accurate.
- `delete-f7ad7dc9d0f4` no longer claims hostile escaping is the same behavior; it names safe substitution as replaced, the null field as intentionally removed, and transactional headers/marketing URL behavior only as supporting evidence.
- Baseline/final topology remains 490→615 with 459 retain, 27 rewrite, one merge, two deletes, and 128 additions on the default path.
- Final report and inventory hashes remain unchanged on the default path.
- Generated Markdown is byte-current.
- All audit gates, `pnpm check`, protected-path verification, and `git diff --check` pass.
- Fresh reviewers inspect every changed record and report no unresolved material finding.
- A canonical closure-history entry records the remediation and review evidence.
- The new scoped tracker is complete; the original implementation tracker remains partial with the portability blocker explicitly recorded.
- Hosted CI and live providers remain explicitly external/unvalidated.
- No production or test source changes occur unless the explicit refreeze branch is activated.
