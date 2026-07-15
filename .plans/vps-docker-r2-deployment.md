# VPS Docker Compose, Caddy, Logging, and R2 Backup Plan

Create one small production bundle for a single Linux VPS: one Bun image shared by the API and send worker, stock Caddy behind Cloudflare, daily verified SQLite backups to an encrypted restic repository in R2, and journald for all server logs. Keep exactly one API and one worker while SQLite is in use.

Defaults: dedicated Cloudflare-proxied hostname, Cloudflare Origin CA with **Full (strict)**, daily backups retaining all snapshots for 30 days plus 12 monthly snapshots, and a server-wide journal capped at 1 GiB or 30 days. Research and source details are in [`.progress/vps-docker-r2-deployment-plan.md`](../.progress/vps-docker-r2-deployment-plan.md).

## Phase 1 — Build one reproducible image and Compose stack

- Add root `Dockerfile` and `.dockerignore`:
  - use exact, reviewed manifest digests; start with project-matched `oven/bun:1.3.14-debian` and pnpm `11.9.0`, never floating production tags;
  - install with `--frozen-lockfile`, build `@nusend/api-contract`, and copy only production dependencies, its `dist`, service source, and filesystem SQL migrations into the final image;
  - run as fixed UID/GID `10001`, set `NODE_ENV=production`, invoke Bun directly so signals reach PID 1, and label the source revision;
  - do not change pnpm workspace-linking semantics merely to use `pnpm deploy`; prove the final package layout by importing `@nusend/api-contract` and running migration status from the image.
- Add root `compose.yaml`:
  - `api`: `bun apps/service/src/main.ts`, internal port 3000 only, `/health/db` health check, `restart: unless-stopped`;
  - `worker`: `bun apps/service/src/sending/worker-main.ts loop`, same image/env/database, `restart: unless-stopped`;
  - one-shot `migrate` and `backup` services under an `ops` profile; migrations remain deliberate operator actions, never automatic startup work;
  - bind `/var/lib/nusend` at the same container path and force `NUSEND_DB_PATH=/var/lib/nusend/nusend.sqlite`; publish no API/worker host ports and configure no replicas;
  - use `init: true`, read-only root filesystems, writable `/tmp` tmpfs, dropped capabilities, `no-new-privileges`, and graceful stops. API needs at least 15 seconds. The app already rejects a worker processing budget that reaches its lease; set Compose worker grace to `lease + 60s` so valid in-flight work can finish before Docker kills it. With the documented 300-second lease, use 6 minutes and test shutdown during a send.
- Keep root `.env.example` as the single canonical runtime-variable inventory; update it with production-safe placeholders/comments rather than creating a second copy. Add only `deploy/compose.env.example` for non-secret interpolation such as domain, immutable image tag, config path, and host paths.
- Store actual runtime config at `/etc/nusend/nusend.env` and Compose interpolation at `/etc/nusend/compose.env`, both root-owned `0600`. This is the simplest compatible contract for the current env-only app; warn that Docker administrators can inspect process environment. R2 credentials belong only to `backup`.
- Checkpoint:
  - build with `--pull`, exact source revision, and a test tag; run the import/migration probes above;
  - `docker compose --env-file deploy/compose.env.example config --quiet`;
  - against a temporary host DB directory, migrate, start API/worker, require healthy API, send SIGTERM (including during a fake active send), and verify clean bounded exits;
  - confirm API port 3000 is not published and API/worker use the same image ID and DB mount.

## Phase 2 — Add Caddy and one age-or-size log policy

- Add `deploy/caddy/Caddyfile`, mounted as the whole `/etc/caddy` directory. In Compose, Caddy is the only service publishing TCP 80/443 and uses `restart: unless-stopped`; persist official image `/data` and `/config` volumes. Pin the current stock `caddy:2.11.4-alpine` manifest digest; do not add the Cloudflare DNS plugin, UDP 443, or `NET_ADMIN` because Cloudflare owns edge HTTP/3.
- Configure Caddy to:
  - terminate origin TLS with Compose secrets for a Cloudflare Origin CA certificate/key and proxy only to `api:3000`;
  - version the current [Cloudflare IP ranges](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/) as `trusted_proxies static`, enable `trusted_proxies_strict`, and read `CF-Connecting-IP` before `X-Forwarded-For`;
  - overwrite upstream `X-Forwarded-For` with `{client_ip}` so Nusend’s final-hop parser receives one canonical address; preserve host and HTTPS semantics;
  - cap requests at the app’s 2 MiB boundary, apply modest header/body read timeouts, emit `Cache-Control: no-store`, expose `/health`, and return 404 for external `/health/db` while Compose continues checking it internally;
  - emit JSON logs to stderr. Skip access logs for `/unsubscribe/*` and `/api/auth/*`, and apply URI redaction plus Referer removal to both access and default/runtime log encoders so signed tokens/OAuth callback data cannot leak on error paths such as 502.
