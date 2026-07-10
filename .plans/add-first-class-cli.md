# Add First-Class Nusend CLI, Device Login, and First-Party API Keys

## Summary

Promote Nusend from an API-only service to a product with two first-class interfaces:

```txt
Nusend = HTTP API + CLI
```

The HTTP API remains the source of truth. The CLI must be a thin, typed HTTP client that imports a shared public API contract but **never imports service internals** and never touches the service SQLite database directly.

This is intentionally a ground-up architectural change, not a quick wrapper. Because Nusend is still early production, this plan chooses breaking, clean refactors over compatibility layers and Better Auth plugin fallbacks.

Core outcomes:

- Update `PROJECT.md` so CLI is a core product interface.
- Add `packages/api-contract` as the shared API/schema/permission contract for `apps/service` and `apps/cli`.
- Replace Better Auth API-key plugin usage with first-party Nusend API-key tables, verification, CRUD, rotation, and permission-subset rules.
- Keep Better Auth for Google browser sessions only.
- Add Nusend-owned OAuth-device-style login for CLI:
  - CLI starts device authorization.
  - User approves in a minimal browser activation page.
  - CLI receives a scoped API key once and stores it locally.
- Add `apps/cli` with clean config, credential, HTTP-client, output, and command architecture.
- Add detailed product, usage, deployment, auth, API-key, CLI, and operations documentation.

## Confirmed requirements

From the user:

- The CLI is now a core part of Nusend, not a future/polish item.
- The CLI should be designed as if planned from the start.
- Avoid quick-and-dirty wrappers and bolt-on auth hacks.
- Big refactors are welcome; early production can break.
- The CLI should wrap the API and eventually allow full product interaction.
- The CLI should manage API keys.
- CLI auth should use a device-code style flow, not require a local browser callback server.
- The implementation plan must be detailed and include analysis details or links to them.

## Important assumptions

These are intentional implementation assumptions; the user should veto before implementation if any are wrong.

1. **No backward compatibility for existing local dev API keys.** Current Better Auth plugin-created API keys can be discarded/recreated after migration.
2. **No hosted multi-tenancy.** The service remains single-user/self-hosted per instance.
3. **No full web dashboard.** Only minimal HTML pages for CLI device activation are allowed.
4. **The CLI is distributed as an app in this repo first.** A polished npm/binary release can follow after behavior stabilizes.
5. **Initial credential storage may use a secure file fallback.** OS keychain support is designed behind an interface but can be implemented later if it would slow the first clean milestone.
6. **Service remains authoritative.** CLI performs UX-level validation only; server schemas and permissions remain authoritative.
7. **API contract package is justified now.** Previously avoided shared packages were premature; now service + CLI are two real consumers.

## Research and evidence

### Local analysis artifacts

- Project state analysis progress note: `.progress/project-state-analysis.md`
- CLI planning progress note: `.progress/add-first-class-cli-plan.md`
- Earlier plan inventory: `.pi-subagents/artifacts/outputs/776ab0ad-9329-41ef-b1ca-54102bbf4a54/analysis/plan-inventory.md`
- Earlier codebase inventory: `.pi-subagents/artifacts/outputs/776ab0ad-9329-41ef-b1ca-54102bbf4a54/analysis/codebase-inventory.md`
- Earlier project review: `.pi-subagents/artifacts/outputs/776ab0ad-9329-41ef-b1ca-54102bbf4a54/analysis/project-state-review.md`
- CLI architecture review: `.pi-subagents/artifacts/outputs/1c6c48e7-5e03-41e3-8111-b416a27e70e1/analysis/cli-architecture-review.md`

### External / standards research

- RFC 8628 OAuth 2.0 Device Authorization Grant: `https://datatracker.ietf.org/doc/html/rfc8628`
  - Relevant concepts: `device_code`, `user_code`, `verification_uri`, optional `verification_uri_complete`, `expires_in`, `interval`, polling errors (`authorization_pending`, `slow_down`, `access_denied`, `expired_token`).
  - Security implications: high-entropy `device_code`, short user-code expiry, rate-limited verification attempts, explicit browser approval context, polling interval enforcement, `slow_down` handling.
- Google limited-input/device-flow docs: `https://developers.google.com/identity/protocols/oauth2-limited-input-device`
  - Confirms common UX pattern and device-flow field semantics.
- Windows Credential Locker: `https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker`
- Freedesktop Secret Service: `https://specifications.freedesktop.org/secret-service/latest-single/`
  - Credential-storage implication: OS keychain abstraction is ideal, but Linux/headless availability varies; initial file store must be explicit, permission-hardened, and redacted.

### Installed dependency evidence

- Better Auth social sign-in source exposes `/sign-in/social`; it returns an authorization URL or session token in certain branches. It is useful for browser session login but not sufficient for CLI credentialing.
- Better Auth API-key plugin source exposes `/api-key/create/list/get/update/delete`, but permissions and other fields are server-only for client requests. Relying on these plugin endpoints would produce a leaky, not-Nusend-owned product API.
- `apps/service/src/auth/auth.integration.test.ts` currently creates API keys through server-side Better Auth internals, proving current API-key support exists but is not an operator/product workflow.

## Current-state codebase findings

### Repository/workspace

- `pnpm-workspace.yaml` currently includes only `apps/*`; it can cleanly expand to include `packages/*`.
- There is no `apps/cli` and no `packages/*` today.
- Root tooling already supports TypeScript, Vitest, oxlint, oxfmt, and recursive typecheck via `pnpm -r --if-present typecheck`.

### Service composition

- `apps/service/src/app.ts`
  - Clean app composition boundary.
  - Mounts `/api/auth/*` as raw Better Auth passthrough.
  - Mounts domain routes for contacts, lists, mailings, operations, SES operations/webhook, suppressions, unsubscribe.
  - Good place to add `/api/me`, `/api/api-keys`, `/api/device-authorizations`, and `/cli/activate`.
- `apps/service/src/main.ts`
  - Runtime composition boundary using Effect `ManagedRuntime`.
  - Requires Better Auth config for service startup.
  - Composes DB, auth, SES operations/admin, SNS verifier/confirmer, unsubscribe, IDs, logger.
  - Needs composition changes when API-key verification becomes first-party and Better Auth API-key plugin is removed.
- `apps/service/src/sending/worker-main.ts`
  - Separate process/runtime boundary for worker; CLI must call HTTP APIs, not worker internals.

### Auth and permissions

- `apps/service/src/auth/auth.ts`
  - Better Auth is configured with Google-only OAuth and API-key plugin.
  - Google/browser sessions should remain here.
  - API-key plugin should be removed from product auth after first-party API keys exist.
- `apps/service/src/auth/middleware.ts`
  - Central principal resolution point.
  - Currently resolves `x-api-key` through Better Auth plugin before session.
  - Should become: resolve first-party API key via `ApiKeyVerifier`, otherwise resolve Better Auth session.
- `apps/service/src/auth/permissions.ts`
  - Current catalog is small: contacts, lists, mailings:create, operations, suppressions.
  - Must move to `packages/api-contract/src/permissions.ts` and expand to support API-key management and CLI workflows.
- `apps/service/src/auth/principal.ts`
  - Current principal types are usable but need a source/credential distinction for first-party API keys and maybe device approval flows.
- `apps/service/src/auth/bootstrap.ts`
  - Local DB operator script for owner bootstrap.
  - Should remain in `apps/service` initially, not become a remote CLI command until bootstrap-over-HTTP is explicitly designed.
- `apps/service/src/services/auth.ts` and `auth-live.ts`
  - Currently expose `handler`, `getSession`, `verifyApiKey`.
  - Should drop `verifyApiKey` from Better Auth service after first-party API-key service is added.
  - Better Auth service should own only `handler`, `getSession`, and possibly helpers for activation-page session checks.
- `apps/service/src/services/auth-decode.ts`
  - API-key decode can be deleted once Better Auth plugin verification is gone.

### Errors and HTTP boundary

- `apps/service/src/errors.ts`
  - Central tagged errors exist and should be extended with device/API-key errors where product-level distinctions matter.
- `apps/service/src/http/respond.ts`
  - Central error-envelope mapping exists.
  - Good contract foundation for CLI error mapping.
  - Should be aligned with a shared `ErrorEnvelope` schema in `packages/api-contract`.

### Database and migrations

