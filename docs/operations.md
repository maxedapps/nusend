# Operations

Operational HTTP routes are designed for inspection, not risky remote control. CLI wrappers are planned for a follow-up.

Useful service routes:

- `GET /health`
- `GET /health/db`
- `GET /api/operations/summary`
- `GET /api/operations/deliveries`
- `GET /api/operations/deliveries/:id`
- `GET /api/operations/ses/readiness`
- `GET /api/operations/ses/events`
- `GET /api/operations/ses/simulator-runs`

Use API keys with least privilege, typically `operations:read` for inspection. Do not log raw API keys, device codes, user codes, cookies, unsubscribe tokens, recipient vars, mailing HTML, or raw SES/SNS payloads.
