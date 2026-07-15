# Fix SES retry safety, SQLite durability, and squash migrations

## Summary

Implement only these repository changes:

1. Classify potentially post-acceptance SES internal/service-unavailable and generic HTTP 5xx failures as terminal `ambiguous`, not retryable.
2. Run every production Bun SQLite connection in WAL mode with `synchronous=FULL`, and verify that SQLite accepted the setting.
3. Intentionally reset migration history by replacing migrations `0001`–`0009` with one final-state `0001_initial_schema.sql` and deleting the repository-default local SQLite database artifacts.
4. Add or rewrite only the high-value tests and current documentation directly required by those changes.

This is a scoped remediation, not a production-readiness completion plan. Review issue 2 and every other production-readiness finding remain unresolved.

## Confirmed requirements and assumptions

### Required behavior

- A `SendEmail` failure that may have happened after SES accepted the message must not cause an automatic second send.
- These outcomes must be `ambiguous`:
  - named or coded `InternalFailure`;
  - named or coded `InternalServerError`;
  - named or coded `ServiceUnavailable`;
  - named or coded `ServiceUnavailableException`;
  - generic HTTP status `500`–`599` in AWS SDK metadata;
  - existing timeout/abort and unknown outcomes.
- Outcomes that prove or strongly establish pre-acceptance refusal remain retryable:
  - `ECONNREFUSED`, `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN`;
  - `ThrottlingException`, `TooManyRequestsException`, `LimitExceededException`.
- Provider semantic signals must not be overridden by generic network fields. Internal/service-unavailable name or code is ambiguous; a named permanent SES rejection remains permanent; explicit throttle/quota rejection remains retryable even with incidental 5xx metadata; a generic pre-connect network code is considered only after those provider signals and generic 5xx.
- Do not broaden unrelated code-based permanent classification in this task.
- Both the application and Better Auth Bun connections must use and report `PRAGMA synchronous = FULL` (`2`).
- Only one migration file remains: `apps/service/src/db/migrations/sql/0001_initial_schema.sql`.
- The sole migration creates the exact current final schema directly, with no legacy data-copy or state-conversion SQL.
- DOWN remains supported and destructive-gated; it drops every application table and leaves runner-owned `schema_migrations`.
- Only these default local artifacts may be removed:
  - `.data/nusend.sqlite`
  - `.data/nusend.sqlite-shm`
  - `.data/nusend.sqlite-wal`

### Vetoable interpretation of “local database”

“Local database” means the three repository-default `.data/nusend.sqlite*` artifacts listed above. The implementation must not inspect, glob, remove, truncate, or migrate any other SQLite file or a path supplied through `NUSEND_DB_PATH`. Stop local Nusend service/worker processes before deletion. Keep the default artifacts absent at completion and run migration smoke tests against temporary paths.

### Compatibility policy

The squash deliberately abandons compatibility with databases that recorded the old `0001`–`0009` history. Such databases will fail checksum/missing-migration validation, which is safer than silently accepting a different schema history. Preserve non-default databases; archive/recreate or export/import them manually. Designing an upgrade bridge is outside this plan.

No clarification is otherwise required.

## Evidence and current state

### External evidence

- AWS documents that an SES API timeout or server error can occur after the request was accepted, so retrying can send a duplicate: <https://docs.aws.amazon.com/ses/latest/dg/troubleshoot-error-messages.html>.
- SQLite documents that WAL with `synchronous=NORMAL` can lose recent committed transactions after power loss, whereas `FULL` synchronizes the WAL after each commit: <https://www.sqlite.org/pragma.html#pragma_synchronous>.

### Local findings

- `apps/service/src/services/email-transport-ses.ts` currently includes internal/service-unavailable names in `retryableErrors` and treats every HTTP `>=500` response as retryable.
- `apps/service/src/sending/process-delivery.ts` already makes an `ambiguous` transport outcome terminal and non-retryable. No delivery-state redesign is needed.
- `apps/service/src/services/database-bun.ts` applies one pragma function to both Bun handles, currently with `synchronous=NORMAL`.
- `apps/service/src/services/database.test.ts` exercises a real file-backed `DatabaseBunLive` and checks auth/app connection separation, WAL, foreign keys, and busy timeout, but not synchronous mode.
- The current migrations produce 19 application tables. `schema_migrations` is created and owned by the runner.
- `apps/service/src/db/migrate.integration.test.ts` mixes permanent runner invariants with obsolete tests for historical 0002–0009 transitions.
- Any test identity/content change invalidates the committed final test-audit evidence under `docs/test-audit/`.