- `apps/service/src/db/migrations/sql/0001_initial_schema.sql`
  - Creates Better Auth auth tables and `api_keys` table shaped for Better Auth plugin.
- `0002`, `0003`, `0004`
  - Current sending/SES structures are okay.
- A clean implementation should add a breaking migration that replaces Better Auth plugin `api_keys` semantics with first-party API-key and device-code tables.
  - Since no compatibility is needed, the migration can drop/recreate `api_keys` or rename/remove old plugin-specific columns.
  - Tests must prove migrated final schema, not old plugin compatibility.

### Domain APIs

- Contacts/lists/suppressions have usable CRUD-ish API surfaces and are mostly CLI-friendly.
  - Files: `contacts/*`, `lists/*`, `suppressions/*`.
  - Their schemas currently live inside service modules and should move or be mirrored through `api-contract`.
- Mailings are not fully CLI-friendly yet.
  - `mailings/routes.ts` only exposes `POST /api/mailings`.
  - CLI needs at least list/detail endpoints before “full interaction” feels coherent.
- Operations/SES operations are good read-only starting points.
  - Files: `operations/*`, `ses/routes.ts`, `ses/read-model.ts`, `aws/readiness.ts`.
  - CLI should wrap `ops summary`, `ops deliveries`, `ses readiness`, `ses events`, `ses simulator-runs` early.
- SES simulator is currently a local service script, not an authenticated HTTP command.
  - Keep local script initially; add remote simulator trigger only after auth/permissions and operational risk are designed.

### Tests

- Current suite is broad and green.
- Test patterns support Hono in-process API tests through `withTestApp` and fake auth.
- Need to refactor fake auth/test layers to support first-party API keys and session principals independently.

## Chosen implementation strategy

### Strategy: contract-first refactor, then auth primitives, then CLI foundation, then command coverage

Implement in this order:

1. Product/docs direction update.
2. Shared API contract package.
3. First-party permission catalog and first-party API keys.
4. Device-code login server protocol and minimal activation page.
5. CLI app foundation with login/logout/whoami and API-key commands.
6. Refactor existing service routes to consume shared contract.
7. Add missing API endpoints needed for a coherent CLI.
8. Expand CLI command coverage.
9. Complete docs and validation.

Rationale:

- A CLI without stable API contract will drift.
- Device login without first-party API keys has no clean credential to return.
- API-key management without permission refactor will encode today’s too-narrow `mailings:create` model.
- Adding all commands before config/credential/output/test conventions are stable would multiply rework.

## Alternatives considered

### Alternative A: CLI calls Better Auth plugin endpoints directly

Rejected.

- The plugin endpoint shape is not Nusend product design.
- Client requests cannot set permissions/server-only fields as needed.
- Ties CLI UX to Better Auth internals.
- Does not satisfy “built from the ground up”.

### Alternative B: CLI imports service internals and DB layers

Rejected.

- Violates API-first product architecture.
- Prevents remote usage.
- Duplicates service authorization semantics locally.
- Creates two control planes: HTTP API and local DB scripts.

### Alternative C: Add `apps/cli` first, duplicate request/response types locally

Rejected.

- Fast initially but guaranteed schema drift.
- Bad fit for user’s “super clean” requirement.
- Contract-first avoids duplicated validation and improves docs/OpenAPI later.

### Alternative D: Implement OAuth loopback callback instead of device flow

Rejected for this product direction.

- User prefers device-code flow.
- Device flow works over SSH/headless sessions.
- Loopback can be added later as a convenience, but should not be the primary auth design.

### Alternative E: Keep Better Auth API-key plugin for verification but wrap management with Nusend endpoints

Rejected.

- Still leaves key semantics split between Better Auth and Nusend.
- Permissions/metadata/rotation/revocation become constrained by plugin internals.
- Better to own API keys completely and keep Better Auth focused on Google browser sessions.

## Target project structure

```txt
nusend/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
  PROJECT.md
  README.md
  docs/

  packages/
    api-contract/
      package.json
      tsconfig.json
      src/
        index.ts
        errors.ts
        permissions.ts
        pagination.ts
        routes.ts
        ids.ts
        auth/
          me.ts
          device.ts
        api-keys/
          schema.ts
        contacts/
          schema.ts
        lists/
          schema.ts
        suppressions/
          schema.ts
        mailings/
          schema.ts
        operations/
          schema.ts
        ses/
          schema.ts

  apps/
    service/
      package.json
      tsconfig.json
      src/
        app.ts
        main.ts
        config.ts
        auth/
          auth.ts
          middleware.ts
          principal.ts
          bootstrap.ts
        api-keys/
          routes.ts
          read-model.ts
          write.ts
          verify.ts
          crypto.ts
        device-auth/
          routes.ts
          activate-routes.ts
          read-model.ts
          write.ts
          token.ts
        contacts/
        lists/
        mailings/
        operations/
        queue/
        sending/
        ses/
        suppressions/
        unsubscribe/
        services/
        db/
        testing/

    cli/
      package.json
      tsconfig.json
      src/
        main.ts
        commands/
          login.ts
          logout.ts
          whoami.ts
          api-keys.ts
          contacts.ts
          lists.ts
          suppressions.ts
          mailings.ts
          operations.ts
          ses.ts
        client/
          http.ts
          nusend-api.ts
          errors.ts
        config/
          profiles.ts
          paths.ts
        credentials/
          store.ts
          file-store.ts
          keychain-store.ts
        output/
          json.ts
          table.ts
          format.ts
        testing/
          fake-server.ts
          fixtures.ts
```

Dependency direction must be:

```txt
packages/api-contract
       ↑              ↑
 apps/service      apps/cli
```

Forbidden dependency direction:

```txt
apps/cli -> apps/service/src/*
```

## Data model changes

### First-party API keys

Replace the Better Auth plugin-shaped `api_keys` product semantics with Nusend-owned keys.

Recommended schema:

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_preview TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  rotated_from_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX api_keys_user_id_idx ON api_keys(user_id);
CREATE INDEX api_keys_revoked_at_idx ON api_keys(revoked_at);
CREATE INDEX api_keys_last_used_at_idx ON api_keys(last_used_at);
```

Notes:

- Raw API key is never stored.
- `key_hash` must use HMAC-SHA-256 over the full high-entropy raw API key with a dedicated `NUSEND_API_KEY_HASH_SECRET`. Do not use plain SHA-256. `NUSEND_API_KEY_HASH_SECRET` must be parsed as required service config once first-party API keys are enabled, be at least 32 characters, and be documented as non-rotatable until explicit key-hash-secret rotation support exists.
- `key_preview` should be safe for listing, e.g. `nusend_abcd…wxyz`.
- `permissions_json` must decode against shared permission schema.
- `expires_at` can be nullable initially but CLI-created keys should default to a reasonable non-null expiry unless the user explicitly requests no expiry.

### Device authorizations

```sql
CREATE TABLE device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  user_code_preview TEXT NOT NULL,
  requested_permissions_json TEXT NOT NULL,
  client_name TEXT NOT NULL,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at TEXT,
  denied_at TEXT,
  consumed_at TEXT,
  expires_at TEXT NOT NULL,
  poll_count INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  user_code_attempts INTEGER NOT NULL DEFAULT 0,
  last_user_code_attempt_at TEXT,
  requester_fingerprint_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX device_authorizations_expires_at_idx ON device_authorizations(expires_at);
