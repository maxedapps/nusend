# Wrangler Config Reference

## Table of contents
- [Source of truth](#source-of-truth)
- [Bindings and environments](#bindings-and-environments)
- [Types](#types)
- [Secrets and vars](#secrets-and-vars)
- [Compatibility dates and flags](#compatibility-dates-and-flags)
- [Deployment notes](#deployment-notes)
- [Official docs](#official-docs)

## Source of truth

- Treat `wrangler.jsonc` / `wrangler.toml` as the source of truth for Worker deployment configuration.
- Deploys can overwrite dashboard-managed config when the setting exists in Wrangler config.
- In this repo, config is JSONC and lives beside each Worker/package:
  - `apps/web/wrangler.jsonc`
  - `apps/admin-api/wrangler.jsonc`
  - `packages/db/wrangler.jsonc` (worker-less D1 owner config)

## Bindings and environments

- Worker bindings include D1, KV, R2, service bindings, vars, secrets, queues, etc.
- Bindings and vars are not implicitly inherited by named Wrangler environments. Repeat them per env when env-specific config exists.
- Keep binding names consistent with TypeScript code. This repo expects `DB` for D1 bindings.
- For D1 bindings, keep `database_name`, `database_id`, and `preview_database_id` aligned across apps that bind the same DB.
- In monorepos, put D1 migration ownership in one config (`packages/db` here) and keep app bindings pointing at the same database.

## Types

- Run `wrangler types` whenever bindings, vars, compatibility flags/dates, or config shape changes.
- Package scripts may wrap this:
  - `pnpm --filter web typecheck` runs `wrangler types && tsc --noEmit`.
  - `pnpm --filter admin-api cf-typegen` runs `wrangler types`.
- Do not hand-edit generated Worker configuration types unless intentionally patching generated output for a known reason.

## Secrets and vars

- `vars` are plain text/JSON config, not a secret store.
- Worker secrets are encrypted bindings and are appropriate for API keys/tokens.
- Local dev uses `.dev.vars` or `.env` beside the Worker config depending on the app; if both exist, precedence can surprise you.
- This repo's web app documents: use `apps/web/.env` for non-secret local config, Infisical for real secrets, and do not keep `apps/web/.dev.vars` around simultaneously.
- If using `secrets.required`, keep it in sync with actual runtime expectations and rerun typegen.

## Compatibility dates and flags

- `compatibility_date` opts the Worker into runtime changes up to that date.
- `compatibility_flags` opt into specific behavior. This repo's web Worker uses `nodejs_compat`.
- `nodejs_compat` enables many Node built-ins/polyfills but does not turn Workers into a serverful Node runtime. Some modules may be partial or stubs.
- When upgrading compatibility dates/flags, run Worker-runtime tests, not only Node tests.

## Deployment notes

- `wrangler deploy` uses the package's config unless a framework/build system redirects to generated config.
- `wrangler deploy --env <name>` targets named environments. Verify env-specific bindings are complete.
- `wrangler deploy --secrets-file` can upload secrets while preserving omitted existing secrets, but avoid committing secret files.
- Do not deploy with placeholder remote D1 IDs unless the task is explicitly local/dev-only and no remote deploy is intended.

## Official docs

- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- TypeScript / `wrangler types`: https://developers.cloudflare.com/workers/languages/typescript/
- Environment variables: https://developers.cloudflare.com/workers/configuration/environment-variables/
- Secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Compatibility dates: https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- Compatibility flags: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Wrangler v3 to v4 migration: https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/
