# Nusend architecture

## Product boundary

Nusend is a single-user, self-hosted email orchestration product for AWS SES. Its two interfaces are:

1. the authoritative HTTP service in `apps/service`;
2. the first-party HTTP client in `apps/cli`.

The product owns recipient data, mailing creation, durable delivery work, SES dispatch evidence, unsubscribe/suppression policy, SES feedback ingestion, and operator inspection. It is not a hosted multi-tenant SaaS, visual editor, journey builder, analytics suite, or generic email SDK.

Current gaps are templates as a managed domain, public asset storage, CLI coverage for every administrative API, and the live checks in [`docs/production-readiness.md`](./docs/production-readiness.md).

## Repository map

```txt
apps/service          Bun + Hono API, worker, migrations, SES tooling
apps/cli              Nusend command-line client
packages/api-contract Shared CLI/API codecs, permissions, and route constants
docs                   Current development, deployment, and SES guidance
deploy                 Production Caddy configs, backup image, and Docker smokes
e2e                    Cross-package product tests
```

`README.md` is the first-run entrypoint. Deployment and recovery procedures live only in `docs/deployment.md`; CLI behavior lives in `docs/cli.md`. HTTP schemas are authoritative in `packages/api-contract` where shared and in service route/schema modules otherwise.

## Runtime and configuration

The service uses TypeScript, Bun, Hono, Effect v4, SQLite, Better Auth, and AWS SDK v3. Production and test database drivers share a contract; schema-parity tests protect their observable behavior.

Each API, worker, or simulator entrypoint parses environment configuration once through `deploymentConfig`. The result contains normalized values and flat issues. The API can start without optional SES operations configuration so readiness can report setup gaps. The send worker loads strict sending configuration before constructing the database or SES client and requires:

- `AWS_REGION`;
- `NUSEND_SES_FROM_EMAIL`;
- `NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET`;
- a valid request-timeout/lease/batch budget.

Secrets remain redacted until client boundaries. `NUSEND_PORT` is the only service-port environment key; the default is `3000`. The production environment contract is in `.env.example` and `docs/deployment.md`.

## Authentication and permissions

Nusend is one owner per instance. Better Auth provides Google-only browser login; public signup is disabled and the owner is created with `auth:bootstrap`.

Programmatic clients use first-party keys in `x-api-key`. Keys:

- are stored as HMAC hashes under `NUSEND_API_KEY_HASH_SECRET`;
- have scoped resource permissions;
- may expire, rotate, and revoke;
- expose raw material only at creation/rotation;
- cannot revoke or rotate a key with permissions outside the actor's authority;
- record last use with debounced writes.

Device authorization lets the CLI obtain a scoped key after browser approval. Start/token routes have process-local rate limits and durable outstanding-grant limits. Polling is paced, expires locally and server-side, and does not consume unknown grants.

Route middleware accepts an owner session or API key, applies permission checks, and returns sanitized error envelopes. Unexpected errors log diagnostics without leaking secrets or request payloads.

## CLI contract

The CLI parses each invocation once into a discriminated `CliCommand` and dispatches typed payloads. Unknown commands/options, duplicates, arity errors, and conflicting expiry flags fail before config or network work. Static help is the command catalog.

One config directory represents one service. Its state is:

```ts
type LocalState = {
  baseUrl?: string;
  credential?: StoredCredential;
};
```

Login authorizes first, then atomically replaces `state.json` using an exclusive same-directory temporary file, file sync, rename, and directory sync where supported. Unix directory/file modes are `0700`/`0600`. Login alone may replace readable malformed JSON/schema; filesystem or permission failures fail closed. Other stored-state commands require a valid snapshot.

`--base-url` overrides `NUSEND_BASE_URL`, which overrides stored URL. `NUSEND_API_KEY` overrides stored credentials. When both environment authentication and an explicit/environment URL exist, commands bypass disk; logout preserves stored state. Concurrent mutation is unsupported and the last completed atomic writer wins.

The HTTP client rejects redirects so credentials are never forwarded to another target.

## Data and migration lifecycle

SQLite is the source of truth. The main domains are:

- Better Auth users/sessions/accounts;
- API keys and device grants;
- contacts, lists, memberships, and suppressions;
- mailings and idempotency keys;
- recipient delivery snapshots, send attempts, and jobs;
- SES notification/event audit and simulator runs.

`0001_initial_schema.sql` is the sole editable pre-launch forward baseline. Migration status records version and checksum and rejects pending, changed, or missing files at application/worker startup. Pre-launch baseline edits require recreating disposable databases. Post-launch changes add immutable forward `0002+` files. Recovery uses a matching backup or reviewed recreate/import, never DOWN SQL.

Production Bun connections use WAL and verify `synchronous=FULL`. Transactions use `BEGIN IMMEDIATE`; rollback is armed only after a successful begin and covers typed failures, defects, and interruption.

