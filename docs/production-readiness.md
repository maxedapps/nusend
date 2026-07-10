# Production readiness

Before production sending:

1. `GET /api/operations/ses/readiness` has no required errors.
2. SNS subscription has a DLQ and alarms.
3. SES account-level suppression is enabled for bounce and complaint as defense in depth.
4. Server-local simulator `bounce` and `complaint` end-to-end scenarios create local suppressions.
5. Gmail "Show original" confirms DKIM covers `List-Unsubscribe` and `List-Unsubscribe-Post` for marketing messages.
6. Operations endpoints show recent worker runs and SES notifications/events.
7. Delivery rows are retained long enough for unsubscribe links to resolve honestly.
8. `nusend login <base-url>` completes through browser approval, and `nusend whoami` identifies the expected owner/key.
9. A least-privilege key can be created with `nusend api-keys create`, used only on its permitted routes, and revoked with `nusend api-keys revoke`.
10. A revoked or expired key receives `401 unauthenticated`.