CREATE INDEX device_authorizations_approved_user_idx ON device_authorizations(approved_by_user_id);
```

Notes:

- Store only hashes for `device_code` and `user_code`.
- `user_code_preview` is okay for operator inspection if it is the same display code, but if threat model says no, omit it.
- `requested_permissions_json` must be visible during browser approval.
- `consumed_at` enforces one-time exchange.
- Polling writes `poll_count` / `last_poll_at` for abuse visibility and `slow_down` decisions.
- Browser activation/user-code checks write `user_code_attempts` / `last_user_code_attempt_at`; after a small bounded number of wrong attempts, reject or temporarily lock the authorization.
- `requester_fingerprint_hash` is optional but recommended for unauthenticated start throttling without storing raw IP/user-agent. Use a server-side hash secret or HMAC and do not expose this value in APIs.

### Migration approach

Because compatibility is not required:

1. Add a migration that drops or rewrites old Better Auth plugin `api_keys` table.
2. Create the new first-party `api_keys` shape.
3. Create `device_authorizations`.
4. Update migration integration tests to assert final columns/indexes/checks.
5. Update docs to say existing dev keys must be recreated.

If Better Auth itself expects an `api_keys` table only because plugin is configured, remove the plugin before migration assumptions are finalized.

## Permission catalog redesign

Move permission definitions to `packages/api-contract/src/permissions.ts`.

Recommended initial catalog:

```ts
export const permissionCatalog = {
  contacts: ["read", "write"],
  lists: ["read", "write"],
  suppressions: ["read", "write"],
  mailings: ["read", "write"],
  operations: ["read"],
  ses: ["read"],
  api_keys: ["read", "write"],
} as const;
```

Mapping from current permissions:

- `mailings:create` becomes `mailings:write`.
- SES operations can either remain under `operations:read` or use `ses:read`; choose one and apply consistently.
  - Recommended: `operations:read` covers all operational/SES read surfaces initially to keep the catalog lean.
  - Defer `ses:write` / `workers:run` until remote simulator or worker controls exist.

Permission helper requirements:

- Validate permission JSON at key creation.
- Reject unknown resources/actions.
- Implement subset checks:
  - Session owner can create any permission set.
  - API key principal can only create keys whose requested permissions are a subset of its own permissions.
  - API key without `api_keys:write` cannot create/revoke/rotate keys.
- Provide display helpers for CLI and activation pages.

## API contract package

### Package setup

Create `packages/api-contract`:

```json
{
  "name": "@nusend/api-contract",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./permissions": {
      "types": "./dist/permissions.d.ts",
      "default": "./dist/permissions.js"
    },
    "./routes": {
      "types": "./dist/routes.d.ts",
      "default": "./dist/routes.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "effect": "4.0.0-beta.93"
  }
}
```

Update `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

The package must build to runtime JavaScript in `dist/`; do not export `.ts` source files if the CLI is a Node-executable `dist/main.js`. Add `tsconfig.build.json` for declaration + JS output, ensure `dist/` is ignored, and make `apps/cli` build depend on or be run after `@nusend/api-contract` build. Alternative if implementation chooses Bun-only CLI: document Bun-only consistently and keep both contract/CLI source execution aligned. This plan chooses built JS packages.

### Contract contents

`src/errors.ts`:

- `ErrorEnvelopeSchema`
- known error codes
- CLI-safe error formatting data

`src/pagination.ts`:

- `PaginationSchema`
- `PaginationMetaSchema`
- default/max limits

`src/routes.ts`:

- Route constants and path builders:
  - `routes.me = "/api/me"`
  - `routes.apiKeys.list = "/api/api-keys"`
  - `routes.device.start = "/api/device-authorizations"`
  - etc.

`src/permissions.ts`:

- catalog
- schema
- parser for `resource:action`
- subset helper
- normalization helper

Domain schema modules:

- Move/copy public request and response schemas out of service modules.
- Keep DB row schemas in service; only public API schemas belong in contract.
- Service routes should decode with contract schemas.
- CLI client should decode responses with contract schemas.

Important distinction:

- `packages/api-contract`: public HTTP contract.
- `apps/service/src/*/read-model.ts`: DB-to-response implementation details.
- `apps/cli/src/*`: command UX, output formatting, local config.

## Service auth/API-key implementation

### New service modules

Add `apps/service/src/api-keys/`:

- `crypto.ts`
  - generate API key secret
  - hash API key secret
  - build preview
  - constant-time comparison if needed
- `schema.ts` if service-only helpers are needed; public schemas go in `api-contract`.
- `verify.ts`
  - verify `x-api-key`
  - reject revoked/expired keys
  - update `last_used_at` after successful verification
  - return `ApiKeyPrincipal`
- `read-model.ts`
  - list keys without secrets
  - get key metadata
- `write.ts`
  - create key
  - revoke key
  - rotate key
  - validate permission subset
- `routes.ts`
  - HTTP endpoints

### API-key HTTP endpoints

```txt
GET /api/api-keys
POST /api/api-keys
DELETE /api/api-keys/:id
POST /api/api-keys/:id/rotate
```

Optional later:

```txt
PATCH /api/api-keys/:id
```

Create request:

```json
{
  "name": "local-cli",
  "permissions": {
    "contacts": ["read", "write"],
    "lists": ["read", "write"],
    "mailings": ["read", "write"],
    "operations": ["read"],
    "api_keys": ["read", "write"]
  },
  "expiresAt": "2027-07-09T00:00:00.000Z"
}
```

Create response returns raw key once:

```json
{
  "apiKey": {
    "id": "...",
    "name": "local-cli",
    "key": "nusend_...",
    "preview": "nusend_abcd…wxyz",
    "permissions": {...},
    "createdAt": "...",
    "expiresAt": "...",
    "lastUsedAt": null,
    "revokedAt": null
  }
}
```

List response never returns raw key:

```json
{
  "items": [
    {
      "id": "...",
      "name": "local-cli",
      "preview": "nusend_abcd…wxyz",
      "permissions": {...},
      "createdAt": "...",
      "expiresAt": "...",
      "lastUsedAt": "...",
      "revokedAt": null
    }
  ],
  "pagination": {...}
}
```

### Middleware refactor

Refactor `auth/middleware.ts`:

- Stop calling `Auth.verifyApiKey`.
- Add `ApiKeyVerifier` service or direct module function requiring `Database`.
- Resolution order:
  1. If `x-api-key` exists, verify first-party API key.
  2. Else resolve Better Auth session.
- Keep session principal as full owner.
- Keep API keys permission-scoped.

### Better Auth refactor

Refactor `auth/auth.ts`:

- Remove `@better-auth/api-key` plugin.
- Delete API-key schema mapping if no longer used.
- Keep Google-only OAuth and signup-disabled behavior.

Refactor `services/auth.ts`:

- Remove `verifyApiKey`.
- Keep:
  - `handler(request)`
  - `getSession(headers)`

Refactor tests accordingly.

## Device-code login implementation

### Public contract

Add schemas in `packages/api-contract/src/auth/device.ts`.

Start:

```txt
POST /api/device-authorizations
```

Request:

```json
{
  "clientName": "nusend-cli on MaxBook",
  "permissions": {
    "contacts": ["read", "write"],
    "lists": ["read", "write"],
    "mailings": ["read", "write"],
    "operations": ["read"],
    "api_keys": ["read", "write"]
  }
}
```

Response:

```json
{
  "deviceCode": "secret-random-device-code",
  "userCode": "X7KD-22QA",
  "verificationUri": "https://mail.example.com/cli/activate",
  "verificationUriComplete": "https://mail.example.com/cli/activate?code=X7KD-22QA",
  "expiresAt": "2026-07-09T15:00:00.000Z",
  "intervalSeconds": 5
}
```

Poll/token:

```txt
POST /api/device-authorizations/token
```

Request:

```json
{ "deviceCode": "secret-random-device-code" }
```

Pending response:

```json
{ "status": "authorization_pending", "intervalSeconds": 5 }
```

Slow-down response:

```json
{ "status": "slow_down", "intervalSeconds": 10 }
```

Denied response:

```json
{ "status": "access_denied" }
```

Expired response:

```json
{ "status": "expired_token" }
```

Success response:

```json
{
  "status": "approved",
  "apiKey": {
    "key": "nusend_...",
    "id": "...",
    "name": "nusend-cli on MaxBook",
    "preview": "nusend_abcd…wxyz",
    "permissions": {...},
    "expiresAt": "..."
  }
}
```

### Activation page

Add `apps/service/src/device-auth/activate-routes.ts` mounted at:

```txt
GET  /cli/activate
POST /cli/activate
```

Behavior:

- If not signed in, show a minimal page with a “Sign in with Google” link/button that starts Better Auth social sign-in with callback back to `/cli/activate?code=...`.
- If signed in:
  - show user code input if not provided
  - show requested CLI/device/scopes/expiry after valid code
  - require explicit approve/deny button
- POST approve sets `approved_by_user_id` and `approved_at`.
- POST deny sets `denied_at`.

Security copy on page:

- Show instance base URL.
- Show CLI/device name.
- Show requested permissions.
- Show expiry.
- Warn not to approve codes you did not request.

### Device-code service rules

