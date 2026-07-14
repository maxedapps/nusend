# Operations

Operational HTTP routes are for inspection, not remote mutation. CLI wrappers are planned for a follow-up.

Useful service routes:

- `GET /health`
- `GET /health/db`
- `GET /api/operations/summary`
- `GET /api/operations/deliveries`
- `GET /api/operations/deliveries/:id`
- `GET /api/operations/ses/readiness`
- `GET /api/operations/ses/events`
- `GET /api/operations/ses/simulator-runs`

`ambiguous` is an explicit terminal delivery outcome: provider acceptance is unknown, automatic retry is forbidden, and the mailing may still be `completed`. Summary/recent-issue views include ambiguous deliveries even when no error string exists. Use `GET /api/operations/deliveries?issue=failed_or_ambiguous` and delivery detail to inspect the delivery, job, and exact attempt. A late exact-attempt MessageId may make the delivery sent while its dead job remains dead as incident history. No reconciliation/retry API exists.

Use least-privilege API keys, typically `operations:read`. Do not log raw API keys, device/user codes, cookies, unsubscribe tokens, recipient vars, mailing HTML, or raw SES/SNS payloads.