## Chosen strategy

### SES classification

Separate potentially post-acceptance SES provider failures from retryable non-acceptance failures. Classification order must be explicit:

1. preserve an existing `EmailTransportError`;
2. timeout/abort shapes → `ambiguous`;
3. internal/service-unavailable provider name or code → `ambiguous`;
4. explicit named permanent SES rejection → `permanent`;
5. explicit throttle/quota provider name or code → `retryable`;
6. HTTP `500`–`599` → `ambiguous`;
7. generic pre-connect DNS/connect name or code → `retryable`;
8. unknown → `ambiguous`.

This conservative order prevents a generic network code from overriding a stronger internal or permanent SES signal, while preserving quota/throttle behavior when the same error carries incidental 5xx metadata. Use a precise `500 <= status <= 599` predicate rather than an unbounded `>=500` test.

### SQLite durability

Set `PRAGMA synchronous = FULL` in the shared Bun connection setup, then read back `PRAGMA synchronous` and fail setup unless SQLite reports `2`. The existing `DatabaseError` operations `pragmas` and `pragmas-auth` remain the error boundary for the app and auth handles.

A process `SIGKILL` test is not a substitute for a power-loss test and must not be added. The automated contract is that the real runtime configures and verifies FULL on both live handles; operational power-loss testing remains outside this scoped implementation.

### Migration squash

Before deleting historical SQL, create a temporary reference database from the current `0001`–`0009` chain and capture its final schema metadata. Build the sole migration from final `CREATE TABLE`/`CREATE INDEX` definitions, not by concatenating upgrade transformations. Compare the squashed result with that reference and then enforce the same invariants permanently through integration tests.

The initial migration retains all current schema behavior, including apparently redundant but currently relied-on objects such as both `jobs_delivery_id_idx` and `jobs_delivery_id_unique_idx`. Index cleanup is unrelated and excluded.

## Alternatives rejected

- **Keep generic 5xx retryable:** rejected because SES may already have accepted the email.
- **Make every provider/network error ambiguous:** rejected because explicit pre-connect failures and throttle/quota refusals establish non-acceptance and should continue through queue backoff.
- **Change queue/attempt states or add a dispatched phase:** rejected as review issue 2, explicitly outside scope.
- **Use `synchronous=EXTRA` or rollback-journal mode:** unnecessary; `FULL` directly addresses the reviewed WAL durability gap without changing the storage architecture.
- **Set FULL without reading it back:** weaker than the requested “use and verify” durability contract.
- **Concatenate all nine migrations:** rejected because it retains obsolete rebuild/data-conversion logic and is not a clean initial schema.
- **Add a compatibility migration after 0009:** contrary to the requested squash and local reset.
- **Delete all `.sqlite` files or the entire `.data` directory:** unsafe and broader than the request.

## Traceability to the request

| Requested item | Plan coverage |
|---|---|
| Review issue 1: unsafe SES 5xx/internal/service-unavailable retry | Phases 1–2; SES classifier and two-cycle pipeline regression |
| Review issue 3: WAL `synchronous=NORMAL` | Phases 1–2; shared FULL pragma, startup read-back, dual-handle test |
| Delete repository-default local database | Phase 4; exact three-path deletion only |
| Squash migrations 0001–0009 | Phase 3; final-state 0001, delete 0002–0009, rewritten migration tests |
| Add directly related high-value tests | Phases 1–3 and 6 |
| Do nothing about other findings | Explicit non-goals and scope guard below |

## Canonical file-operation manifest

### Rewrite or modify