- Add `deploy/systemd/10-nusend-journal.conf`:

  ```ini
  [Journal]
  Storage=persistent
  Compress=yes
  SystemMaxUse=1G
  SystemKeepFree=1G
  SystemMaxFileSize=64M
  MaxFileSec=1day
  MaxRetentionSec=30day
  ```

  Set every Compose service to Docker’s `journald` logging driver with a stable tag. The journal then removes oldest archived logs when entries exceed 30 days **or** the host journal reaches its size/free-space bound. Document that the limit is intentionally server-wide and active files can temporarily exceed it until rotation, per [`journald.conf`](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html).
- Checkpoint:
  - run `caddy fmt --diff`, `caddy adapt --validate`, and Compose config validation using throwaway certs;
  - test HTTPS proxying, 413 above 2 MiB, public `/health`, blocked `/health/db`, and no listener on 3000;
  - send forged forwarding headers from a non-trusted source and prove they are replaced;
  - hit sensitive routes with API healthy and unavailable; raw token/auth URIs and Referer values must be absent from every Caddy log while ordinary routes remain visible;
  - on staging, apply/restart journald and verify `journalctl --disk-usage`, container tags, `docker compose logs`, one-day file rotation, and both limits.

## Phase 3 — Create and verify encrypted SQLite backups in R2

