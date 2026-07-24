# AWS setup and CloudFormation safety

AWS setup is part of the guided workstation flow. Run it from a trusted checkout; do not execute the template or copy stack outputs by hand. AWS resources can incur charges, including while setup is waiting at a human gate.

```sh
pnpm nusend:setup init
pnpm nusend:setup doctor
pnpm nusend:setup continue
pnpm nusend:setup status
```

`continue` performs at most one eligible stage. Use `status` for local checkpoints and `status --refresh` only when an explicit provider/remote refresh is wanted. See [deployment](./deployment.md#guided-first-time-setup) for workstation, VPS, state, and secret-handling requirements.

## Static stack contract

[`nusend-stack.json`](../deploy/aws/nusend-stack.json) is the only AWS infrastructure definition. It accepts:

- installation name, SES domain identity and From address, and public domain;
- marketing, tracking, and delivery-event choices;
- an optional Route 53 hosted-zone ID and an alarm email;
- `EnableWebhookSubscription`, which is false for core and true only for finalize.

The stack creates newly named, dedicated resources: the SES identity and configuration sets, Easy DKIM records when Route 53 is selected, SES event destinations, a Signature Version 2 feedback topic, an encrypted 14-day SQS DLQ, a least-privilege runtime IAM user, an alarm topic/email subscription, four CloudWatch alarms, and—during finalize—the HTTPS feedback subscription. Configuration-set suppression requires both bounce and complaint reasons. Name collisions stop setup; shared or existing resources are not imported or adopted.

Non-secret outputs include the AWS region and sender, configuration-set names, feedback-topic ARN, tracking values, runtime-user name, DLQ URL/ARN/name, alarm-topic ARN, and the three DKIM CNAME name/value pairs. Runtime access-key material is never a stack output. The coordinator creates one key only after explicit approval and writes it directly to the protected deployment environment.

A temporary provisioning principal may use the reviewed [`provisioning-policy.example.json`](../deploy/aws/policies/provisioning-policy.example.json). Before attaching it, make these explicit substitutions while keeping the result valid JSON and equally constrained:

- **partition:** replace every `arn:aws:` prefix with `arn:<partition>:` (for example, `arn:aws-us-gov:` in GovCloud);
- **region:** replace every `us-east-1` with the selected AWS region (for example, `us-gov-west-1`);
- **account:** replace every `123456789012` with the expected 12-digit AWS account ID;
- **installation slug:** replace every `nusend-demo` with `nusend-<installation-id>`, where `<installation-id>` is the exact slug entered during `pnpm nusend:setup init`;
- **optional hosted zone:** when Route 53 DKIM management is selected, replace `Z1234567890ABC` with the exact hosted-zone ID. Otherwise remove the entire `OptionalRoute53DkimRecords` statement; never replace its resource with `*`.

Parse the rendered document as JSON, verify none of the sample values remain, and review every resource ARN before use. Confirm organization policies and permission boundaries also permit it, use `CAPABILITY_NAMED_IAM`, and remove that temporary access after setup.

## Reviewed core and finalize change sets

AWS mutations are split into two reviewed CloudFormation change sets:

1. **Core** creates the dedicated resources with the public webhook disabled.
2. Nusend is deployed and proven healthy with the exact feedback topic allowlisted.
3. **Finalize** updates the same stack to enable exactly one HTTPS subscription at `https://<domain>/api/webhooks/aws/sns/ses` with the normal SNS JSON envelope and the stack DLQ.

For explicit recovery, plan and apply remain separate:

```sh
pnpm nusend:setup aws plan
pnpm nusend:setup aws apply
```

Before applying, inspect the printed account, region, stack, phase, parameter changes, IAM capability, replacements, and exact change-set ARN. Apply executes only that fingerprinted reviewed plan and requires the displayed context-bound phrase. A stale or mismatched plan is rejected. Never create a second webhook subscription when one is pending or confirmed; correct TLS, public health, topic allowlisting, or outbound HTTPS and resume instead.

## SES identity and production access

Easy DKIM is a manual wait. With Route 53 selected, CloudFormation owns the three CNAMEs. With external DNS, publish every output CNAME exactly once, account for providers that append the zone, and wait for identity verification and DKIM success. Do not recreate the identity while DNS propagates.

SES production access is regional account state outside the stack and remains subject to AWS review. The coordinator collects an honest application brief covering:

- the real website and use case;
- transactional/marketing mail type, expected volume, and frequency;
- how recipients consent and are acquired;
- unsubscribe handling;
- bounce and complaint handling;
- form-abuse controls and operational monitoring;
- the contact language used with AWS.

Do not use placeholders or invent answers. Submission occurs only after explicit approval; pending requests are not resubmitted. Sandbox simulator addresses and verified recipients remain available while waiting, but approval is required for unverified production recipients.

## Manual approval gates

The workflow pauses rather than claiming these external actions succeeded:

- external DKIM DNS publication and SES identity verification;
- SES production approval;
- Google OAuth, external DNS/firewall, and private R2 credentials;
- independent escrow of the generated restic password—losing it makes backups unreadable;
- AWS alarm-email confirmation and an exercised alarm notification;
- HTTPS subscription confirmation, simulator feedback, and zero DLQ counters.

After public health succeeds, validation commands are available for focused recovery:

```sh
pnpm nusend:setup validate pre-simulator
pnpm nusend:setup validate simulator
pnpm nusend:setup validate final
```

The simulator covers success, bounce, and complaint. Nusend does not automatically consume or replay DLQ messages. Any visible, in-flight, or delayed message requires investigation and deliberate replay after remediation.

## Destroy boundary

Destroy is also review then apply:

```sh
pnpm nusend:setup destroy plan
pnpm nusend:setup destroy apply
```

The plan binds the exact account, region, stack, domain, SSH target, runtime key, subscriptions/alarms, and all three DLQ counters. Unknown keys, uncertain stack ownership, active updates, context mismatches, or a nonempty DLQ block deletion. When safe, apply stops Compose without deleting volumes, deletes the recorded runtime key, rechecks the DLQ, and deletes the exact stack.

Stack-owned AWS resources are deleted. The following remain: SES production access; external/public DNS (including externally managed DKIM); R2/restic backups; Google OAuth; the remote checkout and `.env`; database, Caddy, and backup state; and all Compose volumes. Remove retained external resources only through a separate, deliberate provider/data procedure.

## Production gate

Automated setup is not approval for broad volume. Before production marketing:

- confirm alarm delivery and keep every DLQ counter at zero;
- review SES quotas and ramp volume gradually;
- publish and monitor DMARC and verify SPF/DKIM/DMARC alignment on real mail;
- inspect Gmail **Show original** and confirm DKIM covers `List-Unsubscribe` and `List-Unsubscribe-Post`;
- approve OPEN/CLICK privacy and retention when enabled;
- prove backup restore from an explicit snapshot, reboot recovery, host capacity, and incident procedures.

Repository tests cannot prove live DNS, SES approval, inbox placement, provider firewall behavior, or restore/reboot outcomes.

## AWS references

- [CloudFormation change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html)
- [SES identity and DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [Request SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Manage SES sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)
- [SNS dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html)
- [SES DMARC guidance](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