- `deviceCode`: high-entropy random secret, shown only to CLI, stored hashed.
- `userCode`: shorter human code, store hashed, rate-limit attempts.
- Expiry: 10 minutes initially.
- Poll interval: 5 seconds initially.
- `slow_down`: if polling too frequently, return larger interval.
- Single-use: success sets `consumed_at`; subsequent poll fails as expired/invalid.
- Approval does not create raw API key until successful token poll, avoiding storage of raw key.
- API key created by device flow should have name like `CLI: <clientName>` and requested permissions.

## `GET /api/me`

Add a simple principal introspection endpoint.

```txt
GET /api/me
```

Response for session:

```json
{
  "principal": {
    "kind": "session",
    "userId": "...",
    "permissions": "owner"
  }
}
```

Response for API key:

```json
{
  "principal": {
    "kind": "api_key",
    "userId": "...",
    "apiKeyId": "...",
    "permissions": {...}
  }
}
```

CLI uses this for:

```sh
nusend whoami
```

## CLI implementation

### Package setup

Create `apps/cli/package.json`:

```json
{
  "name": "@nusend/cli",
  "private": true,
  "type": "module",
  "bin": {
    "nusend": "dist/main.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node scripts/make-bin-executable.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@nusend/api-contract": "workspace:*",
    "effect": "4.0.0-beta.93"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "vitest": "^4.1.9"
  }
}
```

Keep CLI dependency-light at first. Use built-in `fetch`, `fs`, and simple argument parsing unless a CLI framework becomes clearly valuable. Build TypeScript to executable JavaScript in `dist/`; do not rely on package-manager magic executing `src/main.ts` directly. `src/main.ts` should have a Node-compatible shebang in the emitted file path or the package should provide a postbuild/chmod step so `nusend --help` works from a fresh checkout after `pnpm --filter @nusend/cli build`.

### Runtime/services

Use Effect style without overengineering.

Services:

- `CliConfig`
  - load profiles from config file
  - resolve `--profile`, `--base-url`, env overrides
- `CredentialStore`
  - read/write/delete API key by profile/base URL
  - file implementation first
  - keychain interface placeholder
- `NusendHttpClient`
  - base URL normalization
  - JSON requests
  - `x-api-key` injection
  - error envelope parsing
  - response schema decoding
- `Output`
  - JSON mode
  - human mode
  - redaction helpers

### Local config

Path:

```txt
~/.config/nusend/config.json
```

Schema:

```json
{
  "activeProfile": "prod",
  "profiles": {
    "prod": {
      "baseUrl": "https://mail.example.com"
    }
  }
}
```

Environment overrides:

```txt
NUSEND_BASE_URL
NUSEND_API_KEY
NUSEND_PROFILE
```

Rules:

- Env vars win for non-interactive CI.
- `--profile` wins over active profile.
- `--base-url` can be used for one command or during login.
- Config file should be created with `0600` where possible.
- Credential file should be separate or clearly redacted.

### Credential storage

Initial file store path defaults to XDG-style config on Unix and appropriate platform config directories elsewhere:

```txt
$XDG_CONFIG_HOME/nusend/credentials.json
# fallback on Unix/macOS:
~/.config/nusend/credentials.json
# Windows: use APPDATA or LOCALAPPDATA under Nusend\credentials.json
```

Do not hardcode only `~/.config` in implementation; centralize path resolution in `apps/cli/src/config/paths.ts` and test Linux/macOS/Windows env cases.

Permissions:

- Create parent directory with `0700` on Unix.
- Create credential file with `0600` on Unix.
- Write atomically via temp file + rename where possible.
- Refuse to use if broader permissions are detected, unless user runs a repair command such as `nusend config repair-permissions`.
- On Windows, document that POSIX mode checks do not apply and rely on user-profile ACLs until keychain support exists.
- Never print raw key except immediately after explicit `api-keys create --show` type operations.

Possible credential schema:

```json
{
  "credentials": {
    "prod": {
      "apiKey": "nusend_...",
      "apiKeyId": "...",
      "preview": "nusend_abcd…wxyz",
      "createdAt": "..."
    }
  }
}
```

Future keychain store:

- `CredentialStore` interface should allow OS keychain implementation later.
- Do not block first milestone on cross-platform keychain package complexity.

### Initial commands

Phase 1 commands:

```sh
nusend login <base-url> [--name <client-name>] [--permission resource:action ...]
nusend logout [--profile <name>]
nusend whoami [--json]
```

Login default permissions should be useful but not omnipotent. Recommended default for interactive CLI:

```txt
contacts:read/write
lists:read/write
suppressions:read/write
mailings:read/write
operations:read
api_keys:read/write
```

Require explicit flag for all known permissions if adding future destructive/admin scopes.

Phase 2 commands:

```sh
nusend api-keys list [--json]
nusend api-keys create --name <name> --permission resource:action ... [--expires-at ...]
nusend api-keys revoke <id>
nusend api-keys rotate <id>
```

Phase 3 commands:

```sh
nusend contacts list [--email ...]
nusend contacts create <email>
nusend contacts update <id> --email <email>
nusend contacts delete <id>

nusend lists list
nusend lists create <name>
nusend lists update <id> --name <name>
nusend lists delete <id>
nusend lists contacts <id> [--status subscribed|unsubscribed|all]
nusend lists add-contact <id> <email...>
nusend lists remove-contact <id> <contact-id>

nusend suppressions list [--email ... --scope ... --reason ...]
nusend suppressions create <email> --scope all|marketing|list [--list-id ...]
nusend suppressions delete <id>
```

Phase 4 commands:

```sh
nusend mailings create --file request.json [--idempotency-key ...]
nusend mailings send-transactional --to user@example.com --subject ... --html-file ...
nusend mailings list
nusend mailings get <id>

nusend ops summary
nusend ops deliveries [--status ... --issue failed_or_ambiguous]
nusend ops delivery <id>

nusend ses readiness [--include-aws=false]
nusend ses events [--event-type ...]
nusend ses event <id>
nusend ses simulator-runs
```

Do not implement all commands in the first coding slice. Build the foundation and one or two command families first.

### Output conventions

Every command supports:

```sh
--json
```

Human mode:

- concise tables or key-value summaries
- redacts secrets
- clear next-step hints for login/auth errors

JSON mode:

- stable JSON only
- no spinners/prose
- non-zero exit on error with stable error object to stderr or stdout consistently

Recommended error format in JSON mode:

```json
{
  "error": {
    "code": "forbidden",
    "message": "API key does not have the required permissions."
  }
}
```

Exit codes:

- `0` success
- `1` unexpected/internal CLI failure
- `2` usage/argument error
- `3` authentication required/invalid credentials
- `4` server returned expected API error

## Service API additions for CLI completeness

### Mailings read API

Add:

```txt
GET /api/mailings
GET /api/mailings/:id
```

Permission:

```txt
mailings:read
```

List response should omit email body by default or include only preview/metadata.

Detail response can include subject/html/text only if authorized; since single-owner, this is okay, but be explicit.

Why needed:

- CLI cannot manage created mailings if it can only create them and inspect deliveries indirectly.

### Optional future: queue/worker controls

Do not add in the first CLI foundation unless product need is immediate.

Potential later endpoints:

```txt
POST /api/operations/worker/run-once
POST /api/operations/jobs/:id/retry
```

These are operationally risky and require `workers:run` / `operations:write` permission design.

## Documentation updates

### `PROJECT.md`

Update these sections:

- Purpose:
  - Nusend has HTTP API + CLI as core interfaces.
- Current Status:
  - Move CLI from “not implemented” to planned/current after implementation.
- Current Interface:
  - Split into HTTP API and CLI.
- Product Boundaries:
  - Still no web dashboard; minimal activation page only.
  - CLI is not premature anymore.
- Auth Model:
  - Better Auth Google sessions for browser/activation.
  - First-party Nusend API keys for CLI/programmatic use.
  - Device-code login for CLI.
- Current Data Model:
  - First-party `api_keys` and `device_authorizations`.
- Roadmap Order:
  - Add CLI/Auth foundation before templates/R2/assets.
- Future Client Tooling:
  - Replace “No CLI exists today” with CLI-as-core design.

### Docs to add/update

Add:

- `docs/product.md`
  - what Nusend is/is not
  - HTTP API + CLI as interfaces
