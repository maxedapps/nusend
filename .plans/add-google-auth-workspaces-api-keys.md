# Plan: Google-Only Auth, Workspaces, and API Keys

## Summary

Add authentication to Nusend with Better Auth using **Google OAuth only**, **no public signup**, the **Organization plugin** for one self-hosted workspace with optional team members, and the **API Key plugin** for programmatic sending from other applications.

Keep the implementation lean:

- no email/password auth
- no Admin plugin initially
- no custom multi-workspace resource scoping yet
- no Better Auth direct production migrations
- no premature frontend or UI beyond mounted auth endpoints

Use Better Auth with plural table names and snake_case columns, committed through Nusend's custom same-file SQL migration system.

## Implementation Progress

Started: 2026-07-03

- [x] Read full plan before editing.
- [x] Phase 1: Dependencies and config.
- [x] Phase 2: Auth config and schema mapping.
- [x] Phase 3: Migration.
- [x] Phase 4: Hono mount.
- [x] Phase 5: Bootstrap.
- [x] Phase 6: Principal middleware.
- [x] Phase 7: Documentation.
- [x] Validation (`pnpm format`, `pnpm check`, migration smoke).
- [x] Independent review pass after major implementation.
- [x] Final independent review.

Notes:

- Main implementation is coordinated in this file per `implement-plan`.
- Safe parallelism: used read-only `researcher` and `scout` subagents for Better Auth/local-context review; source edits stayed sequential in the main worktree because auth config, migrations, bootstrap, and middleware share schema assumptions.
- Implemented files: `apps/service/src/auth/*`, `apps/service/src/db/migrations/sql/0002_auth.sql`, config/app/main wiring, package script, tests, `.env.example`, `README.md`.
- Generated Better Auth 1.6.23 SQLite DDL with `getMigrations(auth.options).compileMigrations()` and adapted it into Nusend same-file UP/DOWN migration; added a unique organization-member index for idempotent bootstrap.
- Validation passed: `pnpm check`; migration smoke with `/tmp/nusend-auth.sqlite`; bootstrap smoke with `/tmp/nusend-auth-bootstrap.sqlite`; service smoke on port 3401 (`/health`, `/api/auth/get-session`).
- Independent review session `804ab5a0-9102-4a71-9075-b6e8eebd06cf` found no schema/linking blockers. Fixed material feedback: disabled API-key plugin default 10/day rate limit; changed unknown organization roles to deny by default; removed no-op organization `updatedAt` schema mapping. Deferred/accepted notes: auth is required in `main.ts` though `createApp` can still be used without auth in tests; principal middleware is intentionally unused until protected resource routes exist.
- Final review session `a7b2cbe1-5e85-4cbc-b71c-b30167dba6e0` found no must-fix bug. Fixed high-value feedback: added real Better Auth create→verify organization API-key integration test; documented required `configId`; removed redundant slug unique index. Validation after fixes: `pnpm format && pnpm check` passed with 28 tests; migration smoke re-run successfully. Follow-up confirmed all concerns resolved.
- User corrected table naming preference: removed `auth_` prefixes and aligned Better Auth tables to pluralized official names (`users`, `sessions`, `accounts`, `verifications`, `organizations`, `organization_members`, `organization_invitations`, `api_keys`).

## Confirmed requirements

- Interactive login: Google only.
- No public signup. Unknown Google accounts must not be able to create users.
- Server-side bootstrap/precreation should authorize the first user.
- The service should work for:
  - a solo self-hosted operator
  - a small team/workspace with multiple users
- Multiple workspace users should eventually be able to create templates, campaigns, sends, etc.
- Programmatic sending must be supported via API keys for other sites/apps.
- Prefer Organization plugin over Admin plugin for team/workspace behavior.
- Use plural table names and snake_case columns for Better Auth schema.
- Preserve the existing custom migration workflow.

## Current codebase findings

- Hono app factory: `apps/service/src/app.ts`
- Bun server entrypoint: `apps/service/src/main.ts`
- config: `apps/service/src/config.ts`
- SQLite connection helper: `apps/service/src/db/index.ts`
- custom migration runner: `apps/service/src/db/migrate.ts`
- current schema: `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
- service package currently only depends on `hono`.
- existing public endpoints:
  - `GET /health`
  - `GET /health/db`

## Research findings

### Google provider

Docs: <https://better-auth.com/docs/authentication/google>

- Google OAuth needs `clientId`, `clientSecret`, and a correct `baseURL` / `BETTER_AUTH_URL`.
- Google redirect URI must match Better Auth's callback path:
  - local: `http://localhost:3000/api/auth/callback/google`
  - production: `https://your-domain.com/api/auth/callback/google`
