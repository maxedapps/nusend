# Nusend

Nusend is a single-user, self-hosted email orchestration service for AWS SES. It exposes an HTTP API and a first-party CLI for contacts, mailings, delivery operations, and API-key authentication.

The codebase is pre-launch. It is suitable for development and controlled SES testing, but the live production gates in [`docs/production-readiness.md`](./docs/production-readiness.md) must be completed before broad marketing volume. Production Caddy supports explicit direct-DNS and Cloudflare-proxied modes with automatic public HTTPS; the canonical mode selection and rollout procedure is in [`docs/deployment.md`](./docs/deployment.md).

## Quick start

Requirements: Bun, Node.js, and pnpm 11.

```sh
pnpm install
cat > .env <<'EOF'
NODE_ENV=development
NUSEND_DB_PATH=.data/nusend.sqlite
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
NUSEND_AUTH_TRUSTED_ORIGINS=http://localhost:3000
NUSEND_API_KEY_HASH_SECRET=replace-with-another-32-character-secret
EOF
```

`.env.example` is the production deployment inventory, not a ready-to-copy local file. After setting real Google OAuth values and independent random secrets in `.env`, initialize the database and owner:

```sh
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service auth:bootstrap \
  --email max@example.com \
  --name "Max"
pnpm --filter @nusend/service dev
```

The API defaults to `http://localhost:3000`. Useful checks:

```sh
curl http://localhost:3000/health
pnpm --filter @nusend/service db:status
```

Run one send-worker cycle or start its polling loop after configuring SES:

```sh
pnpm --filter @nusend/service worker:send:once
pnpm --filter @nusend/service worker:send
```

The worker requires `AWS_REGION`, `NUSEND_SES_FROM_EMAIL`, and `NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET`. Marketing sends additionally require unsubscribe configuration and a marketing configuration set. AWS credentials use the standard SDK provider chain. See [SES setup](./docs/ses-setup.md).

## CLI

```sh
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
./apps/cli/dist/main.js login http://localhost:3000
./apps/cli/dist/main.js whoami
```

The CLI supports device login/logout, whoami, API-key management, contacts, read-only mailings, JSON output, and local permission repair. It stores one service URL and credential in one atomic private `state.json`; concurrent mutation is unsupported. See [`docs/cli.md`](./docs/cli.md) for commands, precedence, output, and recovery behavior.

## Database lifecycle

Before launch, `apps/service/src/db/migrations/sql/0001_initial_schema.sql` is the single editable forward baseline. After changing it, delete and recreate only disposable local databases. Once a deployment has launched, applied migrations are immutable and schema changes use forward `0002+` files.

Nusend has no DOWN migration path. Recover a non-disposable database from a matching backup or through a reviewed recreate/import procedure. Production SQLite uses WAL and `synchronous=FULL`; that durability setting is not a backup strategy.

## Validation

```sh
pnpm check
pnpm build
```

`pnpm check` runs formatting, lint, typechecking, and product tests. Hosted CI and release automation are intentionally absent.

## Architecture and safety

The core design is documented in [`PROJECT.md`](./PROJECT.md). Important invariants include:

- mailing creation, recipient snapshotting, idempotency, and queue insertion are atomic;
- send attempts are written before SES dispatch;
- provider-unknown outcomes become terminal `ambiguous` deliveries and are not automatically retried;
- queue leases, fencing, backoff, stale repair, and crash recovery prevent unsafe redispatch;
- marketing mail requires unsubscribe/template/configuration-set compliance and suppression checks;
- SNS callbacks require signature, certificate URL, topic, and payload validation;
- API keys are scoped, hashed with a separate secret, expirable, revocable, and never forwarded across redirects.

## Documentation

| Topic | Authority |
| --- | --- |
| Architecture and invariants | [`PROJECT.md`](./PROJECT.md) |
| Local development | [`docs/local-development.md`](./docs/local-development.md) |
| CLI | [`docs/cli.md`](./docs/cli.md) |
| HTTP contracts | [`docs/api.md`](./docs/api.md), `packages/api-contract` |
| Auth and API keys | [`docs/auth-and-api-keys.md`](./docs/auth-and-api-keys.md) |
| SES setup/readiness/testing | [`docs/ses-setup.md`](./docs/ses-setup.md), [`docs/ses-readiness.md`](./docs/ses-readiness.md), [`docs/ses-simulator-testing.md`](./docs/ses-simulator-testing.md) |
| Mode-aware deployment and recovery | [`docs/deployment.md`](./docs/deployment.md) |
| Routine operations | [`docs/operations.md`](./docs/operations.md) |
| Troubleshooting | [`docs/troubleshooting.md`](./docs/troubleshooting.md) |
| Remaining release gates | [`docs/production-readiness.md`](./docs/production-readiness.md) |
