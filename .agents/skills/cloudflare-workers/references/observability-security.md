# Observability and Security Reference

## Table of contents
- [Logging policy](#logging-policy)
- [Invocation logs](#invocation-logs)
- [Secrets](#secrets)
- [Authentication and timing-safe checks](#authentication-and-timing-safe-checks)
- [Cron and background work](#cron-and-background-work)
- [Official docs](#official-docs)

## Logging policy

- Treat Worker logs as persisted account data.
- Never log raw API keys, bearer tokens, OAuth tokens, webhook secrets, cookies, auth headers, raw request bodies with user data, or third-party response bodies that may include PII.
- Prefer structured logs with:
  - stable operation/phase names
  - status codes
  - non-sensitive IDs
  - retry/backoff state
  - sanitized error categories
- For Effect code, use typed error metadata and `Effect.logError` carefully; do not attach secret-bearing causes or raw payloads.

## Invocation logs

Invocation logs can include request URLs. In this repo:

- `apps/web` disables invocation logs because the Teachable webhook secret is part of the URL path.
- `apps/admin-api` allows invocation logs because auth uses an `Authorization` header and not the URL.

When adding routes:

- Do not put secrets in URLs if a header/signature mechanism is available.
- If a third party only supports URL secrets, disable invocation logs or otherwise ensure they are not persisted.
- Consider sampling/cost/retention for high-volume routes.

## Secrets

- Use Worker secrets for sensitive runtime values.
- Use `vars` only for non-sensitive config.
- Local secret handling should follow app docs. For this repo's web app, Infisical supplies real secrets in dev.
- Do not commit real `.dev.vars`, `.env` with secrets, generated credentials, API tokens, or secret-bearing examples.
- `database_id` is not a secret, but placeholder IDs must be replaced consistently before remote D1 usage.

## Authentication and timing-safe checks

- Prefer header-based authentication for APIs. Avoid URL path/query secrets unless forced by an integration.
- For secret comparisons, use constant/timing-safe comparisons where available and normalize length concerns.
- In Workers, Web Crypto is available; project code may use workerd-specific helpers such as `crypto.subtle.timingSafeEqual` where supported.
- Test malformed auth and missing auth paths in Worker-runtime tests.

## Cron and background work

- Cron schedules are UTC.
- Keep cron triggers in Wrangler config so deploys are reproducible.
- Use `scheduled(controller, env, ctx)` for scheduled handlers.
- Use `ctx.waitUntil()` / imported `waitUntil` for response-independent background tasks.
- Background work must be idempotent and safe to retry; Cloudflare can retry events and users can trigger duplicate webhooks.

## Official docs

- Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Real-time logs: https://developers.cloudflare.com/workers/observability/logs/real-time-logs/
- Logpush: https://developers.cloudflare.com/workers/observability/logs/logpush/
- Traces: https://developers.cloudflare.com/workers/observability/traces/
- Secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Context / `waitUntil`: https://developers.cloudflare.com/workers/runtime-apis/context/
- Scheduled handler: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Cron triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