- `apps/service/src/services/email-transport-ses.ts` — conservative SES classifier.
- `apps/service/src/services/email-transport-ses.test.ts` — classifier/transport regression matrix.
- `apps/service/src/sending/process-delivery.test.ts` — classifier-to-queue two-cycle no-resend regression.
- `apps/service/src/services/database-bun.ts` — FULL pragma and read-back verification.
- `apps/service/src/testing/bun-fixtures.ts` — expose app/auth synchronous values from real handles.
- `apps/service/src/services/database.test.ts` — assert FULL on both file-backed handles.
- `apps/service/src/db/migrations/sql/0001_initial_schema.sql` — sole final-state initial migration.
- `apps/service/src/db/migrate.integration.test.ts` — one-migration runner/schema/DML/DOWN/re-UP coverage.
- `README.md` — fresh-baseline, error classification, and durability wording only.
- `PROJECT.md` — remove obsolete migration-history notes and document current scoped semantics.
- `docs/deployment.md` — replace 0005/0009 upgrade instructions with fresh-baseline incompatibility and FULL tradeoff.
- `docs/auth-and-api-keys.md` — remove obsolete migration-0005 upgrade wording only.
- `docs/troubleshooting.md` — identify generic SES server outcomes as terminal ambiguous.
- `docs/test-audit/final-inventory.json` — recollect/import after tests freeze.
- `docs/test-audit/manifest.json` — reconcile affected identities, evidence, wiring, metadata, and review batches.
- `docs/test-audit/README.md` — refresh final report path/hash/counts only if its frozen-summary paragraph is now stale.
- `docs/test-audit/audit.md` — regenerate through the audit renderer; never hand-edit.

### Delete tracked files after their final schema has been captured

- `apps/service/src/db/migrations/sql/0002_simplify_send_queue_and_states.sql`
- `apps/service/src/db/migrations/sql/0003_ses_feedback_ingestion.sql`
- `apps/service/src/db/migrations/sql/0004_ses_operations_and_tracking.sql`
- `apps/service/src/db/migrations/sql/0005_first_party_api_keys_and_device_auth.sql`
- `apps/service/src/db/migrations/sql/0006_device_auth_throttle_cleanup.sql`
- `apps/service/src/db/migrations/sql/0007_mailings_created_id_index.sql`
- `apps/service/src/db/migrations/sql/0008_operations_pagination_and_job_uniqueness.sql`
- `apps/service/src/db/migrations/sql/0009_delivery_ambiguity_and_suppression_safety.sql`

### Delete ignored local artifacts exactly, after stopping local processes

- `.data/nusend.sqlite`
- `.data/nusend.sqlite-shm`
- `.data/nusend.sqlite-wal`

### Retain unchanged

- `apps/service/src/sending/process-delivery.ts`
- `apps/service/src/sending/attempts.ts`
- `apps/service/src/sending/worker-crash.integration.test.ts`
- `apps/service/src/db/migration-files.ts`
- `apps/service/src/db/migrate.ts`
- `apps/service/src/db/migration-check.ts`
- `apps/service/src/db/migration-files.test.ts`
- `apps/service/src/db/startup-migration-check.test.ts`
- `apps/service/src/db/destructive-migration.ts`
- `apps/service/src/db/destructive-migration.test.ts`
- `apps/service/src/testing/layers.ts`
- `docs/test-audit/baseline-inventory.json`
- all historical `.plans/`, `.reviews/`, and completed progress records; they remain historical evidence and must not be rewritten to pretend the old migrations never existed.

## Final initial-schema contract

### Tables

The migration UP creates these 19 application tables, in dependency-safe order:

1. `users`
2. `sessions`
3. `accounts`
4. `verifications`
5. `api_keys`
6. `device_authorizations`
7. `lists`
8. `contacts`
9. `list_memberships`
10. `mailings`
11. `deliveries`
12. `suppressions`
13. `jobs`
14. `send_attempts`
15. `mailing_idempotency_keys`
16. `ses_notifications`
17. `ses_events`
18. `ses_simulator_runs`
19. `worker_runs`

Do not create obsolete `ses_feedback_notifications` or `ses_feedback_recipients`.

### Final-state details that must not regress

