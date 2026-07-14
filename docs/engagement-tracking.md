# Engagement tracking

OPEN/CLICK tracking is optional. If configured SES event destinations publish these events, Nusend stores them in `ses_events` and exposes sanitized operations views.

Readiness always requires BOUNCE, COMPLAINT, REJECT, and DELIVERY_DELAY for transactional and marketing configuration sets. Marketing readiness additionally requires only events selected in `NUSEND_SES_TRACKING_EVENTS`; transactional readiness remains base-only. With the variable blank/unset, OPEN and CLICK are not readiness requirements.

Caveats:

- Open tracking uses a 1x1 image and is affected by image blocking, proxying, and prefetching.
- Click tracking rewrites links through SES tracking infrastructure.
- Tracking metadata may contain personal data such as IP address and user agent.
- Raw SNS JSON is retained in SQLite for audit/debug but is not returned by operations APIs; a complete retention/capacity policy remains an open production gate.

Readiness checks the marketing configuration set's custom redirect domain when tracking is enabled and `NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN` is set.

Opt in explicitly:

```sh
NUSEND_SES_TRACKING_EVENTS=open,click
NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN=tracking.example.com
```
