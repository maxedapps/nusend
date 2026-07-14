# Portable test-audit evidence

This directory is the committed, reviewable evidence layer for the suite-wide test audit. JSON—not Markdown—is canonical.

## Identity and provenance

Each test identity is `["vitest-json-v1", repoRelativePosixFile, exactReporterFullName, occurrence]`; its ID is the SHA-256 of `JSON.stringify(tuple)`. Reporter strings are copied byte-for-byte. Occurrence is assigned in reporter order before deterministic sorting. Paths are runtime-realpathed, repository-contained, POSIX-relative, byte/case-sensitive, and rejected for traversal, symlink escape, case-only collision, or ambiguous Unicode normalization. Absolute repository roots are never committed.

`baseline-inventory.json` was imported only from `.progress/final-review-test-quality-baseline.json` with SHA-256 `e0b05020ace9a64fbd75024d3d1b966ef09e9e52ea0cebb721c59137400ba63d`. The `*-contaminated.json` report is rejected provenance and must never be imported. Raw reports remain local under `.progress/`; committed inventories retain their hashes, commands, runtime versions, date, result, and local/archive path.

The manifest records the frozen direct baseline-to-final graph. The current final inventory was imported from `.progress/selected-production-fixes-final.json` after the selected production-fix tests and audit-tool tests were frozen: 79 files / 692 tests, report SHA-256 `487b30245fdf2c06664c475743bc493f66be6b77680e12daf2cd0601a250a1cd`, and inventory SHA-256 `5a7788b952f5c6e9ee02f38f2ed042ae43e5d7e4b9701e0da6d15736bf5d473e`; counts and provenance are recorded in both the inventory and manifest. Any later test or audit-tool test change invalidates this evidence and requires a new final collection and reconciliation. Non-strict validation checks portable identity and ledger shape; strict validation additionally requires complete substantive records and review-batch metadata. Historical mutation prose is marked `historical` / `imported-not-replayed`, never independently reproduced.

## Commands

- `pnpm audit:test` — adversarial audit-tool tests.
- `node scripts/test-quality-audit/cli.mjs validate --manifest docs/test-audit/manifest.json` — bootstrap/non-strict validation.
- `pnpm audit:validate` — strict validation (intentionally red during bootstrap).
- `pnpm audit:render` / `pnpm audit:render:check` — the only writer and byte-current check for `audit.md`.
- `node scripts/test-quality-audit/independent-check.mjs --mode baseline --manifest docs/test-audit/manifest.json` — built-ins-only baseline reconciliation.
- `pnpm audit:independent` — final-mode reconciliation after the final inventory exists.
- `node scripts/test-quality-audit/cli.mjs compare-report --snapshot final --report <current.json> --inventory docs/test-audit/final-inventory.json` — compare normalized identity multiplicity, success, and file/test totals. Raw report bytes and timings may differ.

The generated Markdown visibly escapes controls and is never parsed back into identities. Its deterministic noncanonical view includes every disposition/addition invariant, actual boundary and limitation, production wiring, evidence, changed-test rationale, review-batch files-read metadata, and mutation provenance. Structural validators prevent common mechanical/blanket approval, but do not prove semantic test quality, live SES/SNS behavior, or hosted CI status.
