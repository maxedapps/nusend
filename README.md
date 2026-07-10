# Nusend

Nusend is a single-user, self-hostable email orchestration product built on AWS SES with two first-class interfaces: HTTP API + CLI.

See [`PROJECT.md`](./PROJECT.md) for the product direction, architecture, and implementation phases. Additional docs: [`docs/product.md`](./docs/product.md), [`docs/cli.md`](./docs/cli.md), [`docs/auth-and-api-keys.md`](./docs/auth-and-api-keys.md), [`docs/api.md`](./docs/api.md), [`docs/deployment.md`](./docs/deployment.md), [`docs/operations.md`](./docs/operations.md), and [`docs/troubleshooting.md`](./docs/troubleshooting.md).

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
NUSEND_API_KEY_HASH_SECRET=replace-with-at-least-32-random-characters
```

Configuration is validated at startup (via Effect `Config`); invalid or partially configured auth environments fail fast with a message that may name several variables at once. Empty or whitespace-only values are treated as unset. In production, auth URLs and trusted origins must use HTTPS.

Send worker / SES environment:

```sh
AWS_REGION=us-east-1
NUSEND_SES_FROM_EMAIL=sender@example.com
NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET=optional-ses-config-set
NUSEND_SES_MARKETING_CONFIGURATION_SET=required-for-marketing-sends
NUSEND_SES_FEEDBACK_TOPIC_ARNS=arn:aws:sns:us-east-1:123456789012:nusend-ses-events-prod
NUSEND_SES_TRACKING_EVENTS=open,click
NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN=tracking.example.com
NUSEND_SES_REQUEST_TIMEOUT_MS=30000
NUSEND_SEND_WORKER_LEASE_SECONDS=300
NUSEND_SEND_WORKER_BATCH_SIZE=1
NUSEND_SEND_WORKER_POLL_MS=5000
NUSEND_PUBLIC_BASE_URL=https://mail.example.com
NUSEND_UNSUBSCRIBE_SECRET=at-least-32-characters
NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET=optional-previous-secret-for-rotation
```

AWS credentials use the standard AWS SDK provider chain. The API service can queue transactional mailings without SES send-worker config; marketing creation requires unsubscribe config. The send worker requires SES config, and marketing sends additionally require unsubscribe config plus `NUSEND_SES_MARKETING_CONFIGURATION_SET`. `NUSEND_SES_FEEDBACK_TOPIC_ARNS` is optional for the API service; when unset, the SES operations webhook returns `404`. Worker config must satisfy `batchSize * requestTimeoutMs + 10000 < leaseSeconds * 1000`; the default batch size is `1` for conservative live SES sending.

`NUSEND_PUBLIC_BASE_URL` must be an absolute HTTPS URL without a query string, fragment, or HTML-escapable characters (`&`, `'`, `"`, `<`, `>`). Retain delivery rows for at least 13 months so old signed unsubscribe links can resolve.

SES operations ingestion uses an SNS HTTPS webhook:

```txt
POST https://<public-host>/api/webhooks/aws/sns/ses
```

Production AWS setup:

1. Create a Standard SNS topic, e.g. `nusend-ses-events-prod`, and set SNS `SignatureVersion=2`.
2. Create an SQS DLQ and attach it to the SNS HTTPS subscription; this is required because `404`/other non-2xx subscription failures can otherwise lose events after SNS handling.
3. Allow SES to publish to the topic, constrained by account and configuration-set source ARN where possible.
4. Create SES configuration sets such as `nusend-transactional-prod` and `nusend-marketing-prod`.
5. Add SNS event destinations for `BOUNCE`, `COMPLAINT`, `REJECT`, and `DELIVERY_DELAY`; optionally `DELIVERY`, `OPEN`, and `CLICK` when tracking is desired.
6. Subscribe the webhook endpoint with default non-raw SNS delivery.
7. Configure alarms on DLQ visible messages and ensure app egress can fetch SNS signing certs and confirmation URLs.
8. Enable SES account-level suppression as defense in depth:

```sh
aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT
```

No SES operations event is emitted unless the send uses an SES configuration set with an event destination. Transactional feedback therefore requires `NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET` in production even though the env var remains optional for compatibility. Validate with the SES mailbox simulator via `pnpm --filter @nusend/service ses:simulate ...`; end-to-end mode must run on the deployment receiving SNS callbacks. Simulator events do not affect SES reputation metrics.

Alternative if HTTPS webhook delivery becomes painful: route `SES configuration set -> SNS topic -> SQS queue -> Nusend feedback worker`. That avoids public webhook confirmation/signature handling and SNS HTTP retry semantics, but requires a future SQS polling worker and AWS credentials in that worker.

Google OAuth callback URL:

```txt
http://localhost:3000/api/auth/callback/google
```

Nusend uses Google-only Better Auth login with public signup disabled. Precreate the instance owner with `auth:bootstrap`; unknown Google accounts should be rejected. Programmatic clients should send first-party Nusend API keys via `x-api-key`; API keys require scoped permissions such as `contacts:read/write`, `lists:read/write`, `mailings:read/write`, `operations:read`, `suppressions:read/write`, and `api_keys:read/write`.

## CLI

Build the CLI locally:

```sh
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
```

Implemented commands cover device login/logout, whoami, API-key management (list is paginated via `--limit`/`--offset`), contacts management, mailings reads, and `config repair-permissions`:

