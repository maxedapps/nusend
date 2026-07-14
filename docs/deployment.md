# Deployment

Deploy the service and worker as separate long-running processes against the same migrated SQLite database.

Minimum required service env:

- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NUSEND_API_KEY_HASH_SECRET`

`NUSEND_DB_PATH` is optional and defaults to `.data/nusend.sqlite`.

Migration `0005_first_party_api_keys_and_device_auth` replaces the legacy Better Auth API-key table. Existing plugin keys are invalidated and must be recreated through Nusend; preserve browser sessions, but do not expect legacy API-key rollback/data recovery.

## Migration 0009 compatibility order

Migration `0009_delivery_ambiguity_and_suppression_safety` adds first-class delivery ambiguity and rebuilds the dependent delivery/job/attempt/SES graph. It is not rolling-safe:

1. Stop every old API and send-worker process.
2. Apply UP with `pnpm --filter @nusend/service db:migrate`.
3. Start matching service and worker binaries, then distribute the matching CLI.

The matching CLI decodes an older service response without `counts.ambiguous` as zero, but that wire compatibility does not make the database migration rolling-safe. Before DOWN, stop API/worker processes again, run the confirmed destructive rollback, and then use binaries matching the downgraded schema. DOWN maps delivery/simulator `ambiguous` to `failed`, preserves child/history rows, and is semantically lossy.

Normal startup after migration:

```sh
pnpm --filter @nusend/service start
pnpm --filter @nusend/service worker:send
```

## Selected runtime notes

Auth URL/trusted-origin HTTPS validation runs only when `NODE_ENV=production`. That conditional check is not a secure transport default: safe reverse-proxy/TLS defaults remain deployment work. Device throttling assumes one trusted reverse proxy appends the client address as the final `X-Forwarded-For` hop; block direct service access and overwrite untrusted forwarding headers. Token ceilings are process-local (120/minute/source, 600/minute globally, 1024 active source keys), so each service process enforces an independent ceiling.

CLI config/credential mutations use one local-filesystem cross-process lock with a five-second acquisition bound and conservative dead-owner recovery. Network-mounted config directories are unsupported; lock publication fails rather than falling back to unsafe behavior.

Deploy Nusend at a domain root or dedicated subdomain. Sub-path deployments are unsupported. Keep `NUSEND_API_KEY_HASH_SECRET` stable; changing it invalidates existing API keys.

This document does not provide the still-required production supervisor/proxy, backup/restore, disaster-recovery, retention/capacity, or secure-default deployment design.
