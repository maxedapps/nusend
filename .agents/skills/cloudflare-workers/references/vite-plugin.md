# Cloudflare Vite Plugin Reference

## Table of contents
- [When it matters](#when-it-matters)
- [Project pattern](#project-pattern)
- [Configuration behavior](#configuration-behavior)
- [Common pitfalls](#common-pitfalls)
- [Official docs](#official-docs)

## When it matters

Load this reference when changing Vite dev/build behavior, Worker SSR entrypoints, static assets handling, Cloudflare bindings in Vite, or `apps/web/vite.config.ts`.

## Project pattern

`apps/web/vite.config.ts` uses:

- `cloudflare({ viteEnvironment: { name: "ssr" }, persistState: { path: "../../.wrangler-persist" } })`
- `tanstackStart()`
- `react()`

The explicit `persistState` path is important: local web dev must read the same D1 state that `packages/db` migration scripts write.

## Configuration behavior

- The Cloudflare Vite plugin runs Worker code in `workerd`, which catches Worker-runtime differences earlier than Node-only dev.
- The plugin resolves Worker config from `configPath`, `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`, or a Wrangler config file in the app root.
- Programmatic plugin config can override loaded Wrangler config.
- The plugin has its own handling for Vite environment names, persistence, remote bindings, inspector port, tunnels, and auxiliary Workers.
- Some Wrangler options are not applicable or are superseded by Vite behavior. Check plugin docs before moving build/rules/assets/minify settings between Wrangler and Vite.

## Common pitfalls

- Accidentally using a different local D1 persistence path than `packages/db`.
- Assuming `wrangler dev` and `vite dev` have identical behavior for every config option.
- Forgetting that Vite/framework output may create generated Cloudflare config for deployment.
- Treating remote bindings as harmless in local dev. Verify whether a binding is local, remote, or mocked before running mutating code.
- Copying framework examples without checking TanStack Start + Cloudflare plugin compatibility and current package versions.

## Official docs

- Cloudflare Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/
- Plugin API: https://developers.cloudflare.com/workers/vite-plugin/reference/api/
- Cloudflare environments with Vite: https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/
- Programmatic configuration: https://developers.cloudflare.com/workers/vite-plugin/reference/programmatic-configuration/
- Wrangler vs Vite: https://developers.cloudflare.com/workers/local-development/wrangler-vs-vite/
- TanStack Start guide: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/