- `docs/local-development.md`
  - setup, tests, fake/local usage
- `docs/auth-and-api-keys.md`
  - owner bootstrap
  - Google session
  - device login
  - API-key permissions, create/revoke/rotate
- `docs/cli.md`
  - install/run commands
  - profiles/config/env precedence
  - login/logout/whoami
  - JSON mode
- `docs/api.md`
  - route families, auth, examples
- `docs/deployment.md`
  - API + worker processes
  - migrations
  - bootstrap
  - reverse proxy/TLS
  - backups
- `docs/operations.md`
  - readiness, SES validation, logs, worker runs, retention
- `docs/troubleshooting.md`
  - auth, API key, device login, SES, worker, DB issues

Update:

- `README.md`
  - quick start
  - CLI examples
  - pointer to detailed docs
- `docs/production-readiness.md`
  - include CLI/API-key validation steps
- `docs/ses-readiness.md`
  - include CLI command examples after commands exist

## Implementation tasks

### Phase 0 — Preparation and guardrails

1. Create implementation progress tracker for the coding task, e.g. `.progress/add-first-class-cli.md`.
2. Run baseline validation:
   - `git status --short`
   - `pnpm check`
3. Decide exact first implementation slice before editing.
4. Keep one writer in active worktree.
5. Use independent reviews after major phases.

Validation:

- Baseline `pnpm check` recorded.

### Phase 1 — Product direction and workspace structure

1. Update `pnpm-workspace.yaml` to include `packages/*`.
2. Add `packages/api-contract` skeleton.
3. Add `apps/cli` skeleton with no real commands yet except `--help`/version placeholder.
4. Add build scripts for `@nusend/api-contract` and `@nusend/cli`; root build order must build contract before CLI, e.g. `pnpm --filter @nusend/api-contract build && pnpm --filter @nusend/cli build`.
5. Update root scripts if needed so recursive typecheck includes both packages.
6. Update `PROJECT.md` to make CLI first-class.

Files likely changed:

- `pnpm-workspace.yaml`
- `package.json`
- `PROJECT.md`
- `packages/api-contract/package.json`
- `packages/api-contract/tsconfig.json`
- `packages/api-contract/src/index.ts`
- `apps/cli/package.json`
- `apps/cli/tsconfig.json`
- `apps/cli/src/main.ts`

Validation:

- `pnpm install` if lockfile changes.
- `pnpm -r --if-present typecheck`
- `pnpm check`

Review checkpoint:

- Review workspace boundaries: ensure CLI does not import service internals.

### Phase 2 — Shared contract foundation

1. Move/copy permission catalog into `packages/api-contract/src/permissions.ts`. In the same slice, update all route permissions and tests from `mailings:create` to the new `mailings:write` vocabulary; do not leave the repository in a broken intermediate state. Temporary aliases are allowed only inside this phase and must be removed before the phase is considered complete.
2. Add error envelope schema in `packages/api-contract/src/errors.ts`.
3. Add pagination schemas/helpers in `packages/api-contract/src/pagination.ts`.
4. Add route constants/path builders in `packages/api-contract/src/routes.ts`.
5. Add public schemas for:
   - `auth/me.ts`
   - `auth/device.ts`
   - `api-keys/schema.ts`
6. Refactor service to import permission catalog from `@nusend/api-contract`.
7. Keep existing domain schemas in service for now; migrate them incrementally later.

Files likely changed:

- `packages/api-contract/src/*`
- `apps/service/src/auth/permissions.ts` maybe deleted/re-exported temporarily
- `apps/service/src/auth/middleware.ts`
- `apps/service/src/mailings/routes.ts` and mailings/auth tests for `mailings:write`
- tests importing permissions

Validation:

- contract typecheck
- service typecheck
- auth/middleware tests
- full `pnpm check`

### Phase 3 — First-party API-key data/model/service

1. Remove Better Auth API-key plugin from `apps/service/src/auth/auth.ts`.
2. Remove Better Auth API-key schema mapping from `auth/schema.ts` if unused.
3. Refactor `AuthService` to remove `verifyApiKey`.
4. Add first-party `api_keys` migration and dedicated API-key hash secret config (`NUSEND_API_KEY_HASH_SECRET`) with tests for missing/short/empty values.
5. Add `apps/service/src/api-keys/crypto.ts`.
6. Add `verify.ts`, `write.ts`, `read-model.ts`.
7. Update `auth/middleware.ts` to verify first-party keys.
8. Update fake test auth/runtime to support first-party API-key verification or seed real keys.

Files likely changed:

- `apps/service/src/auth/auth.ts`
- `apps/service/src/auth/schema.ts`
- `apps/service/package.json` and `pnpm-lock.yaml` to remove `@better-auth/api-key`
- `apps/service/src/services/auth.ts`
- `apps/service/src/services/auth-live.ts`
- `apps/service/src/services/auth-decode.ts` deleted or simplified
- `apps/service/src/auth/middleware.ts`
- `apps/service/src/api-keys/*`
- `apps/service/src/db/migrations/sql/0005_first_party_api_keys_and_device_auth.sql`
- `apps/service/src/testing/layers.ts`
- auth/middleware/API tests

Validation:

- migration integration tests
- auth integration tests
- middleware tests
- protected route tests across contacts/lists/mailings/operations/suppressions
- full `pnpm check`

Important test cases:

- invalid key -> 401
- expired key -> 401
- revoked key -> 401
- valid key updates `last_used_at`
- insufficient permission -> 403
- session still bypasses per-route permissions
- key creation returns raw secret once
- key list never returns raw secret
- API-key-created key can access allowed route

### Phase 4 — API-key management HTTP endpoints

1. Add `apps/service/src/api-keys/routes.ts`.
2. Mount in `app.ts` at `/api/api-keys`.
3. Implement:
   - `GET /api/api-keys`
   - `POST /api/api-keys`
   - `DELETE /api/api-keys/:id`
   - `POST /api/api-keys/:id/rotate`
4. Enforce `api_keys:read/write` for API-key principals.
5. Enforce subset permissions for API-key-created keys.
6. Allow session owner full key management.

Validation:

- route tests for session and API-key principals
- subset enforcement tests
- raw-key redaction tests
- full `pnpm check`

### Phase 5 — Device-code login service endpoints

1. Add device auth schemas to contract.
2. Add `apps/service/src/device-auth/token.ts` for code generation/hash/format.
3. Add `write.ts` for start/approve/deny/poll/consume logic.
4. Add `read-model.ts` if needed.
5. Add `routes.ts` for:
   - `POST /api/device-authorizations`
   - `POST /api/device-authorizations/token`
6. Implement RFC-like statuses:
   - `authorization_pending`
   - `slow_down`
   - `access_denied`
   - `expired_token`
   - `approved`
7. Ensure success creates API key at consumption time and returns raw key once.

Validation:

- start returns correct fields
- poll pending
- poll too fast -> `slow_down`
- approve then poll -> raw API key once
- second poll after consumed -> expired/invalid
- deny then poll -> denied
- expired -> expired
- invalid device code -> invalid request/unauthenticated style decision
- requested permissions validated
- device-flow-created key works with `/api/me`
- unauthenticated start throttling works
- user-code brute-force lockout/rate limiting works

### Phase 6 — Minimal activation page

1. Add `apps/service/src/device-auth/activate-routes.ts`.
2. Mount at `/cli/activate`.
3. Add minimal HTML render helpers or local string templates.
4. If unauthenticated:
   - display sign-in link/button to Better Auth Google social sign-in with callback back to activation page.
5. If authenticated:
   - allow entering user code
   - show requested client/scopes/expiry
   - approve/deny form
7. Add noindex/no-store headers.
8. Add CSRF protection for approval/deny POSTs: generate a per-form token, store it server-side or in a signed same-site cookie, validate it on POST, and reject cross-site POSTs.
9. Check `Origin`/`Referer` where available for browser form POSTs.
10. Sanitize logs and paths; never log codes/tokens.

Validation:

- unauthenticated activation page renders
- signed-in page validates code
- invalid/expired code messages
- approve updates DB
- deny updates DB
- missing/invalid CSRF token rejects approval/deny
- cross-site Origin/Referer rejects approval/deny where applicable
- no raw device code appears in HTML
- browser/manual test with local dev server if feasible

### Phase 7 — `GET /api/me`

