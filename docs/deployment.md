# Deployment

Deploy the service and worker as separate long-running processes against the same migrated SQLite database.

Minimum required service env:

- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NUSEND_API_KEY_HASH_SECRET`

`NUSEND_DB_PATH` is optional and defaults to `.data/nusend.sqlite`.

Migration `0005_first_party_api_keys_and_device_auth` intentionally replaces the legacy Better Auth API-key table. Existing Better Auth plugin keys are invalidated and must be recreated through the Nusend CLI or first-party API; preserve browser sessions, but do not expect legacy API-key rollback/data recovery.

Run migrations before startup:

```sh
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service start
pnpm --filter @nusend/service worker:send
```

Use HTTPS in production for auth URLs, trusted origins, final email assets, and reverse proxy termination. Device-login throttling assumes exactly one trusted reverse proxy appends the client address as the final `X-Forwarded-For` hop. Block direct access to the service and strip untrusted forwarding headers at the proxy; otherwise clients can forge fingerprints and evade the per-source limit. The proxy must also set or overwrite `x-forwarded-proto`: on a misdeployed, directly exposed plain-HTTP instance a client could spoof it, which marks the CLI activation CSRF cookie `Secure` and breaks activation (an availability-only impact).

Deploy Nusend at a domain root or dedicated subdomain. Sub-path deployments (for example `https://host/nusend`) are unsupported: the server derives CLI verification URLs from the request origin, and the CLI rejects path-carrying base URLs.

Back up the SQLite database and keep `NUSEND_API_KEY_HASH_SECRET` stable; changing it invalidates existing API keys until explicit key-hash secret rotation exists.
