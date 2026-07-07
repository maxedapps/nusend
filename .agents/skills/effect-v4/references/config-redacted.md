# Config and Redacted Reference

## Table of contents
- [Config model](#config-model)
- [Project secret pattern](#project-secret-pattern)
- [Lazy config](#lazy-config)
- [Redacted values](#redacted-values)
- [Antipatterns](#antipatterns)
- [Official docs](#official-docs)

## Config model

- `Config<A>` describes how to load and decode configuration and is itself effectful.
- Default config providers read environment-style sources; Workers can provide config from `env` via a `ConfigProvider` layer.
- Use constructors/combinators such as `Config.string`, `Config.nonEmptyString`, `Config.number`, `Config.boolean`, `Config.duration`, `Config.url`, `Config.port`, `Config.literal`, `Config.all`, `Config.withDefault`, `Config.option`, and `Config.validate`.

## Project secret pattern

For required non-empty secrets, this repo uses:

```ts
import { Config, Redacted } from "effect"

export function redactedNonEmpty(name: string): Config.Config<Redacted.Redacted<string>> {
  return Config.nonEmptyString(name).pipe(Config.map(Redacted.make))
}
```

Why:

- `Config.redacted(name)` protects display but can accept an empty string.
- Empty secrets should fail as configuration errors, not become confusing auth failures later.
- Wrapping in `Redacted` immediately prevents accidental display through normal inspection/logging.

## Lazy config

Keep config reads lazy when methods may not be called:

- DB-only programs should not require Teachable API keys.
- `--validate-only` / `--dry-run` CLI paths should not require upload/API credentials unless they actually upload/call the API.
- A service can accept an `Effect` that reads config and run it inside only the methods that need it.
- Memoize successful secret reads if useful, but do not cache failures unless that is intentionally desired.

## Redacted values

- `Redacted` is for sensitive data such as API keys, OAuth secrets, bearer tokens, and webhook secrets.
- Use `Redacted.value(...)` only at the exact external API boundary that requires a raw string.
- Do not log unwrapped secrets.
- Do not attach unwrapped secrets to thrown errors, typed error causes, or debug objects.

## Antipatterns

- Reading every env var at module import or layer construction even when most commands do not need them.
- Using plain `process.env.X!` throughout code.
- Using `Config.redacted` alone for values that must be non-empty.
- Logging entire `env`, request headers, config objects, or redacted values after unwrapping.
- Storing secrets in `.acadadmin/config.json`, Wrangler `vars`, committed `.env`, or source constants.

## Official docs

- Configuration: https://effect.website/docs/configuration/
- Config API: https://effect-ts.github.io/effect/effect/Config.ts.html
- ConfigProvider API: https://effect-ts.github.io/effect/effect/ConfigProvider.ts.html
- Redacted docs: https://effect.website/docs/data-types/redacted/
- Redacted API: https://effect-ts.github.io/effect/effect/Redacted.ts.html