1. Add contract schema.
2. Add route module or simple route in auth area.
3. Mount `/api/me`.
4. Return principal kind and permissions.

Validation:

- session response
- API-key response
- unauthenticated 401
- CLI can decode response in tests later

### Phase 8 — CLI foundation

1. Ensure `@nusend/api-contract` builds to `dist` JavaScript and CLI runtime imports resolve to built JS, not `.ts` source.
2. Implement argument parsing for:
   - `nusend --help`
   - `nusend --version`
   - global `--profile`, `--base-url`, `--json`
2. Implement config path resolution.
3. Implement config schema decode.
4. Implement credential store interface.
5. Implement secure file credential store.
6. Implement HTTP client with:
   - base URL normalization
   - `x-api-key`
   - JSON encode/decode
   - contract response decoding
   - error envelope mapping
7. Implement output helpers.

Validation:

- CLI unit tests for argument parsing
- config read/write tests using temp HOME/XDG dirs
- credential file permission tests where platform supports it
- HTTP client tests against fake fetch/fake server
- `pnpm --filter @nusend/cli typecheck`

### Phase 9 — CLI login/logout/whoami

1. Implement `nusend login <base-url>`:
   - call device start
   - print activation URL and code
   - poll token endpoint respecting interval and `slow_down`
   - store profile + credential after success
2. Implement `nusend logout`:
   - delete local credential
   - optionally support `--revoke` to call server revoke before local delete
3. Implement `nusend whoami`:
   - call `/api/me`
   - print human/JSON output

Validation:

- fake-server login success
- pending then approved flow
- slow_down handling
- denied/expired handling
- Ctrl-C does not print secrets
- whoami unauthenticated error hints
- no key leaked in logs/stdout except expected success storage confirmation

### Phase 10 — CLI API-key commands

1. Implement:
   - `api-keys list`
   - `api-keys create`
   - `api-keys revoke`
   - `api-keys rotate`
2. Parse permissions through shared contract helper.
3. Human output redacts raw key except create/rotate success, where it must be shown exactly once with warning.
4. JSON output must include raw key only for create/rotate success.

Validation:

- command tests with fake server
- permission parsing tests
- redaction tests
- E2E service+CLI test if feasible

### Phase 11 — Refactor existing domain schemas toward contract package

Migrate public request/response schemas incrementally:

1. Contacts schemas.
2. Lists schemas.
3. Suppressions schemas.
4. Mailings create/result schemas.
5. Operations query/response schemas.
6. SES operations query/response schemas.

For each module:

- Move public schema to `packages/api-contract`.
- Service route imports contract decoder/schema.
- Service DB row schemas stay in service.
- CLI client imports contract schema.
- Tests adjusted.

Validation:

- targeted route tests per module
- CLI client decode tests
- full `pnpm check`

### Phase 12 — Missing API endpoints for CLI completeness

Add before broad mailings CLI commands:

```txt
GET /api/mailings
GET /api/mailings/:id
```

Potential response fields:

List item:

```json
{
  "id": "...",
  "purpose": "transactional",
  "state": "completed",
  "name": "...",
  "subject": "...",
  "scheduledAt": "...",
  "createdAt": "...",
  "updatedAt": "...",
  "counts": {
    "queued": 0,
    "sending": 0,
    "sent": 1,
    "failed": 0,
    "suppressed": 0
  }
}
```

Detail can include `html`/`text` because this is single-owner, but operations endpoints should continue omitting bodies.

Validation:

- list/detail route tests
- permissions tests
- no vars leakage unless explicitly designed

### Phase 13 — CLI domain commands

Add command families in dependency order:

1. Contacts
2. Lists
3. Suppressions
4. Operations
5. SES operations
6. Mailings

For each family:

- Implement human + JSON output.
- Use contract schemas.
- Add fake-server CLI tests.
- Add at least one in-process service integration smoke when useful.

Do not add remote worker-control/simulator-write commands in this phase unless API endpoints are deliberately designed.

### Phase 14 — Documentation and examples

1. Update `README.md` quick start.
2. Update `PROJECT.md` comprehensively.
3. Add docs listed above.
4. Add copy-paste examples:
   - local dev setup
   - owner bootstrap
   - CLI login
   - API-key create
   - create transactional mailing through CLI
   - CI usage with API key env vars
   - SES readiness through CLI
5. Include security notes:
   - device-code phishing warning
   - API-key storage/revocation
   - least privilege
   - no web dashboard

Validation:

- docs command examples manually checked where feasible
- links valid
- no stale “CLI not implemented” statements remain

## Testing and verification strategy

### Always-run validation

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

### Targeted service tests

- `apps/service/src/auth/*`
- `apps/service/src/api-keys/*`
- `apps/service/src/device-auth/*`
- `apps/service/src/app.test.ts`
- route tests for contacts/lists/suppressions/mailings/operations after contract migration
- migration integration tests

### Targeted CLI tests

- command parsing
- config/profile precedence
- credential storage permissions/redaction
- device login polling behavior
- API client error mapping
- JSON output stability
- fake server command flows

### End-to-end smoke

After enough pieces exist:

1. Start service with test/dev DB.
2. Migrate DB.
3. Bootstrap owner.
4. Simulate or perform browser activation.
5. `nusend login` receives/stores key.
6. `nusend whoami` works.
7. `nusend api-keys create` creates scoped key.
8. Use scoped key to create contact/list/mailing.
9. Inspect operations.

### Manual/browser verification

Required for activation page:

- Start local service.
- Visit `/cli/activate` unauthenticated.
- Confirm Google sign-in path redirects back.
- Approve code.
- CLI poll completes.

Use agent-browser or equivalent for manual UI verification when implementing.

## Security considerations

- Never log raw API keys, device codes, user codes, cookies, unsubscribe tokens, mailing HTML, recipient vars, or raw SES/SNS payloads.
- Hash API keys and device codes before storage.
- Make device authorizations short-lived.
- Rate-limit device-start requests, user-code attempts, and aggressive polling.
- Display exact instance URL, client name, scopes, and expiry on activation page.
- Require explicit approval; no auto-approval after sign-in.
- CLI credentials must be redacted in diagnostics.
- API keys should be revocable and rotatable.
- Device-flow-created key should default to CLI-requested permissions, not owner-all magical access.
- API key principals creating keys must be limited to permission subsets.
- Document CI should use pre-created API keys, not interactive device login.

## Rollout / migration notes

- This is a breaking auth/key migration.
- Existing Better Auth sessions can remain.
- Existing Better Auth plugin API keys should be considered invalid after migration.
- Docs should instruct users to recreate API keys through CLI or first-party API.
- If a local development DB contains old plugin keys, migration may drop them.
- Because this is early production, do not add compatibility translation unless user later requires production preservation.

## Risks and mitigations

### Risk: shared contract becomes too broad or duplicates service internals

Mitigation:

- Only public API schemas in `packages/api-contract`.
- Keep DB rows and business workflows in service.

### Risk: CLI scope explodes

Mitigation:

- Implement foundation first: login/whoami/api-keys.
- Add domain command families incrementally.

### Risk: device flow security mistakes

Mitigation:

- Follow RFC 8628 semantics.
- Store hashes only.
- Add expiry, polling interval, slow_down, start throttling, user-code attempt limits, CSRF protection, Origin/Referer checks, and one-time consumption.
- Require explicit browser approval with clear context.

### Risk: API-key permission model too permissive

Mitigation:

- Session owner is full owner.
- API-key-created keys must be permission subsets.
- Default CLI login scopes are explicit and shown for approval.

### Risk: credential storage is insecure

Mitigation:

- Abstract credential store now.
- Use `0600` file permissions initially.
- Add OS keychain store later without changing commands.
- Document CI env vars and local security tradeoffs.

### Risk: no OpenAPI means docs/CLI drift

Mitigation:

- `api-contract` is the first source of truth.
- Add OpenAPI generation later once contract stabilizes.
- Do not hand-code docs examples that contradict schemas.

## Recommended subagent/delegation during implementation

Use one writer at a time in the active worktree. Safe read-only parallelization:

- Reviewer for API-key auth/security design after Phase 3.
- Reviewer for device-flow implementation after Phase 6.
- Reviewer for CLI config/credential security after Phase 9.
- Context-builder for contract migration mapping before Phase 11.
- Reviewer for docs accuracy before final completion.

