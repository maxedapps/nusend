# SES readiness

`GET /api/operations/ses/readiness` returns ordered checks with `ok`, `warning`, `error`, or `skipped` status. It is designed to work even when SES setup is incomplete.

Useful options:

- `?refresh=1` is accepted for future cache implementations; current checks run live, so it is a no-op.
- `?includeAws=false` runs local config/schema checks and skips AWS calls.

The response intentionally reports missing credentials, missing IAM permissions, invalid optional config, missing configuration sets, missing SNS subscriptions, and absent feedback as actionable checks instead of internal errors.

Important check families include:

- local config/schema: AWS region, public base URL, configuration sets, worker lease budget, tracking options, migrated SES operations tables
- SES account: credentials/access, production access, sending enabled, enforcement status, account-level suppression recommendation
- SES identity: exact sender identity or domain fallback, plus separate DKIM readiness
- SES configuration sets: existence, event destinations, and marketing tracking custom redirect domain when configured
- SNS: topic readability, SignatureVersion 2 recommendation, and confirmed HTTPS webhook subscription
- operations: latest received SES notification
