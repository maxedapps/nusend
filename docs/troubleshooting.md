# Troubleshooting

## Auth config fails

Ensure all required Better Auth variables are set together and `NUSEND_API_KEY_HASH_SECRET` is at least 32 characters.

## API key rejected

- `401` with error code `unauthenticated`: the key is invalid, revoked, expired, or hashed with a different `NUSEND_API_KEY_HASH_SECRET`.
- `403` with error code `forbidden`: the key is valid but lacks the permission the route requires.

## CLI credential file rejected

On Unix, Nusend refuses broad permissions on the credential directory or file. Run `nusend config repair-permissions` (equivalent to mode `0700` for the directory and `0600` for config/credentials files).

## Device login stuck

Check the activation page URL, expiry, approval status, and whether the CLI is polling too quickly. `slow_down` responses increase the polling interval. The public start endpoint allows at most 30 non-expired authorizations globally and 5 per requester fingerprint; a sustained flood can delay login for up to the 10-minute authorization TTL. Existing/pre-created API keys remain usable.

## SES issues

Use SES readiness and operations HTTP routes to inspect configuration-set, SNS, delivery, bounce, and complaint state. CLI wrappers are planned for a follow-up.