```sh
nusend login http://localhost:3000
nusend whoami --json
nusend api-keys list --limit 10
nusend api-keys create --name ci --permission contacts:read
nusend contacts create user@example.com
nusend contacts list --json
nusend mailings list
nusend mailings get mailing_123
nusend config repair-permissions
```

## Contacts, lists, and suppressions

Protected recipient-management APIs are available for single-owner operation:

```txt
POST /api/contacts
GET /api/contacts
GET /api/contacts/:id
PATCH /api/contacts/:id
DELETE /api/contacts/:id

POST /api/lists
GET /api/lists
GET /api/lists/:id
PATCH /api/lists/:id
DELETE /api/lists/:id
GET /api/lists/:id/contacts
POST /api/lists/:id/contacts
DELETE /api/lists/:id/contacts/:contactId

POST /api/suppressions
GET /api/suppressions
DELETE /api/suppressions/:id
```

Examples:

```sh
curl -H 'x-api-key: nusend_...' -H 'content-type: application/json' \
  --data '{"name":"Customers"}' http://localhost:3000/api/lists

curl -H 'x-api-key: nusend_...' -H 'content-type: application/json' \
  --data '{"contacts":[{"email":"user@example.com"}]}' \
  http://localhost:3000/api/lists/<list-id>/contacts

curl -H 'x-api-key: nusend_...' -H 'content-type: application/json' \
  --data '{"email":"user@example.com","scope":"marketing"}' \
  http://localhost:3000/api/suppressions
```

Contact updates do not rewrite historical delivery snapshots or email-based suppressions. List membership unsubscribe/resubscribe does not remove marketing/global suppressions. Automated bounce, complaint, and unsubscribe suppressions are visible through `GET /api/suppressions` but only `reason='manual'` suppressions can be deleted through the API in this milestone.

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

`POST /api/mailings` requires a Better Auth session or a first-party Nusend API key with `mailings:write`. An optional `Idempotency-Key` header replays the original creation response for safe retries; reusing the key with a different normalized request returns `409 idempotency_conflict`.

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

## Operations inspection

Read-only inspection endpoints help validate SES sends without querying SQLite directly:

```txt
GET /api/operations/summary
GET /api/operations/deliveries
GET /api/operations/deliveries/:id
GET /api/operations/ses/summary
GET /api/operations/ses/events
GET /api/operations/ses/events/:id
GET /api/operations/ses/readiness
GET /api/operations/ses/setup-guide
GET /api/operations/ses/simulator-runs
GET /api/operations/ses/simulator-runs/:id
```

A Better Auth session owner can access these endpoints. API keys need `operations:read`.

```sh
curl -H 'x-api-key: nusend_...' http://localhost:3000/api/operations/summary
curl -H 'x-api-key: nusend_...' \
  'http://localhost:3000/api/operations/deliveries?issue=failed_or_ambiguous'
curl -H 'x-api-key: nusend_...' \
  http://localhost:3000/api/operations/deliveries/<delivery-id>
curl -H 'x-api-key: nusend_...' \
  http://localhost:3000/api/operations/ses/readiness
curl -H 'x-api-key: nusend_...' \
  http://localhost:3000/api/operations/ses/events
```

Manual transactional SES validation flow:

1. create a transactional mailing
2. run `pnpm --filter @nusend/service worker:send:once`
3. inspect `/api/operations/summary`
4. inspect `/api/operations/deliveries/<delivery-id>`
5. verify the SES message ID or failure/ambiguous reason

Responses include operational metadata but omit mailing HTML/text, recipient `vars_json`, auth/session data, API keys, and raw SES/SNS feedback JSON.

## Sending

Transactional deliveries can be processed with:

```sh
pnpm --filter @nusend/service worker:send:once
# or keep polling:
pnpm --filter @nusend/service worker:send
```

The worker runs send-delivery jobs through the pipeline: load context, start attempt, policy gates, placeholder rendering, SES preparation, raw SES send, outcome recording, queue completion/failure, and mailing-state refresh. The raw SES transport is purpose-agnostic.

Current state model:

```txt
mailings.state = scheduled | sending | completed
deliveries.status = queued | sending | sent | failed | suppressed
jobs.state = queued | leased | succeeded | dead
jobs.delivery_id -> deliveries.id
```

`completed` means send processing is finished for all deliveries, not SES inbox delivery confirmation. SES operations is stored separately in audit tables and does not add `delivered`, `bounced`, or `complained` delivery statuses; future pause/cancel/draft workflows may add their own states when implemented.

Supported placeholders for now:

- `{{ user.email }}`
- `{{ vars.someKey }}`
- `{{ unsubscribe.url }}` (marketing HTML templates only)

HTML placeholder values are escaped. Missing/unsupported placeholders fail the delivery without calling SES.

Marketing mailings require unsubscribe config and an HTML `{{ unsubscribe.url }}` placeholder at creation. At send time, marketing deliveries retry if unsubscribe config or `NUSEND_SES_MARKETING_CONFIGURATION_SET` is missing; otherwise they include RFC 8058 one-click unsubscribe headers and are suppressed if the recipient unsubscribed after queueing.

Before real marketing volume, verify SES operations ingestion in production with the simulator, verify in Gmail “Show original” that SES DKIM covers `List-Unsubscribe` and `List-Unsubscribe-Post`, and monitor operations for marketing dead jobs/config retries.
