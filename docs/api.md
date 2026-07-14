# API

All protected API routes accept either a Better Auth browser session or `x-api-key`.

## Auth and API keys

- `GET /api/me`
- `GET /api/api-keys?limit=&offset=`
- `POST /api/api-keys`
- `DELETE /api/api-keys/:id`
- `POST /api/api-keys/:id/rotate`
- `POST /api/device-authorizations`
- `POST /api/device-authorizations/token`
- `GET|POST /cli/activate`

Device start and token routes can return HTTP `429` with error code `rate_limited` and an integer `Retry-After` header of at least one second. Token polling is process-locally limited to 120 requests/minute per source and 600/minute globally, with at most 1024 active source keys per process; rejected requests do not mutate the authorization row. Polling an unknown device code returns terminal `invalid_grant`, while known consumed/expired codes return `expired_token`.

API-key rotation keeps the original name. It preserves future and null expiry; a past or malformed stored expiry becomes approximately 365 days from rotation.

## Mailings

- `GET /api/mailings?limit=&offset=` requires `mailings:read`.
- `GET /api/mailings/:id` requires `mailings:read`.
- `POST /api/mailings` requires `mailings:write`.

List/detail responses include delivery counts for `queued`, `sending`, `sent`, `failed`, `suppressed`, and `ambiguous`. `counts.ambiguous` is required in the decoded contract and emitted by new services; the updated first-party CLI defaults an absent old-wire key to zero. Operations delivery status uses the same six literals and accepts `status=ambiguous`; `issue=failed_or_ambiguous` provides the combined issue view. `ambiguous` is terminal and means provider acceptance is unknown, not failed; only exact-attempt MessageId proof can later reconcile it to sent.

Lists omit `html` and `text`. Detail includes `subject`, `html`, and `text`. Neither response exposes per-recipient `vars_json`.

## Lists

`DELETE /api/lists/:id` returns `409 conflict` while a non-completed mailing references the list. Missing lists return `404`; lists referenced only by completed mailings can be deleted under the existing null-list behavior.

## Pagination

Paginated responses use one shape:

```json
{
  "pagination": { "limit": 50, "offset": 0, "nextOffset": null }
}
```

The default limit is 50 and the maximum is 100. `nextOffset` is null on the final page, including when that page is exactly full.

Corrupt stored data (for example an API-key row whose stored permissions no longer parse) surfaces as `500` with error code `internal_error`, not as a validation error.

Other domain families remain under `/api/contacts`, `/api/lists`, `/api/operations`, `/api/operations/ses`, `/api/suppressions`, and public unsubscribe/webhook routes. Public contracts live in `packages/api-contract`; service-only DB/read-model details stay in `apps/service/src/*`.
