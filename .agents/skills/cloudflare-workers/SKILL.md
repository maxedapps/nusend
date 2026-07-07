---
name: cloudflare-workers
description: >
  Use this skill when working on Cloudflare Workers platform code or configuration: Wrangler, wrangler.jsonc/toml, D1 databases and migrations, Worker bindings/env/secrets, Cloudflare Vite plugin, @cloudflare/vitest-pool-workers tests, cron triggers, waitUntil/background work, nodejs_compat, observability/logging, R2 provisioning, deployment, or local-vs-remote Cloudflare behavior. Use it for implementation, debugging, review, planning, and config changes in Cloudflare-hosted TypeScript apps. Do not use for generic frontend-only React work unless Worker runtime/config/bindings are involved.
metadata:
  short-description: Cloudflare Workers, Wrangler, D1, Vite, testing, observability, and project conventions
---

# Cloudflare Workers

## Goal

Help agents make correct Cloudflare Workers platform changes, avoiding local/remote data mistakes, stale Wrangler patterns, insecure logging, and runtime mismatch bugs.

## First steps

1. Identify the affected Worker/package and read its Cloudflare files first:
   - `wrangler.jsonc`, `worker-configuration.d.ts`, `src/index.ts`, `src/app.ts`, `src/bindings.ts`
   - `src/dispatch/dispatcher.ts`, `src/dispatch/processors.ts`
   - `vitest.config.ts`, `test/apply-migrations.ts`, `migrations/`
2. Check package versions before copying docs/examples:
   - `wrangler`, `@cloudflare/vitest-pool-workers`, `vitest`, `typescript`
3. Prefer official Cloudflare docs and current local config over memory or old blog snippets.
4. Run `wrangler types` / package typecheck when bindings, vars, secrets declarations, compatibility flags/dates, or Wrangler config changed.

## Load deeper references when needed

- Read [Wrangler config](references/wrangler-config.md) before changing `wrangler.jsonc`, bindings, envs, secrets, compatibility flags/dates, or deploy config.
- Read [D1](references/d1.md) before touching D1 SQL, migrations, local/remote DB commands, D1 tests, transactions, or data consistency.
- Read [Vite plugin](references/vite-plugin.md) before changing `apps/web/vite.config.ts`, Vite dev/build behavior, React Start integration, `persistState`, or Worker assets behavior.
- Read [Vitest Workers](references/vitest-workers.md) before changing Worker integration tests or `@cloudflare/vitest-pool-workers` config.
- Read [Observability and security](references/observability-security.md) before logging, auth/secret handling, webhooks, `observability`, invocation logs, or sensitive request data.
- Read [Project conventions](references/project-conventions.md) for this repo's exact commands, file map, and known pitfalls.

## Core rules

### Wrangler and bindings

- Treat Wrangler config as the deployment source of truth. Dashboard changes to config-managed settings can be overwritten by deploys.
- Bindings and vars are environment-specific; do not assume they inherit across Wrangler envs.
- `vars` are plain config, not secrets. Use Worker secrets for API keys/tokens and local `.dev.vars`/`.env` only according to the app's documented setup.
- After binding/config changes, regenerate Worker types with the package script (`cf-typegen` or `typecheck` where it runs `wrangler types`).
- Keep `compatibility_date` and `compatibility_flags` explicit. When relying on Node APIs, confirm `nodejs_compat` is actually in the Worker config, not just test setup.
- When wrapping a fixed-port dev server in Portless (for example `wrangler dev --port 8791`), also pass the matching Portless app port (`portless run --app-port 8791 ...`) or let Portless choose and inject the port entirely; otherwise Portless may proxy the hostname to its own random port while the Worker listens elsewhere, causing 502s.
- For plain `wrangler dev` Workers, local Worker secrets should be present in that app's `.dev.vars`; an outer `infisical run ... wrangler dev` shell env does not reliably make secrets available as Worker `env` bindings. If another app signs/verifies with an Infisical secret, compare non-disclosing fingerprints and duplicate the same local value into `.dev.vars` when needed.

