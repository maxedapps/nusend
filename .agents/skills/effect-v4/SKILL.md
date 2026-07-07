---
name: effect-v4
description: >
  Use this skill when writing, changing, reviewing, or debugging TypeScript code that uses Effect v4 APIs: Effect, Context.Service, Layer, ManagedRuntime, Result, Schema, Config, Redacted, Data errors, Cause, Exit, Schedule, Clock, TestClock, dependency injection, typed error channels, retries, timeouts, service layers, runtime boundaries, or Effect-based tests. Use it for this project's web Worker, admin API, and admin CLI Effect patterns. Do not use for unrelated promise-only TypeScript unless the task should introduce or preserve Effect-based architecture.
metadata:
  short-description: Effect v4 services, layers, runtime boundaries, schema, config, errors, retries, and tests
---

# Effect v4

## Goal

Help agents write idiomatic Effect v4 code that fits this repo: typed errors, explicit dependencies, services/layers, schema-validated boundaries, lazy config, safe secrets, and runtime execution only at app edges.

## First steps

1. Check the package's installed `effect` version before copying examples.
2. Inspect nearby code for existing service/layer/runtime style before adding new patterns.
3. Prefer official Effect v4 docs, installed typings/source, and existing project code over older v3 snippets.
4. Keep Effect code testable by pushing I/O to services and app/CLI/Worker boundaries.

## Load deeper references when needed

- Read [Services and layers](references/services-layers.md) before adding or changing dependencies, `Context.Service`, `Layer`, fake/live services, or service composition.
- Read [Runtime boundaries](references/runtime-boundaries.md) before using `Effect.run*`, `ManagedRuntime`, Worker handlers, CLI entrypoints, or runtime caching/disposal.
- Read [Schema](references/schema.md) before validating request bodies, API responses, config files, external JSON, or defining schema classes/errors.
- Read [Config and Redacted](references/config-redacted.md) before reading env vars/secrets or handling sensitive values.
- Read [Errors, Result, Cause, Exit](references/errors-result-cause-exit.md) before adding typed errors, catching failures, CLI exit handling, diagnostics, or result-returning APIs.
- Read [Retry, Schedule, and TestClock](references/retry-schedule-testclock.md) before implementing retry/backoff, timeouts, repeating work, clocks, or time-based tests.
- Read [Project patterns](references/project-patterns.md) for exact local Nusend conventions, Worker boundaries, queue/dispatcher patterns, services to introduce, and migration commands.

## Core rules

### Effect workflow

- Model business logic as `Effect.Effect<Success, TypedError, Requirements>` instead of throwing, returning nullable error states, or mixing hidden globals.
- Use `Effect.gen(function* () { ... })` and `yield*` for multi-step workflows.
- Keep expected failures in the error channel with typed `Data.TaggedError`-style errors.
- Wrap external promises with `Effect.tryPromise` and map unknown failures into typed domain errors.
- Wrap synchronous side effects with `Effect.sync`; do not run side effects while building an Effect.

### Services and layers

- Use `Context.Service` for dependency keys. Do not copy v3 examples based on `Context.Tag`, `Effect.Tag`, generated accessor proxies, or `.Default` layers.
- Keep service interfaces small and capability-focused.
- Provide live implementations through `Layer.succeed`, `Layer.effect`, `Layer.sync`, or composed layers.
- Use fake/test layers for unit tests instead of monkeypatching globals.
- Provide layers at the boundary, not inside low-level functions, unless there is a specific local override.

### Runtime boundaries

- `Effect.runPromise` is fine for one-off no-requirement effects at the outer edge.
- Use `ManagedRuntime.make(layer)` for reusable app/Worker/CLI runtimes that provide services.
- Cache Worker runtimes deliberately; use per-env caching when bindings differ by env/test.
- Dispose manually created runtimes in CLIs/tests when lifecycle resources may exist.
- Do not call run methods deep inside service/domain code; return Effects and let the boundary run them.

### Schema and boundary validation

- Use `Schema` at trust boundaries: HTTP request bodies, third-party responses, config files, CLI/user input, serialized data.
- Prefer `Schema.decodeUnknownEffect` inside Effect workflows when parse failures should remain typed and composable.
- Use `Schema.decodeUnknownResult(..., { errors: "all" })` when code wants a pure success/failure value for request validation.
- Do not trust `response.json()` or request JSON shape without schema validation when data crosses a boundary.

### Config and secrets

- Keep config reads lazy when unrelated commands/programs should not require unrelated secrets.
- Use `ConfigProvider` layers to supply platform-specific config (`env` in Workers, process env in CLIs/tests).
- Use `Redacted` for sensitive values. Unwrap with `Redacted.value` only at the external API boundary that needs the raw string.
- For required secrets, reject empty strings explicitly. In this repo use the `redactedNonEmpty` pattern.

### Errors, retries, and time

- Use `Effect.catch`, `Effect.catchTag`, `Effect.catchTags`, `Effect.catchCause`, and typed error mapping rather than blanket `try/catch` around Effect programs.
- Use `Result` for already-computed success/failure data and parser-style APIs.
- Use `Exit`/`Cause` at runtime boundaries when you need complete success/failure/defect diagnostics.
- Use `Effect.retry` with `Schedule` for retries; avoid ad-hoc retry loops.
- Use `Effect.timeout` for bounded external calls and catch timeout causes explicitly where user-facing errors matter.
- Use `Clock` and `TestClock` for deterministic time-sensitive code/tests.

## Antipatterns to avoid

- Copying old v3 service examples (`Context.Tag`, `Effect.Tag`, accessor proxies, auto `.Default` layers) into v4 code.
- Calling `Effect.runPromise` inside reusable functions/services instead of returning an Effect.
- Eagerly reading all env/secrets at layer construction when only one method needs a secret.
- Logging `Redacted.value(...)`, raw causes with secret-bearing payloads, or third-party response bodies with PII.
- Throwing exceptions for expected domain failures.
- Using `any`/casts to silence Effect requirement or error-channel issues before understanding the missing layer/error mapping.
- Implementing manual retry/sleep loops instead of `Schedule` and `Effect.retry`.
- Testing timeouts/backoff with real sleeps instead of `TestClock` where possible.

## Validation checklist

Before finishing Effect-related changes, check the relevant subset:

- [ ] Effects expose expected success, error, and requirement types.
- [ ] Required services are provided once at a boundary or in tests.
- [ ] External promises/sync side effects are wrapped and mapped to typed errors.
- [ ] Boundary data is schema-decoded before use.
- [ ] Secrets remain redacted except at the exact external call boundary.
- [ ] Runtime creation/caching/disposal matches the host: Worker, CLI, or test.
- [ ] Time/retry behavior is bounded and testable.
- [ ] Existing project patterns were preserved unless intentionally changed.
