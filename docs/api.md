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

Device starts can return HTTP `429` with error code `rate_limited`. Token polling returns terminal `invalid_grant` for an unknown device code, while known consumed/expired codes return `expired_token`.

API-key rotation keeps the original name. It preserves future and null expiry; a past or malformed stored expiry becomes approximately 365 days from rotation.

## Mailings reads

- `GET /api/mailings?limit=&offset=` requires `mailings:read`.
- `GET /api/mailings/:id` requires `mailings:read`.
- `POST /api/mailings` requires `mailings:write`.

List items include mailing metadata and delivery counts for `queued`, `sending`, `sent`, `failed`, and `suppressed`. Lists omit `html` and `text`. Detail includes `subject`, `html`, and `text`. Neither response exposes per-recipient `vars_json`.

## Pagination

Paginated responses use one shape:

```json
{
  "pagination": { "limit": 50, "offset": 0, "nextOffset": null }
}
```

The default limit is 50 and the maximum is 100. `nextOffset` is null on the final page, including when that page is exactly full.

Corrupt stored data (for example an API-key row whose stored permissions no longer parse) surfaces as `500` with error code `internal_error`, not as a validation error.

Other domain families remain under `/api/contacts`, `/api/lists`, `/api/operations`, `/api/operations/ses`, `/api/suppressions`, and public unsubscribe/webhook routes.

Public contracts live in `packages/api-contract`; service-only DB/read-model details stay in `apps/service/src/*`.