- Add `deploy/backup/Dockerfile` and `deploy/backup/backup.sh`:
  - build a minimal image with current SQLite CLI, CA certificates, `jq`, a process lock utility, and digest-pinned restic `0.19.0`; run as UID/GID `10001`;
  - mount `/var/lib/nusend` read-only at `/source`; mount `/var/lib/nusend-backup` read/write at `/work`. Both host directories are owned by `10001`, mode `0700`, so the backup user can traverse/read source and write work without root;
  - acquire an exclusive `/work` lock, set a bounded SQLite busy timeout (for example 30 seconds), and use SQLite CLI `.backup` (the [Online Backup API](https://sqlite.org/backup.html)) into a unique private local path; never copy/checkpoint/delete live DB/WAL/SHM files;
  - require `PRAGMA quick_check` to return only `ok` and `PRAGMA foreign_key_check` to return no rows before upload;
  - read R2 key ID/secret and the restic password from backup-only Compose secret files. Use a private, pre-created bucket and a wrapper that applies the S3 option to **every** R2 restic command:

    ```sh
    export RESTIC_REPOSITORY="s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/nusend"
    export AWS_DEFAULT_REGION=auto
    restic_r2() { restic -o s3.bucket-lookup=path "$@"; }
    ```

  - stream the validated local snapshot into a canonical restic filename (`backup --stdin --stdin-filename nusend.sqlite`) with fixed host and `nusend-db` tag. Parse `--json` output with `jq`, require the exact `snapshot_id`, and treat every non-zero/incomplete status as failure;
  - delete local staging, fetch that exact snapshot ID back from R2 into a clean verification path, and repeat both SQLite checks. Never substitute “latest” for the captured ID;
  - only after successful remote verification run retention with explicit `--group-by host,paths,tags`, keeping `--keep-within 30d --keep-monthly 12`, then prune and run `restic check`; trap cleanup without touching production files.
- Add `deploy/systemd/nusend-backup.service` and `.timer`. The oneshot command must use the same explicit contract as the runbook:

  ```text
  docker compose --env-file /etc/nusend/compose.env \
    -f /opt/nusend/compose.yaml --profile ops run --rm --no-deps backup
  ```

  Schedule daily in a low-traffic window with `Persistent=true` and a small randomized delay. Do not silently initialize a missing repository or automatically remove stale restic locks; failure remains non-zero in journald.
- Add `deploy/tests/backup-smoke.sh` using a temporary **local** restic repository, no cloud credentials. It must prove:
  - a committed row present only in a live WAL survives `.backup`, restic upload, local deletion, exact-ID retrieval, and restore, including while another connection performs ordinary concurrent writes;
  - missing source/repository/password, corrupt snapshots, and overlapping execution fail closed;
  - multiple backups remain one retention group and the newest verified snapshot is never removed.
- R2 operator gate:
  - create one private bucket and a token scoped to **Object Read & Write** for that bucket only;
  - initialize restic once and escrow its independent high-entropy password off-server; losing it makes R2 data unrecoverable;
  - do not apply an R2 object lifecycle rule or bucket lock to the restic prefix—restic owns mutable interdependent objects and retention;
  - before enabling the timer, run a live R2 init/snapshot/exact restore because credentials are unavailable to automated repository tests.
- Checkpoint: syntax-check scripts, build the backup image, run the local smoke test twice from clean state, then run the staging systemd unit; require a successful journal entry, visible R2 snapshot ID, and independently queried restored data.

## Phase 4 — Document deployment, update, and disaster recovery

- Expand `docs/deployment.md` as the canonical ordered runbook while preserving its fresh-database-only warning:
  1. install supported Docker Engine/Compose from Docker’s official repository; create `/opt/nusend`, `/etc/nusend`, `/var/lib/nusend`, and `/var/lib/nusend-backup` with exact owners/modes;
  2. checkout an exact Git tag/commit, pin tested image digests, populate the two protected config files from their canonical examples, and provision backup secrets;
  3. configure a proxied DNS record, Cloudflare Origin CA, **Full (strict)**, and “Always Use HTTPS”. Use Docker-aware `DOCKER-USER`/nftables IPv4+IPv6 rules—not UFW assumptions—to allow current Cloudflare ranges on 80/443 and reject direct-origin traffic;
  4. bypass cache for the dedicated hostname. Skip only challenge-producing Cloudflare features for exact machine callbacks: SNS `POST /api/webhooks/aws/sns/ses`, unsubscribe `GET|POST /unsubscribe/*`, and OAuth callback `GET /api/auth/callback/*`; retain other WAF/block/rate-limit protections;
  5. for a fresh DB: build once, run explicit migration, require `applied` status, start API/Caddy, pass internal `/health/db` and public `/health`, bootstrap the owner, verify SES/SNS readiness, then start worker;
  6. enable backups only after the full off-site restore check. Include exact status/log commands for every component.
- Document configuration ownership and recovery:
  - classify every root `.env.example` variable as required/optional and API/worker/both; include least-privilege AWS SES/SNS credential delivery;
  - escrow app secrets, config, Origin CA material, and restic password in a secure off-server password manager/export. The DB backup alone is not sufficient to rebuild the server;
  - include image/Caddy/restic/Cloudflare-IP update procedure and digest validation.
- Document update/rollback ordering: verified on-demand backup; retain previous image digest; stop worker then API; migrate deliberately; start API/Caddy and pass health; start worker and verify a cycle. Application rollback selects the prior image only when schema-compatible—never assume destructive `db:rollback` is safe.
- Document exact DB restore:
  - stop **every** API/worker/migration/backup DB user; preserve the current DB/WAL/SHM set;
  - retrieve a selected restic snapshot to a unique staging file **inside `/var/lib/nusend`** so final rename is same-filesystem; run SQLite and migration-status validation;
  - set UID/GID/mode, remove stale sidecars only while all handles remain stopped, atomically rename the validated DB into place, start API only, pass health, then start worker;
  - require an initial restore drill and a recurring quarterly drill to a separate path/server.
- Update `docs/operations.md` with Compose/journal filters, backup timer age/status, restic snapshot/check commands, and disk/DB/WAL size checks. Update `docs/troubleshooting.md` for Caddy TLS/502, client-IP trust, migration refusal, backup lock/failure, R2 403/region/endpoint, failed integrity, and journal pressure. Keep `README.md` as links only.
- Final acceptance on a clean staging VPS: deploy using only the runbook; reboot and prove service/timer recovery; verify Full (strict), direct-origin rejection, canonical client IP, callback cache/challenge rules, body/health behavior, sanitized bounded logs, a real R2 backup and destructive restore drill. Run project gates (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`) and all Docker/Caddy/backup checks, recording tested image digests and restore timestamp.

# Implementation Progress

- **Template loaded from:** `implement-plan/assets/progress-tracker-template.md`
- **Plan:** `.plans/vps-docker-r2-deployment.md`
- **Overall status:** `Blocked`
- **Last updated:** `2026-07-14`
- **Completion rule:** `Complete` is allowed only when every actionable plan requirement is traceably covered by a `Verified` row or explicitly `Descoped` with user approval.

## Plan coverage inventory

| ID | Original plan reference / requirement | Dependencies | Status | Owner | Verification | Evidence / notes |
|---|---|---|---|---|---|---|
| T01 | Phase 1: reproducible root `Dockerfile` and `.dockerignore`, exact images/tools, non-root runtime, minimal production layout, revision label | — | Verified | Worker W1 | Build with pull/revision; contract import and migration-status probes | Parent arm64 and cold amd64 digest-pinned builds passed; import/migration/UID/revision/layout probes passed |
| T02 | Phase 1: `compose.yaml` API/worker/migrate/backup topology, shared DB/image, health, security hardening, ports, shutdown budgets | T01 | Verified | Worker W1 | Compose config; temporary-DB migrate/start/health/image/mount/port/TERM checks | Parent stack reached healthy DB, no ports, same image/mount, idle SIGTERM exits 0; static contracts inspected |
| T03 | Phase 1: canonical root `.env.example` plus interpolation-only `deploy/compose.env.example`, ownership/secrets contract | T02 | Verified | Worker W1 | Inventory reconciliation and Compose interpolation validation | Compose default/ops render passed; runtime file uses raw format; backup secrets isolated; reviewer cleared |
| T04 | Phase 1 checkpoint: image/layout, Compose topology, migration, health, and bounded graceful-shutdown acceptance | T01-T03 | Blocked | Worker W1 + parent | Execute checkpoint scripts/commands and record results | All checks except controlled fake-active-send SIGTERM passed; no safe fake SES fixture exists yet; revisit before final acceptance |
| T05 | Phase 2: digest-pinned stock Caddy service, only 80/443 published, secrets/config/data mounts and journald logging | T02 | Verified | Worker W2 | Compose config with throwaway certs; inspect ports/capabilities/image | Parent format/adapt/Compose assertions passed; only Caddy TCP 80/443; exact image/secrets/mounts/caps |
| T06 | Phase 2: Caddy TLS/proxy/trusted Cloudflare IPs/client-IP canonicalization/request limits/health routing/log sanitization | T05 | Verified | Worker W2 | `caddy fmt --diff`, `caddy adapt --validate`, HTTPS behavioral/log tests | Strengthened local smoke and adapted JSON passed; independent reviewer cleared implementation |
| T07 | Phase 2: server-wide journald policy and stable Compose tags with documented age-or-size semantics | T05 | Verified | Worker W2 + W4 | Config inspection plus documented staging apply/status procedure | Exact drop-in/tags and server-wide OR/overshoot/apply/status docs verified; live behavior remains T09 |
| T08 | Phase 2 local checkpoint: proxy, 413, health exposure, no port 3000, forged headers, sensitive-log redaction | T05-T07 | Verified | Worker W2 + parent | Automated/manual local integration checks | Local direct-image smoke passed exact boundary, health, trust, logger-specific healthy/502 redaction and cleanup; staging separated as T09 |
| T09 | Phase 2 staging checkpoint: apply/restart journald and verify usage, tags, Compose logs, rotation and limits | T07 | Blocked | Operator/staging | Run staging commands and capture evidence | Requires Linux staging VPS/root access; unavailable in this local session |
| T10 | Phase 3: minimal digest-pinned restic/SQLite backup image running as UID/GID 10001 | — | Verified | Worker W3 | Build image; inspect versions/user/packages | Parent pulled build and UID/restic/SQLite/jq/flock/pinned-package probes passed |
| T11 | Phase 3: locked SQLite online backup, local and exact-ID remote verification, backup-only secrets, retention/prune/check, safe cleanup | T10 | Verified | Worker W3 + fix worker | Shell checks plus local-repository smoke/failure-path tests | FD9 lock, strict ID/exact restore/checks/order/failure paths verified; review cleared |
| T12 | Phase 3: explicit systemd backup oneshot/timer contract, persistent daily schedule, no implicit init/unlock | T11 | Verified | Worker W3 | `systemd-analyze verify` or structural fallback; command parity | Exact ExecStart/timer/no-init/unlock deterministic assertions passed; native systemd deferred to T15 |
| T13 | Phase 3: local smoke suite covering WAL/concurrency, exact restore, fail-closed cases, overlap and retention grouping/safety | T11 | Verified | Worker W3 + fix worker | Run twice from clean state | Worker twice + parent once passed 544 MiB synchronized `.backup`, WAL, non-latest ID, FK/pack corruption, lock, grouping |
| T14 | Phase 3 local checkpoint: syntax, image build, two clean smoke runs, systemd validation | T10-T13 | Verified | Worker W3 + parent | Execute and record all local checks | Shell/build/Compose/systemd structural/smoke/cleanup/diff passed; reviewer no remaining local findings |
| T15 | Phase 3 R2 operator gate and staging unit: least-privilege bucket/token, one-time init, live exact-ID restore and queried data | T14 | Blocked | Operator/staging | Live R2/staging execution evidence | Requires private credentials and Linux staging access; intentionally not available locally |
| T16 | Phase 4: canonical ordered deployment/configuration/update/rollback/restore runbook preserving fresh-DB warning | T01-T03,T05-T06,T10-T14 | Verified | Worker W4 + remediation workers | Documentation review against every ordered runbook requirement and command contract | Full runbook/fail-closed transactions/env matrix reviewed; final reviewer cleared |
| T17 | Phase 4: operations/troubleshooting docs and link-only README updates | T16 | Verified | Worker W4 + parent | Documentation link/command/topic coverage check | Operations/troubleshooting/link consistency checks passed; README remained links-only |
| T18 | Final repository and deployment-bundle gates: format, lint, typecheck, tests, build, Docker/Caddy/backup checks and cleanup | T08,T14,T17 | Verified | Parent | Run full declared gate matrix serially; inspect diff/index | All project gates passed (79 files/735 tests); final Compose/Caddy/backup/docs/systemd/diff/cleanup checks passed |
| T19 | Final clean-staging acceptance: runbook-only deploy, reboot recovery, Cloudflare/direct-origin/client-IP/callback/body/health/log/R2/restore checks | T09,T15,T18 | Blocked | Operator/staging + final reviewer | Capture tested digests and restore timestamp | Requires clean staging VPS, DNS/Cloudflare/AWS/R2 credentials; unavailable locally |
| T20 | Milestone and final independent review passes; resolve material findings and reconcile plan line by line | T04,T08,T14,T17,T18,T19 | Blocked | Independent reviewers + parent | Reviewer reports, fixes, rerun gates, final reconciliation | All local milestone/material findings resolved; holistic local review passed; final completion review waits T04/T09/T15/T19 |

Allowed statuses: `Pending`, `In progress`, `Blocked`, `Verified`, or user-approved `Descoped`.

## Subagent and execution strategy

| Task IDs | Owner | Mode | Context | Dependencies / write isolation | Handoff or parent-execution exception |
|---|---|---|---|---|---|
| T01-T04 | Worker W1 | Sequential milestone | Fresh session with plan/tracker; root image/Compose/env lane | Owns root deployment files and Phase 1 tests; completes before overlapping Compose work | `.subagents/vps-phase1.handoff.md` |
| T05-T08 | Worker W2 | Sequential after W1 | Fresh session with plan/tracker; Caddy/journald lane | Owns Caddy/journal files and Phase 2 integration tests; may update Compose after W1 completes | `.subagents/vps-phase2.handoff.md` |
| T10-T14 | Worker W3 | Sequential after Compose/Caddy milestone | Fresh session with plan/tracker; backup/systemd/test lane | Owns `deploy/backup`, backup systemd units/tests; may update only backup-specific Compose wiring after prior worker stops | `.subagents/vps-phase3.handoff.md` |
| T16-T17 | Worker W4 | Sequential after implementation milestones | Fresh session with plan/tracker; docs-only lane | Owns deployment/operations/troubleshooting/README docs | `.subagents/vps-phase4.handoff.md` |
| T18 | Parent | Sequential final gate | Tracker and all handoffs | Parent owns authoritative repo-wide gates after all workers stop | Required orchestration/authoritative-validation exception |
| T09,T15,T19 | Operator/staging | Sequential external acceptance | Protected infrastructure | No credentials or production-impacting action delegated without access/approval | Tracker evidence or blocker record |
| T20 | Independent reviewers + parent | At milestones/final | Plan, tracker, diff, validation evidence | Read-only review; parent resolves findings | `.subagents/vps-*-review.handoff.md` |

## Loop journal

### T01-T04 — Reproducible image and Compose runtime

- **Analyze:** Existing service runs Bun source directly, depends on built `packages/api-contract/dist`, discovers filesystem SQL migrations, exposes `/health/db`, and uses one shared WAL database. The worktree contains unrelated user changes that must remain untouched. Registry inspection verified the Bun OCI index digest recorded in `.progress/vps-docker-r2-deployment-plan.md`.
- **Plan:** Worker W1 owns only root Docker/Compose/env and optional Phase 1 test files. Build a non-root minimal image, encode exact one-API/one-worker topology and security/shutdown contracts, retain root `.env.example` as canonical inventory, then synchronously build/probe/validate. Parent will inspect the diff and rerun authoritative checks. No human checkpoint is needed; no credentials or production action occurs.
- **Implement:** Active in Herdr pane `w7:p1W`, fresh Pi session `vpsphase1-20260714-a91c`; expected handoff `.subagents/vpsphase1-20260714-a91c.handoff.md`. Rollback is deletion/reversion of only newly owned deployment files; unrelated changes are excluded.
- **Verify:** Worker and parent default/ops Compose renders passed. Parent `--pull` arm64 build and cold `linux/amd64` build passed with service-context contract imports, migration probe, UID/revision/layout checks. Temporary migrated stack reached healthy `/health/db`, published no app ports, shared one image and bind mount, and idle API/worker SIGTERM exits were 0 in four seconds. Cleanup and `git diff --check` passed. Active-send SIGTERM remains unexecuted.
- **Review:** Fresh read-only reviewer `vpsphase1-review-20260714-b62f` found floating Dockerfile frontend and non-raw env parsing. Parent pinned the frontend digest and added `format: raw`; Compose and amd64 checks reran. Same reviewer follow-up reported no remaining material implementation findings and isolated active-send evidence to T04. Handoff: `.subagents/vpsphase1-review-20260714-b62f.handoff.md`.
- **Decision:** T01-T03 Verified. T04 Blocked only on a controlled fake-active-send shutdown exercise; structural six-minute grace/current-cycle behavior is present. T05-T08 are dependency-ready.

### T05-T08 — Caddy, client trust, and bounded journald logs

- **Analyze:** Phase 1 Compose is verified for topology/env/image. Official Caddy 2.11 docs and current Cloudflare range endpoints were refreshed in `.progress/vps-docker-r2-deployment-plan.md`; Caddy access and default/runtime encoders are separate security surfaces. Host journald application needs root/staging and remains T09.
- **Plan:** Worker W2 exclusively owns Caddy/journal files, Caddy-specific Compose wiring, and a bounded local proxy/log smoke test. It will pin the stock Caddy index, add the only 80/443 publishers and secrets, version Cloudflare CIDRs, canonicalize forwarding, enforce request/health policies, apply identical URI/Referer sanitization to access and runtime encoders, set stable journald tags for every service, then validate with throwaway certificates. Parent will inspect and rerun. No human checkpoint or real certificate is used.
- **Implement:** Assigned to fresh Herdr session `vpsphase2-20260714-c73a`; expected handoff `.subagents/vpsphase2-20260714-c73a.handoff.md`. No concurrent writer is active.
- **Verify:** Parent Caddy format diff (no +/-), adapt/validate with throwaway cert, adapted JSON and default/ops Compose assertions passed. Strengthened `deploy/tests/caddy-smoke.sh` passed exact 2 MiB boundary/+1 rejection, no-store across 200/404/413/502, public/private health, untrusted forgery replacement, trusted Cloudflare-source header precedence with one canonical XFF, logger-specific access/runtime sanitization on healthy/502 paths, ordinary visibility, and cleanup. Journald file/tag structure and diff checks passed; host journald was not changed.
- **Review:** Fresh reviewer `vpsphase2-review-20260714-d84b` found no static config defect but found aggregate log assertions could false-pass runtime redaction. Parent added logger-specific and other boundary/trust checks; follow-up cleared material local findings. Parent also resolved the reviewer’s low interruption-cleanup issue by naming/removing the trusted client, bounding wget, and narrowing its test network. Handoff: `.subagents/vpsphase2-review-20260714-d84b.handoff.md`.
- **Decision:** T05, T06, and local T08 Verified. T07 remains Blocked only on documentation assigned to T16-T17 and live host behavior separated as T09. Direct-origin firewall/Full-strict remain explicit staging requirements.

### T10-T14 — Encrypted exact-ID SQLite backups

- **Analyze:** Production SQLite uses WAL, so live file copy is invalid. Official SQLite/restic/R2 behavior and exact image/package versions are recorded in `.progress/vps-docker-r2-deployment-plan.md`. Production must fail on missing repository/locks/credentials and cannot be cloud-tested without private access; local smoke needs an explicit non-R2 repository override while preserving the production wrapper.
- **Plan:** Worker W3 exclusively owns backup image/script/systemd/timer/smoke and backup-specific Compose wiring. It will build a pinned UID 10001 image, snapshot via SQLite `.backup` under process lock/busy timeout, validate locally, upload from stdin, parse one exact JSON snapshot ID, delete staging, restore exactly that ID and revalidate, then retain/prune/check. It will implement daily persistent systemd invocation and an isolated local smoke covering WAL/concurrency/failure/lock/retention, running twice. Parent will inspect and rerun. No cloud credentials or live init are used.
- **Implement:** Assigned to fresh Herdr session `vpsphase3-20260714-e95c`; expected handoff `.subagents/vpsphase3-20260714-e95c.handoff.md`. No concurrent writer is active.
- **Verify:** Worker and parent pulled builds passed exact image user/tool/package probes, shell syntax, default/ops Compose and systemd structural contracts. Worker ran smoke twice; parent independently ran it again. The final smoke uses a 544 MiB database and synchronizes a committed concurrent write to actual `.backup` staging writes; proves WAL-only data, non-latest exact-ID restore, staged FK rejection, initialized pack corruption, missing inputs, non-bypassable lock exit 75, one retention group/newest survival, and cleanup.
- **Review:** Fresh reviewer `vpsphase3-review-20260714-f06d` found three medium test/lock defects and one low exact-ID evidence gap. Fresh remediation worker `vpsphase3-fix-20260714-g17e` fixed them; parent rebuilt/reran; same reviewer follow-up reported no remaining material local findings. Handoffs: `.subagents/vpsphase3-fix-20260714-g17e.handoff.md`, `.subagents/vpsphase3-review-20260714-f06d.handoff.md`.
- **Decision:** T10-T14 Verified. Linux bind-mount flock, native systemd/journald, and live R2 remain isolated in T15 rather than weakening local claims.

### T16-T17 — Deployment, operations, and disaster-recovery runbooks

- **Analyze:** Existing deployment docs preserve the fresh-baseline warning but explicitly lack supervisor/proxy/backup/retention guidance. Implemented Compose/Caddy/backup contracts are stable enough to document; T07 needs server-wide journald semantics. Existing docs/README contain unrelated user edits and must be preserved.
- **Plan:** Worker W4 owns only canonical deployment/operations/troubleshooting and link-only README. It will trace every Phase 4 bullet into ordered commands, variable ownership, Cloudflare/firewall/WAF/cache, fresh deploy, status, backup gate, updates/rollback, exact same-filesystem restore, drills, and diagnostics without claiming staging execution. Parent will inspect links/commands and review independently. No production action occurs.
- **Implement:** Assigned to fresh Herdr session `vpsphase4-20260714-h28f`; expected handoff `.subagents/vpsphase4-20260714-h28f.handoff.md`. No concurrent writer is active.
- **Verify:** Env matrix, shell-fence syntax, links/anchors, Compose/systemd command parity, image/migration probes, and diff checks passed. Remediation made backup secret mounts readable only to root:GID10001, backup image immutable/multiarch, destructive transactions fail-closed, timer quiescent during migration, full bundle rollback explicit, Caddy force-recreated, firewall rollback pre-captured, lsof errors rejected, and dual-stack packet-path counters mandatory.
- **Review:** Fresh reviewer `vpsphase4-review-20260714-i39g` ran multiple rounds. Two remediation workers and final tightly coupled parent consistency edits resolved every material finding. Final verdict cleared T16-T17 with only live staging gates. Handoffs: `.subagents/vpsphase4-review-20260714-i39g.handoff.md`, `.subagents/vpsphase4-fix-20260714-j40h.handoff.md`, `.subagents/vpsphase4-fix2-20260714-k51i.handoff.md`.
- **Decision:** T16-T17 Verified. T07 documentation is now Verified; T09/T15/T19 remain explicitly Blocked on protected staging infrastructure.

### T18 — Authoritative final local gates

- **Analyze:** All local implementation/docs rows except T04 are verified; protected staging rows are blocked. Final validation must include unrelated pre-existing worktree edits because repository gates see the whole tree. Docker/Caddy/backup targeted checks already passed after final script changes, but Compose/docs changed afterward and need fresh render/static checks.
- **Plan:** Parent owns the authoritative serial gate exception: run format check, lint, typecheck, full tests, build, Compose/Caddy/static backup/systemd/docs checks, inspect cleanup/diff/status, and classify any failures as scope-related or pre-existing. No writer/reviewer is active.
- **Implement:** Validation only; no source edits unless a gate exposes a material defect.
- **Verify:** `pnpm format:check`, lint (warnings only), typecheck, 79 test files/735 tests, and build passed serially. Fresh default/ops Compose renders, required immutable backup-image negative case, only-Caddy ports/all journald tags, Caddy behavioral smoke, pulled backup build/user/tool probes, shell syntax, 30-variable docs matrix, 45 shell fences, systemd ExecStart parity, `git diff --check`, and Docker resource cleanup passed. The full synchronized 544 MiB backup smoke had already passed after the final backup-script change (worker twice, parent once).
- **Review:** Fresh holistic reviewer `vps-local-final-review-20260714-l62j` reported no remaining material local implementation, security/data-safety, configuration, command, documentation, or mapping defect. Handoff: `.subagents/vps-local-final-review-20260714-l62j.handoff.md`. It explicitly did not claim staging acceptance.
- **Decision:** T18 Verified; local-alignment milestone passed. T20 is Blocked because final completion review truthfully waits T04/T09/T15/T19.

## Deviations and decisions

| Plan reference | Deviation or decision | Reason | User approval needed/received | Impact |
|---|---|---|---|---|
| Phase 2/3/final staging gates | Keep staging- and credential-dependent rows distinct from locally executable implementation | Prevent false local claims and secret exposure | Access is required to continue | Local implementation is verified; overall completion remains blocked |
| Phase 1 active-send checkpoint | Do not fabricate a fake active SES send from existing crash fixtures | Existing fixtures do not execute `worker-main.ts` current-cycle SIGTERM through the final image/Compose stack | A controlled fixture or staging send is required | T04 remains Blocked; idle shutdown/current-cycle structure are verified |

## Final reconciliation

- [x] Re-read the full original plan, not only this tracker.
- [x] Every actionable plan item maps to one or more inventory rows.
- [x] Worker ownership, execution/context mode, dependencies/isolation, and handoffs are recorded; every parent-executed task has an allowed concrete exception reason.
- [ ] No row remains `Pending`, `In progress`, or `Blocked`. Blocked: T04, T09, T15, T19, T20.
- [x] Every `Verified` row includes concrete validation evidence.
- [x] Every `Descoped` row includes rationale and explicit user approval (none are descoped).
- [ ] Required automated, integration, browser/manual, cleanup, docs, migration, and acceptance checks are complete. Local checks are complete; staging/live acceptance is blocked.
- [x] Step-review material findings are resolved; unresolved acceptance dependencies are represented by `Blocked` inventory rows. Final completion review waits those rows.
- [x] Scope-relevant local validation passes; unavailable staging/cloud validation is recorded as blocked rather than claimed.
- [x] `Overall status` remains `Blocked`; it must change to `Complete` only after every blocked row is verified and final completion review passes.