- `api_keys` is the first-party user-owned form with `key_hash`, `key_preview`, `permissions_json`, revocation/rotation fields, and no legacy Better Auth key columns.
- `device_authorizations` excludes the columns removed by old migration 0006: `user_code_attempts` and `last_user_code_attempt_at`.
- `mailings.state` permits only `scheduled`, `sending`, and `completed`.
- `deliveries.status` permits `queued`, `sending`, `sent`, `failed`, `suppressed`, and `ambiguous`.
- `jobs` uses `delivery_id`, has no old `kind`/`ref_id`, and enforces one job per delivery through the unique index.
- `send_attempts.status` remains `started`, `succeeded`, `failed`, or `ambiguous`.
- `ses_events` and `ses_simulator_runs` use their current post-0009 forms, including simulator `ambiguous`.
- Current defaults, `COLLATE NOCASE`, CHECK constraints, partial unique indexes, descending pagination indexes, and timestamp fields remain byte-semantically equivalent.

### Foreign keys and ON DELETE behavior

Preserve and test:

- `sessions.user_id`, `accounts.user_id`, `api_keys.user_id`, and `device_authorizations.approved_by_user_id` → `users(id)` with `CASCADE`.
- `api_keys.rotated_from_id` → `api_keys(id)` with `SET NULL`.
- membership list/contact references with `CASCADE`.
- `mailings.list_id` and `deliveries.contact_id` with `SET NULL`.
- `deliveries.mailing_id`, `jobs.delivery_id`, attempt delivery/job references, and idempotency mailing reference with `CASCADE`.
- `suppressions.list_id` with `CASCADE`.
- `ses_events.notification_id` with `CASCADE`.
- SES event/simulator mailing and delivery references with `SET NULL`.

All referenced parents use scalar primary keys; no composite parent-key prerequisite is needed.

### Indexes

Preserve the complete final index set:

- auth/session/account/verification indexes;
- API-key user/revoked/last-used indexes;
- device expiry/approved-user indexes;
- list name, unique contact email, membership contact/subscription indexes;
- mailing purpose-state, scheduled, list, and `(created_at DESC, id DESC)` indexes;
- delivery mailing, mailing-status, email, contact, partial unique SES message ID, and `(created_at DESC, id DESC)` indexes;
- suppression email and both partial uniqueness indexes;
- job state/run-at, locked-until, nonunique delivery-ID, and unique delivery-ID indexes;
- attempt delivery, job, status, and partial SES-message-ID indexes;
- `mailing_idempotency_keys_mailing_id_idx`;
- SES notification received-at; every current event lookup/pagination index; simulator started/status; worker finished-at.

### DOWN

Drop children before parents and leave `schema_migrations` to the runner. A valid order is:

1. `ses_events`
2. `ses_simulator_runs`
3. `send_attempts`
4. `jobs`
5. `mailing_idempotency_keys`
6. `deliveries`
7. `device_authorizations`
8. `api_keys`
9. `sessions`
10. `accounts`
11. `list_memberships`
12. `suppressions`
13. `mailings`
14. `ses_notifications`
15. `worker_runs`
16. `contacts`
17. `lists`
18. `verifications`
19. `users`

Indexes may disappear with owning tables. The destructive rollback detector must inventory all 19 dropped tables; do not bypass or weaken it.

## Implementation phases

## Phase 0 — Baseline and schema reference

1. Create an implementation tracker under `.progress/` with this plan loaded as the checklist.
2. Verify the worktree and record pre-existing changes; do not overwrite unrelated work.
3. Run the existing focused and repository gates before edits:
   - SES transport and send-processing tests;
   - database and migration tests;
   - `pnpm check`;
   - `pnpm build`;
   - all test-audit commands.
4. Collect a pre-change Vitest JSON report and compare it to `docs/test-audit/final-inventory.json`.
5. While all nine migration files still exist, apply them to a temporary file-backed database and capture, under `.progress/`:
   - ordered `sqlite_schema` table/index SQL excluding `schema_migrations`;
   - `PRAGMA table_info` for every table;
   - `PRAGMA foreign_key_list` for every table;
   - `PRAGMA index_list` and `PRAGMA index_xinfo` for every index;
   - `PRAGMA foreign_key_check` output.
6. Confirm no local Nusend service or worker process is using `.data/nusend.sqlite*`. Do not delete it yet.

### Phase 0 checkpoint

Baseline tests/audits pass, current final schema metadata is captured from a temporary database, and no source or database artifact has been changed.

## Phase 1 — Add final-form fail-before regressions

