# Errors, Result, Cause, and Exit Reference

## Table of contents
- [Typed errors](#typed-errors)
- [Catching and mapping failures](#catching-and-mapping-failures)
- [Result](#result)
- [Exit and Cause](#exit-and-cause)
- [Project patterns](#project-patterns)
- [Official docs](#official-docs)

## Typed errors

- Expected failures belong in the Effect error channel, not thrown exceptions.
- Use tagged domain errors so callers can handle by `_tag` with `Effect.catchTag`, `Effect.catchTags`, or switch statements.
- Include enough non-sensitive metadata for debugging: operation, endpoint/phase, status code, path, validation details.
- Never include secrets or raw PII-bearing payloads in error messages or causes that may be logged.

## Catching and mapping failures

Common operators:

- `Effect.catch` for all expected failures.
- `Effect.catchTag` / `Effect.catchTags` for tagged typed failures.
- `Effect.catchCause` for full cause-level handling/logging.
- `Effect.mapError` / `Effect.mapBoth` for converting lower-level errors to domain errors.
- `Effect.tryPromise({ try, catch })` for promise APIs and typed catch mapping.

Avoid broad JavaScript `try/catch` around Effect programs unless you are at a non-Effect boundary.

## Result

Use `Result` for values that have already succeeded or failed and should be inspected as plain data:

- CLI argument parsing.
- Schema decoding APIs that return data rather than Effects.
- Pure validation helpers.

Common APIs in `effect@4` include `Result.succeed`, `Result.fail`, `Result.isSuccess`, `Result.isFailure`, `Result.match`, `Result.all`, and `Result.gen`.

Do not use `Result` as a replacement for Effect when work is asynchronous, effectful, or service-dependent.

## Exit and Cause

Use `Exit` when running a program and you need the full outcome without throwing/rejecting:

- CLI exit-code mapping.
- Tests that assert success/failure/cause.
- Boundary-level diagnostics.

Use `Cause` for complete failure diagnostics, including expected failures, defects, and interruption. In Effect v4, inspect Cause through current APIs/predicates rather than matching old recursive v3 tree tags.

For user-facing errors, prefer extracting typed expected failures and formatting them safely. Use pretty cause output for unexpected defects only when it will not leak sensitive data.

## Project patterns

- `apps/admin-api/src/effect/runtime.ts` maps typed handler errors to HTTP responses and avoids leaking DB internals to clients.
- `apps/admin-cli/src/index.ts` runs commands with `runtime.runPromiseExit`, extracts typed `CliError`, formats user-facing messages, and prints `Cause.pretty` only for unexpected defects.
- Teachable/API clients map network, timeout, JSON, HTTP, and schema phases into typed errors.

## Official docs

- Expected errors: https://effect.website/docs/error-management/expected-errors/
- Unexpected errors: https://effect.website/docs/error-management/unexpected-errors/
- Error channel operations: https://effect.website/docs/error-management/error-channel-operations/
- Cause docs: https://effect.website/docs/data-types/cause/
- Cause API: https://effect-ts.github.io/effect/effect/Cause.ts.html
- Exit API: https://effect-ts.github.io/effect/effect/Exit.ts.html
- Result source/API in installed package: `node_modules/.pnpm/effect@*/node_modules/effect/src/Result.ts`