- Useful provider options:
  - `prompt: "select_account"`
  - `disableSignUp`
  - `disableImplicitSignUp`
  - optional `hd`, but only rely on it if Better Auth enforces the returned claim server-side for the installed version.

### OAuth account linking and no-public-signup

Docs:

- <https://better-auth.com/docs/concepts/oauth>
- <https://better-auth.com/docs/concepts/users-accounts>
- <https://better-auth.com/docs/reference/errors/account_not_linked>
- <https://better-auth.com/docs/reference/errors/signup_disabled>

Expected strict behavior:

- Precreated local auth user + matching verified Google email: allowed.
- Unknown Google email: rejected because signup is disabled.
- Precreated/invited users do not need a password or credential account.
- First Google login links the Google provider account to the precreated auth user.

Required config direction:

```ts
socialProviders: {
  google: {
    clientId,
    clientSecret,
    disableSignUp: true,
    disableImplicitSignUp: true,
    prompt: "select_account",
  },
},
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ["google"],
  },
},
```

Important: seeded users should have `email_verified = true`, because Better Auth can reject implicit provider linking if the existing local email is not verified.

### Organization plugin

Docs: <https://better-auth.com/docs/plugins/organization>

- Good fit for solo/team workspace behavior.
- Provides organizations, members, invitations, roles, active organization, and permission checks.
- Defaults are more SaaS-like; configure it for a self-hosted single-workspace product.
- Do not enable `teams` or dynamic access control initially.

Recommended initial Organization plugin posture:

```ts
organization({
  allowUserToCreateOrganization: false,
  organizationLimit: 1,
  disableOrganizationDeletion: true,
  requireEmailVerificationOnInvitation: true,
})
```

Critical implementation detail: Better Auth does **not** necessarily set `activeOrganizationId` automatically on session creation. Add a session-create hook that sets the user's single workspace as active.

### API Key plugin

Docs:

- <https://better-auth.com/docs/plugins/api-key>
- <https://better-auth.com/docs/plugins/api-key/advanced>
- <https://better-auth.com/docs/plugins/api-key/reference>

- Use organization-owned keys: `references: "organization"`.
- Do not use API-key session mocking:
  - docs warn about risk
  - it only works for user-owned keys
  - Nusend wants workspace-owned machine credentials
- Use explicit permissions per key.
- Keep key hashing enabled.
- Print full generated keys only once.

### Schema customization

Docs:

- <https://better-auth.com/docs/concepts/database>
- <https://better-auth.com/docs/reference/options>

Better Auth supports:

- `modelName` for table names
- `fields` for DB column names
- plugin schema mapping

TypeScript-side names remain Better Auth's camelCase fields even when DB columns are snake_case.

## Chosen implementation strategy

1. Pin exact Better Auth versions.
2. Add a Better Auth config/factory using Google provider, Organization plugin, and API Key plugin.
3. Map Better Auth tables to plural table names with snake_case columns.
4. Generate SQL with Better Auth CLI against the final installed version and config.
5. Copy/adapt generated SQL into Nusend migration `0002_auth.sql`.
6. Add server-side bootstrap command that raw-inserts the first user/workspace/member, with tests to detect schema drift.
7. Mount `/api/auth/*` in Hono.
8. Add an auth principal model and middleware that supports sessions or org-owned API keys.
9. Defer adding `organization_id` to Nusend email-resource tables until there is a real multi-workspace need.

## Why defer `organization_id` on email resources?

Although Organization plugin is useful now for team membership and org-owned API keys, the product is still self-hosted and should initially have exactly one workspace per deployment.

Adding `organization_id` to `templates`, `contacts`, `lists`, `mailings`, and `suppressions` now would add nullable columns, index churn, uniqueness changes, and query complexity without a second workspace to isolate from.

Deferring keeps the schema lean. If true multi-workspace support is needed later, modern SQLite supports `ALTER TABLE ADD COLUMN` and `DROP COLUMN`, so the migration is manageable.

For now:

- Organization plugin owns team membership and API keys.
- Nusend resources are deployment-wide within the single workspace.
- Route permissions still check the user's/key's workspace membership.