### 1.1 SES classifier tests

In `apps/service/src/services/email-transport-ses.test.ts`, make permanent final assertions before changing production code:

- parameterize named and coded internal/service-unavailable errors and expect `ambiguous`;
- parameterize metadata statuses `500`, `503`, and `599` and expect `ambiguous`;
- exercise a rejected sender through `makeSesEmailTransport` and assert the surfaced `EmailTransportError` is `ambiguous`, not only the pure classifier result;
- preserve assertions that timeout/abort are ambiguous;
- preserve retryable assertions for DNS/connect, throttle, too-many-requests, and quota errors;
- add an explicit throttle/quota error carrying 503 metadata and expect `retryable` to pin precedence;
- add conflicting-signal cases: internal/service-unavailable name plus generic network code remains `ambiguous`; named permanent rejection plus network code and/or 5xx metadata remains `permanent`;
- preserve plain named bad-request/message-rejected permanent assertions.

The existing 503 expectation fails against the old implementation, providing direct red evidence. Do not temporarily invert expectations.

### 1.2 Classifier-to-queue regression

In `apps/service/src/sending/process-delivery.test.ts`, adapt the existing terminal-ambiguity scenario or add one focused case that uses `makeSesEmailTransport` with an injected sender rejecting a 503/service-unavailable-shaped error. Run two worker cycles and assert:

- sender invocation count is exactly one;
- one send attempt becomes `ambiguous`;
- delivery becomes `ambiguous`;
- job becomes `succeeded` under the existing terminal-ambiguity handling;
- mailing becomes `completed`;
- the second cycle claims zero work and does not dispatch again.

This must fail before the classifier change because the first cycle records a retryable failure and the later due cycle dispatches again. Use the Effect test clock to advance through backoff where required. Keep generic retryable queue tests unchanged.

### 1.3 FULL pragma regression

Extend `readAuthConnectionPragmas` in `apps/service/src/testing/bun-fixtures.ts` to return separately named app/auth synchronous values. Query the actual app service and raw auth handle. Extend the existing file-backed test in `apps/service/src/services/database.test.ts` to assert:

- app synchronous mode is `2`;
- auth synchronous mode is `2`;
- existing WAL/FK/busy-timeout and connection-separation assertions still pass.

The assertions fail against current `NORMAL` (`1`). Do not add a simulated crash test or claim this test proves physical power-loss behavior.

### Phase 1 checkpoint

Run only the changed focused tests and record the expected failures with the current implementation. Revert no final-form assertions.

## Phase 2 — Implement scoped SES and SQLite fixes

### 2.1 SES classifier

1. Split the current retryable set into explicit throttle/quota provider refusals and generic pre-connect DNS/connect failures.
2. Add a clearly named post-acceptance-ambiguous set used for both `name` and `code`.
3. Replace the retryable 5xx helper with an ambiguous HTTP `500`–`599` predicate.
4. Apply the exact documented precedence: internal/service signals first, then named permanent rejection, explicit throttle/quota refusal, generic 5xx, and finally generic pre-connect failure. This prevents contradictory low-level fields from weakening a stronger provider signal.
5. Keep `makeSesClient({ maxAttempts: 1 })`, timeout handling, command creation, and queue code unchanged.
6. Update comments so none claim the queue owns retries for server outcomes now considered unsafe to repeat.

### 2.2 SQLite FULL and verification

1. Replace `PRAGMA synchronous = NORMAL` with `PRAGMA synchronous = FULL` in the shared setup.
2. Immediately read `PRAGMA synchronous` from the same handle and throw if the result is not numeric mode `2`.
3. Let existing setup wrappers map failures to `DatabaseError` operation `pragmas` for the app handle or `pragmas-auth` for the auth handle.
4. Keep WAL, foreign keys, busy timeout, trusted schema, connection topology, and database service serialization unchanged.

### Phase 2 checkpoint

Run the SES transport, process-delivery, and database tests. All Phase 1 tests must now pass. Run typecheck/format/lint for touched TypeScript. Do not start migration edits until this checkpoint is green.

## Phase 3 — Replace migration history with one clean initial schema

### 3.1 Build the sole migration

