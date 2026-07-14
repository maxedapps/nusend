# SES setup

Use `GET /api/operations/ses/readiness` and `GET /api/operations/ses/setup-guide` with an owner session or API key with `operations:read` while setting up SES.

Required production pieces:

1. Choose `AWS_REGION`.
2. Verify `NUSEND_SES_FROM_EMAIL` or its domain in SES.
3. Configure DKIM for the sending domain.
4. Request production access if sending to non-simulator recipients.
5. Enable SES account-level suppression for `BOUNCE` and `COMPLAINT` as defense in depth.
6. Create transactional and marketing SES configuration sets.
7. Create a Standard SNS topic, set SignatureVersion 2, and allow SES to publish to it.
8. Add event destinations for BOUNCE, COMPLAINT, REJECT, and DELIVERY_DELAY. Add OPEN and/or CLICK only when opting into that tracking; DELIVERY remains optional.
9. Subscribe SNS to `https://<public-host>/api/webhooks/aws/sns/ses`; attach a DLQ and alarms.
10. Set `NUSEND_SES_FEEDBACK_TOPIC_ARNS` to the allowed topic ARN list.
11. Configure `NUSEND_PUBLIC_BASE_URL` and `NUSEND_UNSUBSCRIBE_SECRET` before marketing sends.
12. To opt into tracking, set `NUSEND_SES_TRACKING_EVENTS=open,click` (or one event) and optionally `NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN`.
13. Run readiness until required checks pass.
14. Run SES simulator success/bounce/complaint scenarios on the deployed instance receiving SNS callbacks.
15. Manually verify Gmail DKIM and List-Unsubscribe behavior before real marketing volume.

Readiness requires BOUNCE, COMPLAINT, REJECT, and DELIVERY_DELAY for both configuration sets. Only marketing adds the OPEN/CLICK events explicitly configured in `NUSEND_SES_TRACKING_EVENTS`; transactional readiness stays base-only. Leaving tracking blank does not create an OPEN/CLICK requirement.

Verified notifications declaring Bounce or Complaint must contain the matching body block. Missing/mismatched reputation payloads retain one unprocessed raw audit row and return retryable `503` so SNS can redeliver; malformed outer requests remain `400`. Configure the subscription DLQ and alarms for persistent malformed-provider payloads.

Minimum readiness IAM permissions:

- `ses:GetAccount`
- `ses:GetEmailIdentity`
- `ses:GetConfigurationSet`
- `ses:GetConfigurationSetEventDestinations`
- `sns:GetTopicAttributes`
- `sns:ListSubscriptionsByTopic`

Readiness/setup endpoints never mutate AWS resources.
