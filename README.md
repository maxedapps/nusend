# Nusend

Nusend is a single-user, self-hostable, API-first email orchestration service built on AWS SES.

See [`PROJECT.md`](./PROJECT.md) for the product direction, architecture, and implementation phases.

## Development

```sh
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

## Service

```sh
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service db:status
pnpm --filter @nusend/service db:rollback
pnpm --filter @nusend/service auth:bootstrap \
  --email max@example.com \
  --name "Max"
pnpm --filter @nusend/service dev
pnpm --filter @nusend/service worker:send:once
pnpm --filter @nusend/service worker:send
```

The current migration set is intentionally reset-clean. If you have an older local development DB, delete it and recreate it with `db:migrate`.

Default service environment:

```sh
NUSEND_HOST=0.0.0.0
NUSEND_PORT=3000
NUSEND_DB_PATH=.data/nusend.sqlite
```

Auth environment:

```sh
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
NUSEND_AUTH_TRUSTED_ORIGINS=http://localhost:3000
```

Configuration is validated at startup (via Effect `Config`); invalid or partially configured auth environments fail fast with a message that may name several variables at once. Empty or whitespace-only values are treated as unset. In production, auth URLs and trusted origins must use HTTPS.

Send worker / SES environment:

```sh
AWS_REGION=us-east-1
NUSEND_SES_FROM_EMAIL=sender@example.com
NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET=optional-ses-config-set
NUSEND_SES_MARKETING_CONFIGURATION_SET=optional-future-config-set
NUSEND_SES_REQUEST_TIMEOUT_MS=30000
NUSEND_SEND_WORKER_LEASE_SECONDS=300
NUSEND_SEND_WORKER_BATCH_SIZE=1
NUSEND_SEND_WORKER_POLL_MS=5000
```

AWS credentials use the standard AWS SDK provider chain. The API service can queue mailings without SES config; the send worker requires SES config. Worker config must satisfy `batchSize * requestTimeoutMs + 10000 < leaseSeconds * 1000`; the default batch size is `1` for conservative live SES sending.

Google OAuth callback URL:

```txt
http://localhost:3000/api/auth/callback/google
```

Nusend uses Google-only Better Auth login with public signup disabled. Precreate the instance owner with `auth:bootstrap`; unknown Google accounts should be rejected. Programmatic clients should send user-owned API keys via `x-api-key`; API keys require `mailings:create` for mailing creation.

## Mailings API

Create a protected mailing and enqueue delivery jobs:

```sh
curl -i http://localhost:3000/api/mailings \
  -H 'content-type: application/json' \
  -H 'x-api-key: nusend_...' \
  -H 'Idempotency-Key: reset-password-123' \
  --data '{
    "purpose": "transactional",
    "subject": "Reset your password",
    "html": "<p>Reset your password</p>",
    "text": "Reset your password",
    "recipients": [{ "email": "user@example.com" }]
  }'
```

`POST /api/mailings` requires a Better Auth session or a user-owned API key with `mailings:create`. An optional `Idempotency-Key` header replays the original creation response for safe retries; reusing the key with a different normalized request returns `409 idempotency_conflict`.

Request body:

```json
{
  "purpose": "transactional",
  "name": "Password reset",
  "subject": "Reset your password",
  "html": "<p>Reset your password</p>",
  "text": "Reset your password",
  "scheduledAt": "2026-07-03T12:00:00.000Z",
  "recipients": [{ "email": "user@example.com", "vars": { "firstName": "Max" } }]
}
```

Use exactly one recipient source: `recipients` or `listId`. Transactional mailings must use `recipients`; marketing mailings may use either. Validation errors return `400 invalid_request` with all field issues aggregated into one message.

Current limits:

- request body: 1 MB (`413 request_too_large`)
- explicit recipients: 1,000
- list recipients: 5,000 (`422 recipient_limit_exceeded`)
- subject: 200 chars; name: 120 chars
- html/text: 200,000 chars each
- email: 320 chars; list ID: 200 chars
- serialized recipient `vars`: 10,000 bytes
- `Idempotency-Key`: 255 characters after trimming

Success response:

```json
{
  "mailing": {
    "id": "...",
    "purpose": "transactional",
    "state": "scheduled",
    "scheduledAt": "2026-07-03T12:00:00.000Z"
  },
  "counts": {
    "deliveries": 1,
    "queued": 1,
    "suppressed": 0
  }
}
```

A request that resolves to no sendable recipients returns `422 empty_recipient_set`, including when all recipients are suppressed. Suppressed recipients in a partially sendable mailing still get persisted `deliveries` rows, so `counts.deliveries = counts.queued + counts.suppressed`. `scope=all` suppressions block transactional and marketing mail; marketing/list suppressions only block marketing mail.

## Sending

Transactional deliveries can be processed with:

```sh
pnpm --filter @nusend/service worker:send:once
# or keep polling:
pnpm --filter @nusend/service worker:send
```

The worker runs `send_delivery` jobs through the pipeline: load context, start attempt, policy gates, placeholder rendering, SES preparation, raw SES send, and outcome recording. The raw SES transport is purpose-agnostic.

Supported placeholders for now:

- `{{ user.email }}`
- `{{ vars.someKey }}`

HTML placeholder values are escaped. Missing/unsupported placeholders fail the delivery without calling SES.

Marketing mailings can still be created and queued, but worker policy blocks actual marketing sends until unsubscribe support exists.