Do not run multiple writer workers in the same worktree.

## Definition of Done

The full change is complete when:

- `PROJECT.md` describes CLI as a core interface.
- `packages/api-contract` exists and is consumed by service + CLI.
- Better Auth is used for Google browser sessions only.
- First-party Nusend API keys replace Better Auth plugin key semantics.
- API-key CRUD/rotation endpoints exist and are tested.
- Device-code login endpoints and activation page exist and are tested.
- `apps/cli` exists with at least:
  - `login`
  - `logout`
  - `whoami`
  - `api-keys list/create/revoke/rotate`
- CLI stores credentials through an explicit credential-store abstraction.
- CLI supports stable `--json` output for implemented commands.
- Existing domain routes still pass tests after permission/contract refactors.
- New docs cover product, CLI, auth/API keys, deployment, operations, and troubleshooting.
- `pnpm check` passes.
- Manual/browser verification of device activation is performed.
- Independent reviews find no blockers for auth/security/architecture.

## Open questions

None blocking for planning.

Implementation-time choices that can use default assumptions unless vetoed:

1. Use secure file credential storage first; keychain behind interface later.
2. Use `operations:read` for SES read surfaces initially; do not add separate `ses:read` until needed.
3. Default CLI login permissions include contacts/lists/suppressions/mailings read/write, operations read, and API-key read/write.
4. Existing Better Auth plugin API keys are dropped/recreated instead of migrated.


## Independent review follow-up incorporated

A fresh reviewer examined this draft via subagent run `f47895e9-9cb2-46b5-89a2-f804ec902a3a`; artifact: `.pi-subagents/artifacts/outputs/f47895e9-9cb2-46b5-89a2-f804ec902a3a/analysis/add-first-class-cli-plan-review.md`.

Accepted changes from review:

- Added mandatory CSRF protection and Origin/Referer checks for `/cli/activate` approval/deny POSTs.
- Added concrete start/user-code abuse controls: attempt counters, last-attempt timestamps, optional requester fingerprint hash, throttling and tests.
- Tightened API-key hashing: require high-entropy raw keys plus HMAC-SHA-256 with dedicated `NUSEND_API_KEY_HASH_SECRET`; plain SHA-256 is not acceptable.
- Clarified CLI runtime/build strategy: `bin` points to `dist/main.js`, with an explicit build/chmod path and validation that `nusend --help` works from a fresh checkout.
- Clarified permission-catalog migration must update all current route/tests in the same slice, especially `mailings:create` → `mailings:write`.
- Added package cleanup for removing `@better-auth/api-key` from `apps/service/package.json` and lockfile.
- Clarified activation sign-in/callback behavior needs an implementation spike/test because Better Auth trusted origins and callback URLs are strict.
- Tightened credential file path/permission/atomic-write behavior, including XDG/Windows/macOS considerations.

Follow-up reviewer run `1044c6e6` found the original blockers resolved but identified a package/runtime contradiction: Node-built CLI cannot import `@nusend/api-contract` if it exports `.ts` source. This plan now requires `@nusend/api-contract` to build to `dist` JS/types and exports built JS. It also makes the activation callback spike a concrete Phase 6 task.

Reviewer found no remaining architecture blockers after these corrections.

## Implementation Progress

Tracker canonical path: `.plans/add-first-class-cli.md` (this section). Started: 2026-07-09.

### Scope and loop strategy

- Goal: implement the plan incrementally, preserving one writer in the active worktree.
- Initial implementation slice: Phases 0–1 first (workspace/package skeletons, placeholder CLI, PROJECT.md update), then validate/review before continuing into contract/auth phases.
- Loop type: feature/build loop with security/architecture review checkpoints.
- Human checkpoint: not required for Phase 0–1 because the provided plan gives explicit defaults; required later only if implementation discovers materially ambiguous security/product tradeoffs.
- Browser verification: not applicable until activation page work (Phase 6); skipped for Phase 0–1 because no browser-visible UI is changed.
- Subagent decomposition decision: use read-only scouts/reviewers for mapping and review; keep all edits in the main agent in this active worktree. No implementation subagents yet because Phase 1 touches shared workspace/build files and should remain single-writer.

### Progress log