## Alternatives considered

### Admin plugin for provisioning

Rejected initially.

Admin plugin provides a clean `createUser` API, but also adds global user administration features: roles, ban/unban, impersonation, session revocation, user listing, etc. That is broader than the current need.

Instead, use a narrow bootstrap script with raw SQL and add tests that catch Better Auth schema drift.

Reconsider Admin plugin later if Nusend needs first-class user management UI/API, banning, impersonation, or easier provisioning.

### Custom workspace tables instead of Organization plugin

Rejected.

Would require custom invitation, member, permission, active-workspace, and API-key ownership logic. Organization plugin already provides most of this.

### Public Google signup with post-login restrictions

Rejected.

Violates the no-public-signup requirement and creates unwanted users.

### Bearer plugin for API access

Rejected.

API keys are a better fit for long-lived machine credentials and provide naming, expiry, permissions, metadata, revocation, and hashing.

## Dependency changes

In `apps/service/package.json`, add exact runtime dependencies:

```json
{
  "dependencies": {
    "@better-auth/api-key": "1.6.23",
    "better-auth": "1.6.23",
    "hono": "^4.12.27"
  }
}
```

Use exact Better Auth versions initially to reduce schema/API drift risk. Upgrade deliberately later with generated-schema diff review.

## Environment/config changes

Extend `ServiceConfig` in `apps/service/src/config.ts`.

Required when auth is active:

```sh
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NUSEND_AUTH_TRUSTED_ORIGINS=http://localhost:3000
```

Optional later:

```sh
NUSEND_GOOGLE_HOSTED_DOMAIN=
```

Do **not** add an independent `NUSEND_AUTH_COOKIE_SECURE=false` footgun. Derive secure cookies from `BETTER_AUTH_URL`:

- `https://...` => secure cookies
- `http://localhost...` => non-secure allowed for local dev
- production should require HTTPS

Validation rules:

- `BETTER_AUTH_SECRET` must be present and at least 32 chars when auth is configured.
- `BETTER_AUTH_URL` must be absolute.
- In production, `BETTER_AUTH_URL` should be HTTPS.
- Google credentials must be present.
- trusted origins should be parsed as comma-separated origins.

## New/changed files

Likely files:

```txt
.env.example
README.md
apps/service/package.json
apps/service/src/app.ts
apps/service/src/main.ts
apps/service/src/config.ts
apps/service/src/config.test.ts
apps/service/src/auth/auth.ts
apps/service/src/auth/bootstrap.ts
apps/service/src/auth/bootstrap.test.ts
apps/service/src/auth/middleware.ts
apps/service/src/auth/middleware.test.ts
apps/service/src/auth/permissions.ts
apps/service/src/auth/principal.ts
apps/service/src/auth/schema.ts
apps/service/src/db/migrations/sql/0002_auth.sql
apps/service/src/db/migrate.integration.test.ts
```

## Auth module design

Create:

```txt
apps/service/src/auth/
  auth.ts
  bootstrap.ts
  middleware.ts
  permissions.ts
  principal.ts
  schema.ts
```

### `schema.ts`

Define schema mapping in one place.

Target table names:

- `users`
- `sessions`
- `accounts`
- `verifications`
- `organizations`
- `organization_members`
- `organization_invitations`
- `api_keys`

Target column style: snake_case.

Implementation note: write the schema mapping, run Better Auth CLI generation, then treat generated SQL as source of truth. If generated SQL shows different plugin schema keys for `better-auth@1.6.23`, adjust `schema.ts` before committing the migration.

### `permissions.ts`

Define static Organization access control.

Suggested resources:

```ts
const statements = {
  mailings: ["create", "read", "update", "cancel", "send"],
  templates: ["create", "read", "update", "delete"],
  contacts: ["create", "read", "update", "delete", "import"],
  lists: ["create", "read", "update", "delete"],
  suppressions: ["create", "read", "delete"],
  deliveries: ["read"],
  queue: ["read", "retry", "cancel"],
  apiKey: ["create", "read", "update", "delete"],
} as const;
```

Suggested roles:

- `owner`: all permissions.
- `admin`: resource/admin-operational permissions and API key management, but not organization deletion.
- `member`: normal send/resource permissions, no API key management initially.

### `auth.ts`

Prefer an auth factory that accepts the existing Bun SQLite `Database` instance so the app has one managed DB lifecycle.

