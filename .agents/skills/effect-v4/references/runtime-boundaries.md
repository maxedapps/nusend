# Runtime Boundaries Reference

## Table of contents
- [Boundary rule](#boundary-rule)
- [Workers](#workers)
- [CLI](#cli)
- [Tests](#tests)
- [Runtime API choices](#runtime-api-choices)
- [Official docs](#official-docs)

## Boundary rule

Return Effects from domain/service code. Run Effects only at process/framework boundaries:

- Worker `fetch` / route / scheduled handler
- TanStack server route handler
- CLI `main()`
- test helper
- small script entrypoint

If you call `Effect.runPromise` deep inside a function, you collapse the typed requirements/error model and make testing harder.

## Workers

- Build a `ManagedRuntime` from live layers that receive Worker bindings (`env.DB`, vars, secrets provider, etc.).
- Cache runtimes deliberately:
  - Web can cache process-wide if it imports stable `env` from `cloudflare:workers`.
  - Admin API caches by `Env` object with `WeakMap` so tests/new Worker envs get separate runtimes.
- Scheduled/background handlers should run Effects and catch/log causes so `waitUntil` promises do not reject silently.

## CLI

- Build a live layer once in `main()`.
- Run the selected command with `runtime.runPromiseExit(...)` when exit-code mapping needs full `Exit`/`Cause` information.
- Always dispose `ManagedRuntime` in `finally` when created by a CLI or one-off script.
- Keep validation-only/dry-run paths lazy so they don't require upload/API credentials until a service method actually needs them.

## Tests

- Test helpers can use `Effect.runPromise(effect.pipe(Effect.provide(testLayer)))` for simple no-resource layers.
- If a test constructs a `ManagedRuntime`, dispose it.
- Prefer deterministic test layers for clocks, IDs, database fakes, and third-party clients.

## Runtime API choices

- `Effect.runPromise(effect)`: simple runnable effect with no remaining requirements.
- `Effect.runPromiseExit(effect)`: need success/failure `Exit` instead of promise rejection.
- `ManagedRuntime.make(layer)`: repeated runs with a service graph.
- `runtime.runPromise(program)`: boundary wants success or rejected typed failure.
- `runtime.runPromiseExit(program)`: boundary maps typed failures/defects to process responses.

## Official docs

- Running Effects: https://effect.website/docs/getting-started/running-effects/
- Runtime introduction: https://effect.website/docs/runtime/
- ManagedRuntime API: https://effect-ts.github.io/effect/effect/ManagedRuntime.ts.html
- Exit API: https://effect-ts.github.io/effect/effect/Exit.ts.html
- Cause API: https://effect-ts.github.io/effect/effect/Cause.ts.html