| Phase/Loop | Status | Analysis / Plan | Actions | Verification | Review / Decisions |
|---|---|---|---|---|---|
| Phase 0 baseline | Complete | Read the full plan. Baseline repo status showed `.plans/add-first-class-cli.md` untracked before implementation; no code edits yet. | Added this retained progress tracker in the plan file. Ran read-only scout `bf34bcb2` for Phase 1 recon; artifact `.pi-subagents/artifacts/outputs/bf34bcb2-85c8-4726-8490-6aee42c925b5/phase1-recon.md`. | Baseline `pnpm check` passed (format, lint with existing no-await-in-loop warnings, recursive typecheck, 49 test files / 316 tests). | Subagent decision: read-only scout useful; no parallel writers because Phase 1 edits shared workspace/build files. |
| Phase 1 workspace + skeleton | Complete | Implement only skeleton/package/product-direction work first. Scout confirmed package/build tsconfigs need emit-specific overrides because root config is no-emit/Bun-oriented. | Added `packages/api-contract` skeleton, `apps/cli` skeleton, root build script, workspace `packages/*`, lockfile workspace importers, and updated `PROJECT.md` product direction. Deviation: `pnpm --filter @nusend/cli exec nusend --help` does not find the package bin from the repo root, so validation/docs use `./apps/cli/dist/main.js --help` after build. Fixed TypeScript 6 build error by setting `rootDir: "src"` in build tsconfigs. | `pnpm install` passed. Initial `pnpm build` failed on TS5011 rootDir; fixed. `pnpm check` passed after targeted oxfmt (same existing oxlint warnings in `apps/service/src/main.integration.test.ts`). `pnpm build` passed. `./apps/cli/dist/main.js --help` and `--version` passed. Browser verification skipped: no browser UI in this phase. | Fresh read-only reviewer `57432b3f` found no blockers; note about stale `dist/src` from earlier failed build resolved by deleting dist and rebuilding cleanly. |
| Phase 2 contract foundation | Complete | Add shared contract modules and move permission catalog. Use TS paths for source typechecking while package exports stay dist JS/types for runtime builds. Update `mailings:create` to `mailings:write` in service/tests in one slice. | Added permissions/errors/pagination/routes/auth/device/auth/me/api-key schemas in `packages/api-contract`; re-exported service auth permissions from `@nusend/api-contract/permissions`; added service workspace dependency; updated `mailings:["create"]` to `["write"]`; added root TS paths and TS 6 `ignoreDeprecations` for `baseUrl`. | `pnpm build` initially found Effect Schema API mismatches; fixed `Schema.Union([...])` and duplicate struct instead of nonexistent `Schema.extend`. `pnpm build`, `pnpm -r --if-present typecheck`, `pnpm test`, and `pnpm check` passed. Clean rebuild after `rm -rf apps/cli/dist packages/api-contract/dist` passed. Grep found no remaining `mailings:["create"]`/`mailings:create` in `apps/service/src`; no service-internal imports in CLI. Browser verification skipped: no browser UI in this phase. | Fresh read-only reviewer `81913e84` found no Phase 2 blockers; reviewer noted README still mentioned old `mailings:create`, fixed during Phase 3 docs cleanup. |
| Phase 3 first-party API-key model/service | Complete | Remove Better Auth API-key plugin and add first-party key storage/verification with HMAC secret. Use one ApiKeys service around DB/ID dependencies; keep test fake for existing middleware tests and real service for API-key route tests. | Removed Better Auth API-key plugin usage/dependency and `AuthService.verifyApiKey`; added `NUSEND_API_KEY_HASH_SECRET` config, `api_keys`/`device_authorizations` migration `0005`, API-key crypto/service modules, first-party middleware verification, test runtime layering, and migration/config/auth tests. | `pnpm install`, `pnpm -r --if-present typecheck`, `pnpm test`, and `pnpm check` passed after fixes. Migration tests now assert new final API-key/device schema and rollback to legacy plugin table. Browser verification skipped: no browser UI in this phase. | Needs API-key security review after Phase 4 endpoints. |
| Phase 4 API-key management endpoints | Complete | Add CRUD/rotation endpoints using first-party service and permission subset rules. Sessions are owner; API-key principals need `api_keys:read/write` and can only create subsets. | Mounted `/api/api-keys`; added list/create/revoke/rotate routes and tests for create/list/raw-key redaction/use/rotate/revoke/subset enforcement. Also added `/api/me` now because tests and CLI foundation need principal introspection. Updated README/PROJECT stale API-key permission docs. Security review `698395b0` found high blocker: rotation was not atomic; fixed by wrapping replacement create + old-key revoke in `Database.transaction`. Also fixed invalid `expiresAt` strings becoming never-expiring keys by validating parseability/future date at create time and treating malformed stored dates as invalid in verification. Added tests for malformed/expired `expiresAt`, raw hash storage, `last_used_at`, and missing `api_keys` permissions. | `pnpm test` passed (50 files / 317 tests before fixes; 319 tests after fixes). `pnpm check` passed with existing no-await-in-loop warnings. Clean `pnpm build` and built CLI `--help` passed before review; post-fix `pnpm check` passed. Browser verification skipped: no browser UI in this phase. | Follow-up review `2047967c` found no blockers; noted malformed stored `expires_at` path lacks a dedicated regression test, accepted as non-blocking but should be added if touching API-key tests again. |
| Phase 5 device-code login service endpoints | Complete | Implement device authorization start/token with hashed codes, expiry, slow_down, one-time consumption, and internal approve/deny helpers for Phase 6 activation page. Keep browser verification skipped until activation UI exists. | Added `device-auth` token/service/routes modules; mounted `/api/device-authorizations`; added DeviceAuthorizations service/layers/fakes; start returns device/user codes and verification URIs; token handles pending/slow_down/denied/expired/approved; approved consumption atomically creates a first-party API key and marks authorization consumed. | `pnpm -r --if-present typecheck` passed. Device-auth route tests passed in full Vitest run (51 files / 321 tests). `pnpm check` passed with existing no-await-in-loop warnings. Clean build after deleting dist passed; built CLI `--help` passed. Browser verification skipped: no browser UI in this phase. | Device-flow review deferred until Phase 6 activation page, per plan. |
| Phase 6 activation page | Complete | Implement minimal `/cli/activate` page with session-required approval/deny, no-store/noindex headers, CSRF token cookie, Origin/Referer checks, and no raw device code in HTML. Browser verification required after implementation. | Added `device-auth/activate-routes.ts`; mounted `/cli/activate`; added session-aware sign-in page, code-entry/approval form, CSRF cookie+hidden token, Origin/Referer checks, approval/deny POST handlers, no-store/noindex headers, HTML escaping, and tests. Device-flow review `904a1bd8` found no blockers but noted deny-after-approve and malformed Referer hardening; fixed both and added tests. | `pnpm -r --if-present typecheck` passed. Activation tests passed in full Vitest run (52 files / 323 tests). `pnpm check` passed with existing no-await-in-loop warnings. Clean build after deleting dist passed; built CLI `--version` passed. Browser verification: started local service with temp DB/auth env, used `npx -y agent-browser` to open `http://localhost:43917/cli/activate?code=ABCD-1234`, verified rendered unauthenticated sign-in page text/snapshot, saved screenshot `/tmp/nusend-activation-unauth.png`, closed browser and stopped server. | Follow-up review `e4ba19e5` found no blockers. Residual risk accepted: user-code attempt/rate limiting fields exist but are not enforced yet. |
| Phase 7 `/api/me` | Complete | Implemented early in Phase 4 because API-key route tests and CLI need principal introspection. | Added `apps/service/src/auth/me-routes.ts` and mounted `/api/me`. | Covered by API-key route tests and `pnpm check`. Browser verification not applicable. | No separate review needed; included in API-key and device-flow reviews. |
| Phase 8 CLI foundation | Complete | Build config/profile/credential/http/output foundations with simple dependency-light architecture; keep CLI a thin HTTP client importing only `@nusend/api-contract`. | Added config path/profile loader, secure atomic file credential store, HTTP client with API-key injection and contract response/error decoding, output helpers, CLI argument parsing, and unit tests. Build deviation/fix: CLI build needs `tsconfig.build.json` paths pointing to built `@nusend/api-contract/dist` declarations so runtime imports remain package imports while build does not compile package source into CLI. Removed accidental generated files from `packages/api-contract/src`. CLI review `e8129c7c` found high blocker: credential directory mode was not refused on read; fixed by checking both directory and file modes. Also fixed CLI/env precedence so explicit flags win over env, changed `--json login` initial approval info to stderr so stdout remains one final JSON document, and fixed reviewer follow-up blocker where login option values (`--name`, `--permission`) were mistaken for positional base URL when `--base-url` is used. | `pnpm --filter @nusend/cli typecheck` and CLI tests passed. Full `pnpm check` passed (58 files / 336 tests) with existing/no-blocking no-await-in-loop warnings, including intentional CLI login polling warnings. Clean build after deleting dist passed; built CLI `--help` and `--version` passed. Browser verification not applicable to CLI foundation. | Follow-up CLI review `8951f08f` found no blockers. |
| Phase 9 CLI login/logout/whoami | Complete | Implement device-flow login polling, profile/config persistence, secure credential storage, logout, and whoami. | Added `login`, `logout`, `whoami`, global `--profile/--base-url/--json`; login starts device authorization, prints approval URL/code, polls respecting pending/slow_down, stores credential/profile after approved. Logout deletes local credential and optionally revokes current key. Whoami calls `/api/me`. Added regression test for `--base-url ... login --name ... --permission ...` option parsing. | CLI unit test covers `whoami --json` with fake fetch/env credential. Full `pnpm check` passed. No live login E2E yet; device server flow separately tested and activation browser checked. | Follow-up CLI review `8951f08f` found no blockers. |
| Phase 10 CLI API-key commands | Complete | Implement list/create/revoke/rotate API-key commands with shared permission parsing and redacted human output except raw key on create/rotate. | Added `api-keys list/create/revoke/rotate`; create parses repeated `--permission resource:action` through `@nusend/api-contract/permissions`; create/rotate intentionally print raw key once in human/JSON result. | CLI unit test covers API-key create request body/permission parsing with fake fetch. Full `pnpm check` passed. | Follow-up CLI review `8951f08f` found no blockers. |
| Phase 11 domain schema migration / Phase 12 missing mailings read API / Phase 13 domain commands | Partial: contacts slice complete; remaining domain families deferred | Plan asks for broad public schema migration and command families. Context-builder `01f326d4` recommended a bounded contacts end-to-end slice first because full Phase 11-13 is broad and high-churn. Decision: do not mix lists/suppressions/mailings/ops/SES into this already-large auth+CLI change; record as follow-up rather than risk broad churn. | Added `packages/api-contract/src/contacts/schema.ts`, contacts route helpers, contract exports, service contact body decoder using contract request schema while keeping service normalization/query/DB schemas local, CLI contacts client methods, and `contacts list/get/create/update/delete` commands. Added CLI tests for contacts create and list query JSON. Did not yet implement lists/suppressions/mailings read/operations/SES command families. | `pnpm --filter @nusend/api-contract typecheck`, `pnpm --filter @nusend/cli typecheck`, CLI tests, full `pnpm check` (55 files / 332 tests after excluding dist), clean build after deleting dist, and built CLI `--version` passed. Browser verification not applicable: CLI/API-only. | Contacts slice review `8f23ffc7` found no blockers; noted get/update/delete CLI command tests would be useful if expanding this slice. |
| Phase 14 docs/final validation | Complete | Add core docs required by the plan, then run full validation and final independent review. | Added `docs/product.md`, `docs/local-development.md`, `docs/auth-and-api-keys.md`, `docs/cli.md`, `docs/api.md`, `docs/deployment.md`, `docs/operations.md`, and `docs/troubleshooting.md`; updated README intro, auth env, and CLI examples. | `pnpm check` passed (55 files / 332 tests) with no blocking issues; lint warnings are existing/intentional no-await-in-loop warnings in service boot poll and CLI login polling. Clean build after deleting dist passed; built CLI `--help` and `--version` passed. `git diff --cached --name-only` empty. `git diff --check` passed. Browser verification already performed for activation unauth page; no additional UI changes. | Final independent review `18b029f9` found no blockers. Residual accepted risk: user-code attempt/fingerprint columns exist but activation user-code attempt throttling is not enforced yet. |