Pseudo-structure:

```ts
export function createAuth(config: ServiceConfig, db: Database) {
  return betterAuth({
    appName: "Nusend",
    database: db,
    baseURL: config.authBaseUrl,
    secret: config.authSecret,
    trustedOrigins: config.authTrustedOrigins,
    socialProviders: {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        disableSignUp: true,
        disableImplicitSignUp: true,
        prompt: "select_account",
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            // Fail closed: normal OAuth user creation should not happen.
            throw new APIError("BAD_REQUEST", { message: "Signup is disabled" });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const organizationId = await findSingleOrganizationForUser(db, session.userId);
            return { data: { ...session, activeOrganizationId: organizationId } };
          },
        },
      },
    },
    user: authSchema.user,
    session: authSchema.session,
    account: authSchema.account,
    verification: authSchema.verification,
    plugins: [organization(...), apiKey(...)],
  });
}
```

Important: the fail-closed `user.create.before` hook is a safety net only. Bootstrap/preinvite uses raw SQL and bypasses this hook intentionally.

## Hono integration

Update `createApp` to accept auth:

```ts
type AppOptions = {
  pingDatabase?: () => boolean;
  auth?: AuthInstance;
};
```

Mount before `notFound`:

```ts
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
```

Public routes:

- `/health`
- `/health/db`
- `/api/auth/*`
- future unsubscribe route
- future SES SNS webhook route, protected separately by SNS signature verification

## Principal and middleware model

Create a single internal caller shape:

```ts
type SessionPrincipal = {
  kind: "session";
  userId: string;
  organizationId: string;
  role: string;
};

type ApiKeyPrincipal = {
  kind: "api_key";
  apiKeyId: string;
  organizationId: string;
  permissions: Record<string, string[]>;
};

type Principal = SessionPrincipal | ApiKeyPrincipal;
```

Resolution order:

1. If `x-api-key` is present, verify API key and required permissions.
2. Otherwise, resolve Better Auth session from request headers.
3. Ensure session has active organization. If missing, load the user's single organization, set/return it, or return a clear auth error.
4. Return `401` if unauthenticated.
5. Return `403` if authenticated but under-permissioned.

Do not log API key values.

## Bootstrap strategy

Add package script:

```json
{
  "auth:bootstrap": "bun src/auth/bootstrap.ts"
}
```

Usage:

```sh
pnpm --filter @nusend/service auth:bootstrap \
  --email max@example.com \
  --name "Max" \
  --workspace "Nusend" \
  --slug nusend
```

Behavior:

1. Validate DB is migrated.
2. Refuse if an owner already exists unless `--force` is passed.
3. Create/load auth user by lowercased email.
4. Set `email_verified = true`.
5. Do not create password or credential account.
6. Do not create Google account row; first Google login links it.
7. Create/load workspace.
8. Create owner membership.
9. Optionally later support `--create-api-key`, but consider deferring until API-key creation through Better Auth is tested.

This raw-SQL bootstrap is intentionally narrow. Add tests that assert Better Auth can read/use the inserted rows.

## Team invitation strategy

Because Google signup is disabled, invited users must be precreated before first login.

When invitation endpoints are implemented:

1. Owner/admin invites email.
2. Server creates/loads `users` row for that email with `email_verified = true` and no account/password.
3. Server creates organization invitation.
4. Invitation email is sent later via Nusend transactional sending; until then, log or expose the invitation URL only in dev/admin contexts.
5. User signs in with matching Google account.
6. Better Auth links Google account to precreated user.
7. User accepts invitation.

## Migration plan

Add:

```txt
apps/service/src/db/migrations/sql/0002_auth.sql
```

Workflow:

1. Install exact Better Auth versions.
2. Implement auth config/schema mapping.
3. Generate SQL:

```sh
bunx --bun auth@1.6.23 generate \
  --config apps/service/src/auth/auth.ts \
  --output /tmp/nusend-better-auth.sql \
  --yes
```

4. Review generated SQL.
5. Copy/adapt into `0002_auth.sql` under `-- migrate:up`.
6. Write explicit `DROP TABLE` statements under `-- migrate:down` in dependency order.
7. Do not run Better Auth `migrate` against Nusend DBs.

Expected tables:

- `users`
- `sessions`
- `accounts`
- `verifications`
- `organizations`
- `organization_members`
- `organization_invitations`
- `api_keys`

