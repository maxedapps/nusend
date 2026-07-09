# Observability

Nusend exposes operational state through authenticated JSON endpoints:

- `GET /api/operations/summary`
- `GET /api/operations/deliveries`
- `GET /api/operations/ses/summary`
- `GET /api/operations/ses/events`
- `GET /api/operations/ses/simulator-runs`

Worker cycles are persisted to `worker_runs` with claimed/succeeded/failed/dead counters. To bound storage, every `once` run and every non-idle `loop` run is stored, repeated idle loop runs are skipped between periodic heartbeat rows, and old worker-run rows are pruned after the retention window.

Structured JSON logs are emitted for request completion, SES SNS verification/notification/event processing, suppression recording, readiness completion, simulator lifecycle, and worker cycles. Logs must not include API keys, auth tokens, cookies, unsubscribe tokens, secrets, raw SNS JSON, email bodies, recipient vars, or full diagnostic payloads.