1. Rewrite `apps/service/src/db/migrations/sql/0001_initial_schema.sql` with one `-- migrate:up` and one `-- migrate:down` section.
2. Define the 19 final tables, FKs, CHECKs, defaults, collations, and indexes described above directly.
3. Omit every rename, copy, repair, conversion, and legacy feedback table from old 0002–0009.
4. Delete tracked migration files 0002–0009 only after the temporary reference schema has been captured.
5. Apply the new 0001 to a fresh temporary database.
6. Compare its schema metadata against the pre-squash reference. Investigate every difference; accept only expected migration-history/checksum differences, not application schema drift.
7. Run `PRAGMA foreign_key_check`; require no rows.

### 3.2 Rewrite migration integration tests

Refactor `apps/service/src/db/migrate.integration.test.ts` around permanent one-baseline invariants.

#### Keep and rewrite: runner lifecycle/checksum test

Keep the existing reporter title where practical to avoid gratuitous identity churn. Assert:

- status lists exactly one pending `0001_initial_schema`;
- UP applies exactly that migration;
- status lists exactly one applied migration;
- exact expected table names are present;
- an exhaustive canonical map of every expected application index matches by name, owner, uniqueness, ordered key columns/expressions, collation, sort direction, and partial predicate SQL, including `mailing_idempotency_keys_mailing_id_idx` and both job delivery-ID indexes; derive this from `sqlite_schema` plus `PRAGMA index_list`/`index_xinfo` rather than name-only checks;
- an exhaustive canonical map of every foreign-key edge and ON DELETE action matches;
- high-risk table SQL additionally preserves the expected CHECK literals, defaults, and column collations;
- no obsolete table, index, FK, or old column exists;
- checksum drift is refused;
- a synthetic applied version with no file is reported/refused by status/UP/DOWN;
- confirmed DOWN rolls back 0001 and leaves only `schema_migrations`;
- a second DOWN reports no applied migrations;
- re-UP restores the same schema and passes `foreign_key_check`.

#### Keep and rewrite: destructive rollback gate test

- Apply the sole migration.
- Run DOWN without `NUSEND_CONFIRM_DESTRUCTIVE_ROLLBACK=1`.
- Assert the exact sorted inventory of all 19 data-bearing tables is printed and rollback is refused without changing schema/data.
- Run confirmed DOWN.
- Assert the inventory appears before the rollback success message and every application table is removed.

#### Delete obsolete historical transition test

Remove `converts only proven historical ambiguity, repairs exact suppressions, and preserves the graph through UP/DOWN/re-UP`. It tests 0009 data conversion, which intentionally no longer exists.

#### Replace obsolete 0002 failure test with fresh-schema DML/FK coverage

Remove `fails loudly when 0002 sees future-only mailing states`. Add a focused fresh-schema test that:

- inserts representative rows spanning user/auth, list/contact/membership, mailing/delivery/job/attempt/idempotency, SES notification/event/simulator, suppression, device authorization, and worker-run tables;
- verifies representative CHECK violations are rejected, including invalid delivery/simulator states;
- verifies duplicate `jobs.delivery_id` is rejected;
- verifies notification deletion cascades to events;
- verifies contact deletion sets `deliveries.contact_id` to null;
- verifies SES event/simulator delivery and mailing references use SET NULL;
- verifies delivery deletion cascades to its job and attempts;
- verifies user deletion cascades auth-owned rows and self-referencing API-key rotation behaves correctly;
- runs `PRAGMA foreign_key_check` after UP and after re-UP and requires no violations.

Avoid reintroducing historical pre-0009 rows or transformation assertions.

### 3.3 Verify generic migration consumers

Run unchanged parser, startup-check, database-contract, driver-parity, and representative domain/sending tests to ensure dynamic migration discovery works with one file. Do not special-case the runner for a single migration.

### Phase 3 checkpoint

The migration directory contains only `0001_initial_schema.sql`; a fresh temporary DB exactly matches the captured final application schema; migration UP/status/checksum/missing-file/destructive DOWN/re-UP and representative DML/FK checks pass.

## Phase 4 — Remove the repository-default local database safely

1. Reconfirm no local API/worker process is using the default database.
2. Remove the three exact paths individually:
   - `.data/nusend.sqlite`
   - `.data/nusend.sqlite-shm`
   - `.data/nusend.sqlite-wal`