No `organization_id` changes to existing email tables in this phase.

## Implementation tasks

### Phase 1: Dependencies and config

- Add exact Better Auth dependencies.
- Extend config type and loader.
- Add tests for auth env parsing and validation.
- Update `.env.example` and README.

### Phase 2: Auth config and schema mapping

- Add `auth/schema.ts`.
- Add `auth/permissions.ts`.
- Add `auth/auth.ts` factory.
- Include fail-closed user-create hook.
- Include session-create active organization hook.
- Verify generated SQL uses expected names.

### Phase 3: Migration

- Add `0002_auth.sql`.
- Add/extend migration integration tests:
  - migrate up from empty DB
  - expected auth tables exist
  - expected snake_case columns exist
  - rollback drops auth tables
  - migration status reports applied/pending correctly

### Phase 4: Hono mount

- Create auth instance in `main.ts` using the already-open DB.
- Pass auth to `createApp`.
- Mount `/api/auth/*`.
- Test health endpoints still public.
- Test unknown routes still return JSON `not_found`.
- Test `/api/auth/*` is handled by Better Auth rather than app `notFound`.

### Phase 5: Bootstrap

- Add `auth/bootstrap.ts`.
- Add bootstrap script.
- Implement idempotent first-owner/workspace creation.
- Test:
  - creates user/workspace/member
  - lowercases email
  - sets `email_verified`
  - creates no credential account
  - refuses second owner without force
  - Better Auth adapter/session hook can read bootstrapped rows

### Phase 6: Principal middleware

- Add `principal.ts` and `middleware.ts`.
- Resolve session principal.
- Resolve API-key principal.
- Check permissions.
- Tests:
  - no auth => `401`
  - invalid API key => `401`
  - valid API key missing permission => `403`
  - valid API key with permission => success
  - valid session with member row and active org => success
  - session without active org gets single org resolved or clear error

### Phase 7: Documentation

Update README with:

- Google Cloud OAuth redirect URI setup
- required env vars
- migration command
- bootstrap command
- expected seeded-login behavior
- no public signup behavior
- API key usage with `x-api-key`

## Testing and verification commands

```sh
pnpm format
pnpm check
```

Migration smoke:

```sh
NUSEND_DB_PATH=/tmp/nusend-auth.sqlite pnpm --filter @nusend/service db:migrate
NUSEND_DB_PATH=/tmp/nusend-auth.sqlite pnpm --filter @nusend/service db:status
NUSEND_DB_PATH=/tmp/nusend-auth.sqlite pnpm --filter @nusend/service db:rollback
```

Manual Google smoke:

1. Create Google OAuth client with callback `http://localhost:3000/api/auth/callback/google`.
2. Set env.
3. Run migrations.
4. Bootstrap owner.
5. Start service.
6. Sign in with seeded Google email: should succeed.
7. Sign in with unseeded Google email: should fail with signup disabled.

## Risks and mitigations

### Better Auth schema drift

- Pin exact versions.
- Generate SQL from installed version.
- Add migration tests for concrete names.
- Test bootstrapped raw rows are readable by Better Auth.

### Google linking fails for seeded user

- Set `email_verified = true`.
- Configure Google as trusted provider.
- Lowercase emails.
- Add manual smoke test with real Google OAuth.

### Active workspace missing on session

- Add `session.create.before` hook to set active organization.
- Add tests for hook behavior.

### Raw bootstrap bypasses Better Auth APIs

- Keep bootstrap small.
- Avoid password/account insertion.
- Add schema/readback tests.
- Reconsider Admin plugin later if provisioning complexity grows.

### Unknown signup accidentally allowed

- Use both `disableSignUp` and `disableImplicitSignUp`.
- Add fail-closed `user.create.before` hook.
- Test unknown Google email manually before shipping.

### API key leakage

- Never log full `x-api-key` values.
- Print generated key only once.
- Keep key hashing enabled.
- Use narrow default permissions.

### Cookie security misconfiguration

- Derive secure-cookie behavior from `BETTER_AUTH_URL` scheme.
- Require HTTPS in production.

## Open questions / assumptions

- Assumption: one workspace per self-hosted deployment is enough initially.
- Assumption: no Admin plugin unless provisioning/user-management needs grow.
- Assumption: no teams/dynamic access control initially.
- Open implementation detail: whether initial API-key creation belongs in bootstrap or should wait until authenticated key-management routes are added.
