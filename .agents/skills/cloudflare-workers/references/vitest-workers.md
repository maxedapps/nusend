# Workers Vitest Reference

## Table of contents
- [When to use Worker-runtime tests](#when-to-use-worker-runtime-tests)
- [Project pattern](#project-pattern)
- [Testing D1](#testing-d1)
- [Version-sensitive APIs](#version-sensitive-apis)
- [Official docs](#official-docs)

## When to use Worker-runtime tests

Use `@cloudflare/vitest-pool-workers` tests when code depends on:

- Worker bindings (`env.DB`, R2, KV, service bindings, etc.)
- `cloudflare:test` / `cloudflare:workers`
- D1 behavior
- Web Crypto / Worker runtime APIs
- compatibility flags such as `nodejs_compat`
- deployed Worker route behavior via `SELF.fetch`

Node-only Vitest tests are still fine for pure logic, parsing, formatting, and Effect service units with fakes.

## Project pattern

`apps/admin-api/vitest.config.ts` uses the installed `@cloudflare/vitest-pool-workers` API:

- `cloudflareTest` imported from the package root.
- `readD1Migrations` imported from the package root.
- `wrangler: { configPath: "./wrangler.jsonc" }` to load the real Worker config.
- `miniflare.bindings` for test-only bindings such as `ADMIN_API_KEY` and migration data.

Tests use `SELF.fetch` for route behavior and `cloudflare:test` helpers where needed.

## Testing D1

- Prefer applying real migrations in integration tests so tests exercise production schema shape.
- Reset/wipe test data deliberately between tests; do not assume D1 is empty unless setup guarantees it.
- If testing concurrency guards or SQLite/D1 error mapping, assert exact failure modes so Cloudflare/runtime changes fail loudly.

## Version-sensitive APIs

Cloudflare's Vitest integration has changed over time. Before copying docs or examples, check installed package exports and existing project config. In this repo:

- Use `cloudflareTest(...)` as a Vite plugin.
- Do not assume older `defineWorkersConfig`, `defineWorkersProject`, or `/config` subpath examples are valid.
- Be aware test tooling may inject runtime flags; if production code needs `nodejs_compat`, it must be explicit in Wrangler config.

## Official docs

- Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/
- Write your first test: https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/
- Configuration: https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
- Workers testing best practices: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