3. Do not use a wildcard, recursive deletion, environment-derived path, or directory-wide cleanup.
4. Verify all three paths are absent.
5. Run migration/startup/manual DB smoke tests only with a temporary explicit `NUSEND_DB_PATH`; clean up that temporary database and sidecars afterward.
6. Re-verify the three default artifacts remain absent at completion.

### Phase 4 checkpoint

The old default local database and sidecars are absent, no other local database was touched, and the fresh squashed migration has passed against temporary file-backed databases.

## Phase 5 — Update only affected current documentation

### README and project contract

- Replace README’s “apply migrations to existing databases” and 0009 rollout text with the intentional fresh-baseline policy and warning not to delete non-default/production data automatically.
- Document that internal/service-unavailable and generic SES 5xx outcomes are terminal ambiguous, while explicit pre-connect/throttle/quota refusals remain retryable.
- Document WAL+FULL as the dispatch-ledger durability setting without claiming it solves backup, DR, or every production-readiness gap.
- In `PROJECT.md`, remove obsolete current upgrade notes for migrations 0004, 0008, and 0009; retain unrelated compatibility notes.
- Add the one-file baseline incompatibility and current classifier/FULL behavior to the relevant sending/database sections.

### Deployment, auth, and troubleshooting

- In `docs/deployment.md`, replace migration-0005/0009 procedures with the fresh-baseline incompatibility policy and note FULL’s durability/commit-latency tradeoff.
- In `docs/auth-and-api-keys.md`, remove only the obsolete migration-0005 upgrade statement; preserve API-key behavior documentation.
- In `docs/troubleshooting.md`, explain that generic SES internal/server/service-unavailable outcomes are ambiguous and must not be automatically retried.

Do not update historical plans/reviews, claim overall production readiness, or add remediation guidance for excluded findings.

### Phase 5 checkpoint

Repository searches find no current operational guidance instructing users to apply old 0002–0009 migrations. Current docs consistently describe the squash, conservative SES classification, and FULL setting, while historical records remain untouched.

## Phase 6 — Refreeze test-audit evidence and complete verification

### 6.1 Freeze test sources

After tests and reporter titles are final:

1. Collect a successful current Vitest JSON report under `.progress/`.
2. Import it as `docs/test-audit/final-inventory.json` with the existing audit CLI.
3. Keep `docs/test-audit/baseline-inventory.json` byte-unchanged.

### 6.2 Reconcile manifest evidence

Update `docs/test-audit/manifest.json` rather than mechanically changing counts:

- update final report/inventory hashes, runtime metadata, status, file count, and test count;
- add substantive records for new SES/pragma/fresh-schema identities;
- update retained records whose implementation boundary or invariant materially changed;
- remove or correctly reconcile obsolete 0002/0009-only final identities;
- update production wiring from deleted migration files to the sole 0001 where appropriate;
- preserve exact identity/multiplicity rules;
- add independent review-batch evidence covering every changed test file;
- record the limitation that pragma tests verify configuration, not a physical power-loss experiment.

Refresh the summary paragraph in `docs/test-audit/README.md` if its final report path/hash/counts changed. Regenerate `docs/test-audit/audit.md` only through `pnpm audit:render`.

Do not modify the audit tool or use this work to address its reviewed weaknesses.

### 6.3 Focused verification

Run at least:

- SES transport tests;
- process-delivery tests;
- database service tests under the real Bun scenario;
- migration runner integration tests;
- migration parser/startup-check tests;
- driver/database contract tests;
- representative auth, sending, SES, and domain tests that depend on the fresh schema.

### 6.4 Full verification

Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit:test
pnpm audit:validate
pnpm audit:render:check
pnpm audit:independent
node scripts/test-quality-audit/cli.mjs compare-report \
  --snapshot final \
  --report .progress/<final-report>.json \
  --inventory docs/test-audit/final-inventory.json