### D1

- Do not run remote D1 commands unless the task explicitly calls for remote DB work and placeholder database IDs have been replaced deliberately.
- Use `packages/db` scripts for local migrations/queries so all apps share the repo-root `.wrangler-persist` state.
- Do not run multiple long-lived local Worker/Vite dev servers against the same custom `--persist-to` directory unless that concurrency has been proven safe; shared persist is good for sequential CLI migration/query commands, but separate isolated Workers may need separate local persist dirs and explicit seed steps.
- Hide raw D1 access behind app services; do not scatter `env.DB.prepare(...)` through business logic.
- Prefer `prepare().bind()` for application queries. Avoid `exec()` except maintenance/one-off SQL where injection is impossible.
- In maintenance SQL run through `wrangler d1 execute`, do not use SQLite `RAISE()` as a general guard expression; SQLite only allows `RAISE()` in trigger programs, so do existence/validation guards in application/script code or use ordinary statements that are valid outside triggers.
- Use `batch()` for transactional multi-statement writes. Design for D1 limits: bounded statements, bound parameter limits, query duration, and single-database throughput.

### Worker runtime

- Use module Worker handlers (`fetch`, `scheduled`) and pass `env`/`ctx` at boundaries. Import `env` / `waitUntil` from `cloudflare:workers` only intentionally.
- Use `ctx.waitUntil()` or imported `waitUntil` for background work that must continue after the response.
- Cron triggers are UTC and config-managed; test scheduled handlers locally when changing cron behavior.
- `nodejs_compat` does not make Workers a full Node server. Audit dependencies for unsupported/stubbed Node APIs and serverful assumptions.

### Testing and validation

- Prefer Worker-runtime tests for code that depends on bindings, D1, Web Crypto, Worker globals, or compatibility flags.
- In this repo, use `cloudflareTest` from `@cloudflare/vitest-pool-workers` package root; avoid older `defineWorkersConfig` / `/config` examples unless the installed version actually supports them.
- Use `SELF.fetch` for end-to-end Worker route behavior and real D1 migrations where the test is meant to exercise production-like bindings.

### Observability and security

- Logs persist; assume request URLs, custom logs, and errors can expose secrets/PII if you include them.
- Do not log raw secrets, bearer tokens, webhook path secrets, OAuth tokens, raw user payloads, or sensitive response bodies.
- Prefer structured, minimal, redacted logs with operation names and non-sensitive IDs/statuses.
- Disable or sample invocation logs for routes whose URL/path/query contains secrets or high-volume sensitive data.

## Antipatterns to avoid

- Running raw `wrangler d1 ...` commands from the wrong package or without this repo's shared local persistence path.
- Treating local D1 state as remote/production, or omitting `--local` when the task is local-only.
- Copying outdated Vitest pool examples without checking installed package exports.
- Adding secrets to `vars`, source files, committed `.env` examples with real values, or logs.
- Assuming Cloudflare's Vite plugin honors every Wrangler build/rules/minify option the same way `wrangler dev` does.
- Depending on Node APIs because tests passed while `nodejs_compat` was implicitly injected by a test tool.

## Validation checklist

Before finishing Cloudflare-related changes, check the relevant subset:

- [ ] Wrangler config and generated Worker types are in sync.
- [ ] Local D1 commands used `packages/db` scripts / shared persistence.
- [ ] Remote D1/deploy commands were not run accidentally.
- [ ] Secrets are not stored in `vars`, source, logs, or committed files.
- [ ] Worker-runtime tests or typechecks were run for runtime-sensitive changes.
- [ ] Observability config does not persist URL/path secrets or sensitive request data.
- [ ] Official docs were consulted for unfamiliar Cloudflare APIs or version-sensitive behavior.
