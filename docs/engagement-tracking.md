# Engagement tracking

If SES configuration sets publish `OPEN` and `CLICK` events, Nusend stores them in `ses_events` and exposes sanitized operations views.

Caveats:

- Open tracking uses a 1x1 image and is affected by image blocking, proxying, and prefetching.
- Click tracking rewrites links through SES tracking infrastructure.
- Tracking metadata may contain personal data such as IP address and user agent.
- Raw SNS JSON is retained in SQLite for audit/debug but is not returned by operations APIs.

Readiness checks the configured marketing SES configuration set's custom redirect domain when tracking is enabled and `NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN` is set.

Set optional env vars:

```sh
NUSEND_SES_TRACKING_EVENTS=open,click
NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN=tracking.example.com
```
