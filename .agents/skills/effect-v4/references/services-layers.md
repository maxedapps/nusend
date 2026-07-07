# Services and Layers Reference

## Table of contents
- [Mental model](#mental-model)
- [Project service style](#project-service-style)
- [Live and test layers](#live-and-test-layers)
- [Layer composition](#layer-composition)
- [Antipatterns](#antipatterns)
- [Official docs](#official-docs)

## Mental model

- An Effect can require services in its requirements type: `Effect<A, E, R>`.
- `Context.Service` creates a key for a service implementation.
- `Layer` builds/provides services, including lifecycle-aware services.
- Services make dependencies explicit and replace hidden globals, hardcoded clients, and hardcoded platform APIs.

## Project service style

This repo commonly uses function-style service keys:

```ts
import { Context, Effect, Layer } from "effect"

type DatabaseService = {
  readonly first: <T>(operation: string, sql: string, values?: readonly unknown[]) => Effect.Effect<T | null, DatabaseError>
}

export const Database = Context.Service<DatabaseService>("academind/Database")

export const DatabaseLive = (d1: D1Database) =>
  Layer.succeed(Database, makeDatabaseService(d1))
```

Use unique, namespaced service keys such as `academind/Database` or `admin-api/Database`. The string key is runtime identity; unrelated services must not share it.

## Live and test layers

- Live layers wrap platform dependencies such as D1, fetch clients, filesystem, Bun APIs, R2/S3, clocks, and ID generation.
- Test layers provide deterministic fakes and should satisfy the same service interface.
- Prefer fake layers over monkeypatching `globalThis` unless the platform API itself is under test.
- Keep service interfaces small so tests can fake only what the program actually needs.

## Layer composition

- Compose app layers once near the boundary with `Layer.mergeAll` or related APIs.
- Provide layers at the outer boundary or test runner; avoid hiding `Effect.provide(...)` in low-level functions unless intentionally overriding a dependency.
- Use `Layer.succeed` for already-built objects and `Layer.effect` / `Layer.sync` when construction is effectful.
- Understand layer memoization: shared layers can be reused. Use local/fresh provisioning only when test/resource isolation requires a new instance.

## Antipatterns

Avoid v3 or non-project patterns unless deliberately migrating existing code:

- `Context.Tag` / `Effect.Tag` examples from older docs.
- Generated service accessor proxies instead of `yield* Service` or service-use APIs.
- `.Default` or hidden auto-layers that obscure dependencies.
- Fat service interfaces that combine unrelated capabilities.
- Constructing platform clients in business logic instead of in live layer factories.

## Official docs

- Managing services: https://effect.website/docs/requirements-management/services/
- Managing layers: https://effect.website/docs/requirements-management/layers/
- Layer memoization: https://effect.website/docs/requirements-management/layer-memoization/
- Default services: https://effect.website/docs/requirements-management/default-services/
- Context API: https://effect-ts.github.io/effect/effect/Context.ts.html
- Layer API: https://effect-ts.github.io/effect/effect/Layer.ts.html
