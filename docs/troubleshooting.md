# Troubleshooting

## Auth config fails

Ensure all required Better Auth variables are set together and `NUSEND_API_KEY_HASH_SECRET` is at least 32 characters.

## API key rejected

- `401 unauthenticated`: the key is invalid, revoked, expired, or hashed with a different `NUSEND_API_KEY_HASH_SECRET`.
- `403 forbidden`: the key is valid but lacks the route permission.

## CLI credential file rejected

On Unix, Nusend refuses broad credential-directory/file permissions. Run `nusend config repair-permissions` (directory `0700`; config/credentials `0600`).

## CLI local state is busy

A config/credential mutation waits up to five seconds for the shared lock, then fails without modifying files. Let the other CLI process finish and retry. Nusend automatically reaps only a proven dead same-host owner after its publication grace period; it never steals live, foreign-host, malformed, too-young, or permission-indeterminate owners.

If the error requests operator inspection for a reaper mutex, lock release, or tombstone, stop every Nusend CLI process using that config directory first. Inspect the lock/reaper/tombstone metadata and filesystem support before removing anything; do not blindly delete an unfamiliar owner. Network-mounted config directories are unsupported. `EPERM`/`ENOTSUP` during publication indicates the filesystem cannot provide the required safe local locking semantics.

## Device login stuck

Check the activation URL, expiry, approval status, and `429 Retry-After` responses. The CLI obeys server pacing with a 1000 ms minimum and sends no token request at or after local expiry. Early server polls return `slow_down` without consuming durable poll state.

Outstanding grants are unexpired, non-denied, and non-consumed; approved-but-unconsumed grants still count toward the durable 30-global/5-per-fingerprint limits. Process-local token ceilings are 120 requests/minute per source and 600/minute globally with at most 1024 active source keys per process. Start and token limiter state resets on service restart and is independent per service process.

## Ambiguous delivery

`ambiguous` means SES acceptance is unknown and automatic processing is finished; it is not a known failure and must not be retried automatically. Inspect the delivery and exact attempt through operations endpoints. Only authoritative SES MessageId proof for that same latest attempt can reconcile it to sent; there is no operator reconciliation API yet.

## SES issues

Use SES readiness and operations HTTP routes to inspect configuration-set, SNS, delivery, bounce, complaint, and ambiguity state. CLI wrappers are planned for a follow-up.
