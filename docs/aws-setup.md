# AWS setup and CloudFormation safety

AWS setup is part of the guided workstation flow. Run it from a trusted checkout; do not execute the template or copy stack outputs by hand. AWS resources can incur charges, including while setup is waiting at a human gate.

```sh
pnpm nusend:setup
pnpm nusend:setup doctor
pnpm nusend:setup continue
pnpm nusend:setup status
```

`continue` performs at most one eligible stage. Use `status` for local checkpoints and `status --refresh` only when an explicit provider/remote refresh is wanted. See [deployment](./deployment.md#guided-first-time-setup) for workstation, VPS, state, and secret-handling requirements.

## SSO-only provisioning authentication

Setup AWS commands require a modern refreshable IAM Identity Center profile (`sso_session`, `sso_account_id`, `sso_role_name`). Static access keys, legacy non-refreshable SSO, role chains, credential processes, web-identity/container credentials, and `aws login` are rejected. Nusend never parses `~/.aws/sso/cache`, never implements custom OIDC, and never stores access tokens, device codes, browser URLs, or temporary credentials.

During `init` or `pnpm nusend:setup aws auth`:

1. The wizard lists existing modern SSO profiles and lets you select one already assigned to the intended account/role.
2. If none fit, it launches `aws configure sso` in your terminal so AWS CLI owns IdP, MFA, and account/role selection.
3. Choose normal browser/PKCE flow or explicit device-code / no-browser mode when prompted.
4. Identity Center region (where SSO is configured) stays distinct from the workload/SES region chosen for the stack.
5. Before provider use, the wizard verifies SSO provenance and `sts get-caller-identity` against the bound profile, account, role, partition, and workload region.
6. Expired sessions trigger one interactive `aws sso login --profile <name>`; AccessDenied is not retried as authentication.

Re-run `pnpm nusend:setup aws auth` anytime the profile must be reselected or the session refreshed. The wizard does not rewrite or delete your AWS config profiles and does not call global `aws sso logout`.

## Permission handoff and importable policy

Authority to create the stack is administrator-controlled in IAM Identity Center, not OAuth consent and not something the wizard can self-grant. Do not edit `AWSReservedSSO_*` managed roles.

When a setup AWS step returns AccessDenied (or when you run `pnpm nusend:setup aws permissions`):

- the wizard renders an exact importable identity policy into the installation directory as `nusend-provisioner-policy.json` (mode `0600`);
- the document is derived from the canonical [`provisioning-policy.example.json`](../deploy/aws/policies/provisioning-policy.example.json) with the bound partition, workload region, account, installation slug, and optional hosted-zone scope already substituted;
- state records only the fixed filename, context, SHA-256 fingerprint, and generation time—not secrets;
- output explains honesty limits: AWS has no universally available complete preflight; read/list probes are partial evidence; write permissions are not fully verifiable before AWS evaluates the operation; the first denial remains authoritative and prior change-set checkpoints are preserved.

Recommended administrator path:

1. Create a dedicated custom permission set (suggested name `NusendProvisioner-<installation>`).
2. Attach the artifact as an inline policy (console paste/import, or `aws sso-admin put-inline-policy-to-permission-set --inline-policy file://...` with your instance/permission-set ARNs).
3. Assign that permission set only to the intended user/group on the target account.
4. Ask the operator to reauthenticate (`pnpm nusend:setup aws auth`) and resume the same reviewed plan/stage.

After final validation, the wizard guides removal of a dedicated temporary assignment and records your attestation only—it never deletes permission sets or assignments. For later AWS updates or destroy, regenerate the same fingerprinted policy with `pnpm nusend:setup aws permissions`, temporarily reassign if needed, complete the mutation, then remove the assignment again.

The stack-owned runtime IAM user/key created by CloudFormation is separate from this temporary setup provisioner identity and remains required on the VPS.

## Static stack contract

[`nusend-stack.json`](../deploy/aws/nusend-stack.json) is the only AWS infrastructure definition. It accepts:

- installation name, SES domain identity and From address, and public domain;
- marketing, tracking, and delivery-event choices;
- an optional Route 53 hosted-zone ID and an alarm email;
- `EnableWebhookSubscription`, which is false for core and true only for finalize.

The stack creates newly named, dedicated resources: the SES identity and configuration sets, Easy DKIM records when Route 53 is selected, SES event destinations, a Signature Version 2 feedback topic, an encrypted 14-day SQS DLQ, a least-privilege runtime IAM user, an alarm topic/email subscription, four CloudWatch alarms, and—during finalize—the HTTPS feedback subscription. Configuration-set suppression requires both bounce and complaint reasons. Name collisions stop setup; shared or existing resources are not imported or adopted.

Non-secret outputs include the AWS region and sender, configuration-set names, feedback-topic ARN, tracking values, runtime-user name, DLQ URL/ARN/name, alarm-topic ARN, and the three DKIM CNAME name/value pairs. Runtime access-key material is never a stack output. The coordinator creates one key only after explicit approval and writes it directly to the protected deployment environment.

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

If the dedicated provisioner assignment was removed after setup, temporarily reassign it and reauthenticate (`pnpm nusend:setup aws auth`) before destroy. The plan binds the exact account, region, stack, domain, SSH target, runtime key, subscriptions/alarms, and all three DLQ counters. Unknown keys, uncertain stack ownership, active updates, context mismatches, or a nonempty DLQ block deletion. When safe, apply stops Compose without deleting volumes, deletes the recorded runtime key, rechecks the DLQ, and deletes the exact stack.

Stack-owned AWS resources are deleted. The following remain: SES production access; external/public DNS (including externally managed DKIM); R2/restic backups; Google OAuth; the remote checkout and `.env`; database, Caddy, and backup state; and all Compose volumes. Remove retained external resources only through a separate, deliberate provider/data procedure. After destroy, remove any temporary provisioner assignment again.

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
- [AWS CLI IAM Identity Center configuration](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)
- [IAM Identity Center permission sets](https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsets.html)
- [SES identity and DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [Request SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Manage SES sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)
- [SNS dead-letter queues](https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html)
- [SES DMARC guidance](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
