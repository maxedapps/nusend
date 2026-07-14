# Auth and API Keys

Nusend uses Better Auth for Google browser sessions only. Programmatic and CLI access use first-party Nusend API keys. Migration `0005` intentionally invalidates legacy Better Auth plugin API keys; recreate them through Nusend after upgrading.

## Owner bootstrap

```sh
pnpm --filter @nusend/service auth:bootstrap --email max@example.com --name "Max"
```

## API-key hashing

Set `NUSEND_API_KEY_HASH_SECRET` to a stable secret of at least 32 characters. Raw API keys are never stored; the service stores an HMAC-SHA-256 hash plus a safe preview. Changing this secret invalidates existing keys.

## Permissions

Initial permissions are defined in `@nusend/api-contract`:

- `contacts:read/write`
- `lists:read/write`
- `suppressions:read/write`
- `mailings:read/write`
- `operations:read`
- `api_keys:read/write`

Sessions are owner-level. API-key principals can only create, rotate, or revoke keys whose permissions are a subset of their own. List endpoints use `{ limit, offset, nextOffset }` pagination with a maximum limit of 100.

Rotating a key keeps its original name and permissions. Future expiry is preserved, null remains non-expiring, and a past or malformed stored expiry is refreshed to approximately 365 days. Successful authentication updates `last_used_at` at most once per 60 seconds.

## Device login

`nusend login <base-url>` starts a device-code authorization. The browser activation page shows the instance URL, client name, requested permissions, expiry, and warning copy. Approval creates the raw API key only when the CLI successfully consumes the token.

Durable outstanding grants satisfy exactly:

```sql
expires_at > now AND denied_at IS NULL AND consumed_at IS NULL
```

Approved-but-unconsumed grants therefore still count. Denied, consumed, and expired rows do not. Starts allow at most 30 outstanding grants globally and 5 per requester fingerprint.

Route ceilings are process-local and reset on restart:

- start: 10 requests/15 minutes/source, 60/15 minutes globally, at most 128 active source keys;
- token: 120 requests/minute/source, 600/minute globally, at most 1024 active source keys.

Each service process has independent limiter state; durable outstanding-grant limits remain database-backed. Capacity or rate rejection returns `429 rate_limited` with `Retry-After`. Activation-code lookup attempts are separately limited to 10 failures per signed-in user over 15 minutes in process memory.

Polling sooner than the five-second protocol interval returns `slow_down` with ten seconds without changing `poll_count` or `last_poll_at`; an approved grant is still delivered immediately. Polling an unknown device code returns `invalid_grant`. Known consumed or expired authorizations return `expired_token`.
