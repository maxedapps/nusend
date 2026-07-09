# SES simulator testing

Nusend includes a local/server simulator CLI:

```sh
pnpm --filter @nusend/service ses:simulate success --purpose transactional --mode send-acceptance
pnpm --filter @nusend/service ses:simulate bounce --purpose transactional --mode end-to-end
pnpm --filter @nusend/service ses:simulate complaint --purpose transactional --mode end-to-end
pnpm --filter @nusend/service ses:simulate:all -- --purpose transactional --mode send-acceptance
```

Scenarios use AWS SES mailbox simulator recipients: `success`, `bounce`, `complaint`, `ooto`, and `suppressionlist`.

Modes:

- `send-acceptance`: creates a local mailing and runs the worker until SES accepts or rejects the send. This does not prove SNS feedback delivery.
- `end-to-end`: additionally waits for matching `ses_events` in the same database. Run this on the deployment that receives the public SNS webhook; running locally while SNS points at production will time out.

Remote `--target-url` validation is not implemented. Run the CLI on the deployed instance whose database receives the SNS callback.

Simulator sends do not affect SES reputation metrics, but they can be rate-limited and billed by AWS.
