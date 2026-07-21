# Production readiness

Nusend includes suppression/list safety, explicit send ambiguity, device/webhook controls, configured-only tracking readiness, and fail-closed CLI state. It is **not** ready for broad production marketing volume until the live application/SES gates below are complete.

Open release gates:

1. Live staging proof of `docker compose up -d --wait` on a clean host with Compose 5.3+, selected ingress mode, mandatory backup health, restore of an explicit snapshot id, and reboot recovery of API/worker/Caddy/backup.
2. Secure transport defaults beyond the current conditional auth URL/trusted-origin HTTPS validation when `NODE_ENV=production`.
3. Bounded SES notification/event retention, capacity planning, and disk monitoring.
4. Live AWS SES/SNS simulator feedback validation on the deployed instance.
5. Live Gmail "Show original" verification that DKIM covers `List-Unsubscribe` and `List-Unsubscribe-Post`.
6. Operational monitoring/alerting for worker freshness, dead/ambiguous deliveries, webhook retries, SNS DLQ messages, and failed/missing backups.

Before production sending, also verify:

- `GET /api/operations/ses/readiness` has no required errors. OPEN/CLICK are required only when configured for marketing tracking.
- SNS subscription has a DLQ and alarms.
- SES account-level suppression is enabled for bounce and complaint as defense in depth.
- Server-local simulator bounce/complaint scenarios create protected local suppressions.
- Operations endpoints expose recent worker runs, SES events, and explicit ambiguous outcomes.
- Delivery/SES data retention is long enough for unsubscribe links and bounded by an approved policy.
- `nusend login <base-url>` completes through browser approval; `nusend whoami` identifies the expected owner/key.
- A least-privilege key works only on permitted routes and becomes `401 unauthenticated` after revocation/expiry.

Repository validation is `pnpm check`, `pnpm build`, and the focused Compose/Caddy/backup smokes. Hosted release image publication runs from `.github/workflows/release-images.yml` on `v*` tags. Passing local checks is not evidence that live DNS/TLS/SES/R2 gates ran.