## Mailing creation

A mailing is transactional or marketing. Creation validates limits, subject/content, recipient/list input, and idempotency before one database transaction:

1. reserve or replay the `Idempotency-Key`;
2. resolve and snapshot recipients into deliveries;
3. apply create-time suppression policy;
4. insert one durable job per queued delivery;
5. commit the mailing, deliveries, jobs, and idempotency response together.

The same key plus the same normalized request returns the original response. The same key with a different request conflicts. A failed transaction leaves none of the mailing, deliveries, jobs, or idempotency reservation committed.

Delivery status is `queued`, `sending`, `sent`, `failed`, `suppressed`, or `ambiguous`. A mailing is `completed` when every delivery is terminal; this does not mean every email reached an inbox.

Marketing creation additionally requires unsubscribe configuration and `{{ unsubscribe.url }}` in HTML. Recipients matching global, marketing, or list suppression are excluded/suppressed according to purpose. Transactional mail is blocked only by global suppression.

## Queue and sending invariants

Sending and queue code is deliberately conservative because it coordinates a database with an external side effect.

- Jobs are claimed under a lease with a worker owner/fencing token.
- Retry uses bounded attempts and backoff; stale leases can be repaired.
- A send attempt is inserted and committed before the SES call.
- No database transaction remains open across network dispatch.
- Known pre-dispatch/transient failures can retry according to policy.
- Known permanent outcomes become `failed`.
- Provider-unknown outcomes become terminal `ambiguous` and are never automatically redispatched.
- Success updates attempt/delivery evidence atomically.
- Only a compatible non-null SES MessageId tied to the exact latest attempt may reconcile `ambiguous` to sent.
- Crash recovery, stale repair, and cancellation preserve non-redispatch and lease ownership.
- Queue incident state and delivery outcome remain distinct; a dead job is not erased by later delivery reconciliation.

Marketing send-time policy rechecks unsubscribe configuration, marketing configuration set, and current suppressions before dispatch. Successful marketing messages include RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers.

## Unsubscribe and suppression policy

Signed unsubscribe links use `NUSEND_PUBLIC_BASE_URL` and `NUSEND_UNSUBSCRIBE_SECRET`; one previous secret may remain during controlled rotation. Public URLs are normalized and constrained to safe HTTPS origins in production.

Suppressions have `all`, `marketing`, or `list` scope. Permanent bounces and complaints create global suppressions; verified unsubscribes create marketing/list policy. Automated evidence monotonically promotes matching manual rows while preserving row identity/start time. Only rows still classified as manual can be deleted.

Contact edits do not rewrite historical recipient snapshots or email-based suppressions. List membership changes do not silently remove suppressions. Lists referenced by active mailings cannot be deleted.

## SES feedback and readiness

The SNS webhook accepts non-raw SES notifications only after validating:

- SNS signature and supported signature version;
- signing-certificate HTTPS URL and AWS host/path constraints;
- configured TopicArn allowlist;
- message structure and declared SES event body;
- idempotency/correlation before event and suppression writes.

Certificate fetch and subscription confirmation retain SSRF protections. Verified malformed Bounce/Complaint notifications keep one unprocessed raw record and return retryable `503`; malformed outer requests return `400`. Unknown authentic SES event types are retained without inventing suppression behavior.

Readiness consumes the entrypoint's parsed deployment values/issues rather than reparsing environment strings. It reports local schema/config, SES account/identity/configuration sets, SNS topic/subscription, and observed feedback. OPEN/CLICK are required only when explicitly configured for marketing; transactional readiness remains base-event only. Readiness never mutates AWS resources.

## Operations and release boundary

The deployment model is Docker Compose 5.3+ on a host that already has Docker. Compose owns named volumes, migration/owner init hooks, separate API/worker containers, Caddy with automatic public HTTPS in either direct-DNS or Cloudflare-proxied mode, Docker `local` logs, and a mandatory scheduled restic backup service targeting R2. `NUSEND_INGRESS_MODE` selects `direct` or `cloudflare`. Direct mode trusts no forwarding headers; Cloudflare mode trusts only current Cloudflare ranges with strict parsing. Provider DNS/firewall setup remains outside the repository. Follow [`docs/deployment.md`](./docs/deployment.md).

## Development rules

- Preserve atomic mailing/idempotency/queue transactions.
- Preserve write-first attempts, provider ambiguity, lease fencing, and crash repair.
- Preserve SNS verification, redirect stripping, auth/permissions, and secret redaction.
- Prefer direct domain code over one-implementation interfaces, registries, builders, or compatibility bridges.
- Keep pre-launch migrations/state/wire contracts current-only; disposable data is recreated rather than migrated through unreleased formats.
- Validate with `pnpm check` and `pnpm build`; use focused invariant tests when changing protected areas.
