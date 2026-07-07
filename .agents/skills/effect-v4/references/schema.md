# Schema Reference

## Table of contents
- [When to use Schema](#when-to-use-schema)
- [Decode API choices](#decode-api-choices)
- [Project patterns](#project-patterns)
- [Schema design guidance](#schema-design-guidance)
- [Antipatterns](#antipatterns)
- [Official docs](#official-docs)

## When to use Schema

Use `Schema` at boundaries where unknown data enters or leaves trusted code:

- HTTP request bodies
- third-party API responses
- admin API responses consumed by CLI
- `.acadadmin/config.json`
- manifests and content metadata
- serialized webhook payloads

Do not treat `request.json()` or `response.json()` as typed without validation.

## Decode API choices

- `Schema.decodeUnknownEffect(schema)(value)`: best inside Effect workflows; parse failures stay typed/composable in the error channel.
- `Schema.decodeUnknownResult(schema, options)(value)`: returns `Result` data; useful when you want pure success/failure branching, as in request body validation.
- `Schema.decodeUnknownSync(schema)(value)`: throws on mismatch; avoid in app paths where typed errors matter.
- Use `{ errors: "all" }` for user/API-facing validation when multiple field issues should be reported together.

## Project patterns

- Admin API request validation uses `Schema.decodeUnknownResult(schema, { errors: "all" })`, then maps failure messages to `ValidationFailedError`.
- Web Teachable client uses `Schema.decodeUnknownEffect` after successful HTTP + JSON parsing.
- CLI validates config and API payloads with Schema before use.

## Schema design guidance

- Keep schemas close to the boundary contracts they validate.
- Model exact external shapes first; transform to richer domain types after validation when needed.
- Use tagged error/request/schema classes when they clarify domain contracts.
- Use branded/refined schemas for IDs and normalized strings when the invariant matters beyond one function.
- When defaults matter, distinguish constructor defaults from decoding defaults. Decode-time defaults change what external input is accepted.

## Antipatterns

- Casting parsed JSON to a TypeScript type without schema validation.
- Using sync decoders in code that should report typed validation errors.
- Silencing schema errors with `as any` instead of formatting and mapping them.
- Reusing one loose schema for different boundary contracts just because fields overlap.
- Adding broad optional fields when the external API actually guarantees or requires stricter shape.

## Official docs

- Schema introduction: https://effect.website/docs/schema/introduction/
- Schema getting started: https://effect.website/docs/schema/getting-started/
- Transformations: https://effect.website/docs/schema/transformations/
- Effect data types schemas: https://effect.website/docs/schema/effect-data-types/
- Schema API: https://effect-ts.github.io/effect/effect/Schema.ts.html
- Schema issue API: https://effect-ts.github.io/effect/effect/SchemaIssue.ts.html
