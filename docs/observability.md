# Observability

Nusend exposes operational state through authenticated JSON endpoints:

- `GET /api/operations/summary`
- `GET /api/operations/deliveries`
- `GET /api/operations/deliveries/:id`
- `GET /api/operations/ses/summary`
- `GET /api/operations/ses/events`
- `GET /api/operations/ses/readiness`
- `GET /api/operations/ses/simulator-runs`

Use an owner session or a least-privilege API key with `operations:read`.

Delivery/attempt `ambiguous` is operator-visible and terminal, not folded into `failed`. It appears in mailing counts, operations summary/recent issues, delivery filters/details, and simulator results. Use `issue=failed_or_ambiguous` for the combined operational view, then distinguish known failure from provider-unknown state in detail. A dead job can coexist with a later reconciled sent delivery because queue history is retained.

Worker cycles are persisted to `worker_runs` with claimed/succeeded/failed/dead counters. To bound that table, every `once` run and every non-idle `loop` run is stored, repeated idle loop runs are skipped between periodic heartbeat rows, and old worker-run rows are pruned after the configured window. This does not provide a general SES-event retention/capacity policy.

Structured JSON logs cover request completion, SES SNS verification/notification/event processing, suppression recording, readiness, simulator lifecycle, and worker cycles. Internal failures use fixed safe categories. Logs must not include API keys, auth tokens, cookies, unsubscribe tokens, secrets, raw SNS JSON, email bodies, recipient vars, or full diagnostic payloads.

Production container logs:

```sh
docker compose logs --since 30m --timestamps api worker caddy backup
docker compose ps
```

Do not log or paste raw API keys, device/user codes, cookies, unsubscribe tokens, recipient vars, mailing HTML, OAuth query data, R2/restic secrets, or raw SES/SNS payloads.
