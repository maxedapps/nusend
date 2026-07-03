# Nusend

Nusend is a self-hostable, API-first email orchestration service built on AWS SES.

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
  --name "Max" \
  --workspace "Nusend" \
  --slug nusend
pnpm --filter @nusend/service dev
```

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

Google OAuth callback URL:

```txt
http://localhost:3000/api/auth/callback/google
```

Nusend uses Google-only Better Auth login with public signup disabled. Precreate allowed users with `auth:bootstrap`; unknown Google accounts should be rejected. Programmatic clients should send organization-owned API keys via `x-api-key`.