```

### 6.5 Manual validation

- Query both live Bun handles through the test fixture and confirm `journal_mode=wal` and `synchronous=2`.
- Apply/status/confirmed-down/re-UP the sole migration against a temporary file-backed database.
- Inspect exact table/index names and run `PRAGMA foreign_key_check`.
- Confirm `.data/nusend.sqlite`, `-wal`, and `-shm` are still absent.
- Confirm `git status` contains only intended plan implementation, documentation, and audit-evidence changes.

No live SES call is required to validate the classifier. Record that provider acceptance timing and physical power-loss durability remain bounded by official documentation and configured behavior, not reproduced external infrastructure tests.

## Delegation and ordering

Implementation is safest as sequential single-writer work because SES tests/code, migration files/tests, docs, and audit identities share one worktree and later phases depend on earlier identities.

Useful read-only delegation:

- a schema reviewer comparing pre-squash and squashed SQLite metadata;
- a sending reviewer checking classification precedence and two-cycle no-resend evidence;
- a final test-audit reviewer checking identity dispositions and substantive records.

If writers are delegated, isolate worktrees and give non-overlapping ownership. Integrate SES/SQLite code before the migration rewrite, integrate the migration rewrite before docs, and freeze all tests before any audit-evidence update.

## Risks and mitigations

- **Accidental duplicate send remains through classifier precedence:** pin name, code, metadata, and mixed throttle+503 cases; prove behavior through two worker cycles.
- **Safe refusal becomes ambiguous and silently drops mail:** retain only documented non-acceptance errors in the retryable sets, pin mixed-signal precedence, and keep existing retry integration tests.
- **SQLite setting is silently not applied:** read back mode `2` on each handle during setup and in the real file-backed test.
- **Squashed schema omits an index/FK/CHECK/default:** capture the old-chain schema before deletion, compare complete metadata, run representative DML and `foreign_key_check`.
- **DOWN drops a parent before a child:** use explicit dependency-safe order and exercise confirmed DOWN on populated data.
- **Destructive gate is weakened by the squash:** assert exact 19-table refusal inventory and unchanged data before confirmation.
- **An existing database is mistaken for a fresh baseline:** preserve startup checksum/missing-file failure and document intentional incompatibility.
- **Local data outside the request is deleted:** use three literal paths only; no globbing, recursive deletion, or environment path resolution.
- **Audit evidence becomes stale:** recollect after all test changes, reconcile identities substantively, regenerate, and run all audit gates.
- **Scope expands into other review findings:** enforce the non-goals below and treat scoped completion separately from production readiness.

## Explicit non-goals / scope guard

Do not implement or plan follow-on work for:

- review issue 2’s pre-dispatch/dispatched phase or crash-before-transport recovery;
- deployment supervisor/proxy/TLS/HTTPS defaults or database file permissions;
- backup, restore, disaster recovery, retention, capacity, monitoring, or alerts;
- SNS certificate-fetch controls;
- SES simulator validation changes;
- URL validation;
- missing migration-asset startup behavior beyond existing generic checks;
- CLI device-login `Retry-After` handling;
- test-audit tool hardening;
- unrelated schema/index cleanup, API changes, refactors, or dependency upgrades.

Do not modify delivery/attempt status literals, `startSendAttempt`, queue recovery, worker-crash tests, or transport `maxAttempts: 1`.

## Definition of scoped done

- Generic SES internal/service-unavailable and HTTP 500–599 failures classify as `ambiguous`.
- Explicit pre-connect/throttle/quota non-acceptance failures remain retryable; permanent rejection behavior is preserved.
- A two-cycle worker test proves a 503/service-unavailable sender rejection causes exactly one dispatch and terminal ambiguity.
- Every production Bun database handle sets and verifies WAL `synchronous=FULL` (`2`).
- The migration directory contains one clean `0001_initial_schema.sql` matching the old chain’s final application schema.
- Fresh UP, exhaustive canonical table/index/FK state, representative DML, CHECK/unique/cascade/SET NULL behavior, checksum/missing-file handling, destructive DOWN refusal/confirmation, and re-UP are tested.
- Migrations 0002–0009 and exactly the three default `.data/nusend.sqlite*` artifacts are absent.
- Non-default existing databases are preserved and incompatibility is documented.
- Current docs and committed test-audit evidence are consistent and all focused/full/audit gates pass.
- Excluded production-readiness findings remain explicitly unresolved; this plan must not be used to change the overall no-go verdict by itself.
