import { describe, expect, it } from "vitest";

import { APPLY_PHRASE_PREFIX, REQUIRED_CAPABILITY } from "./constants.ts";
import {
  assertHonestWebsiteUrl,
  awsArgv,
  buildApplyConfirmationPhrase,
  buildStackName,
  buildStackParameters,
  determinePhase,
  fingerprintTemplateAndParameters,
  formatDkimRecords,
  isActiveStackStatus,
  isDkimReady,
  isFabricatedPlaceholder,
  isHealthyTerminalStackStatus,
  isIdentityReady,
  isNoChangeChangeSet,
  mapStackOutputsToEnv,
  parseChangeSetArn,
  summarizeChangeSet,
  summarizeFailedStackEvents,
  validateApplyConfirmation,
  validateProductionBrief,
} from "./pure.ts";
import type { SetupState } from "../state/schema.ts";

function sampleState(installationId: string): SetupState {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    installationId,
    createdAt: now,
    updatedAt: now,
    config: {
      releaseTag: "v0.1.1",
      domain: "mail.example.com",
      ingressMode: "direct",
      ownerEmail: "owner@example.com",
      ownerName: "Owner",
      awsProfile: "nusend-provisioner",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesIdentity: "example.com",
      sesFromEmail: "sender@example.com",
      marketingEnabled: false,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      installationName: installationId,
    },
    stages: {
      init: {
        status: "complete",
        completedAt: now,
        evidence: { verified: true, installationId },
      },
    },
    plans: {},
  };
}

function validBrief() {
  return {
    website: "https://shop.northwindtraders.com",
    useCase: "Transactional order receipts and password resets for paying customers.",
    mailType: "TRANSACTIONAL",
    expectedVolume: "about 20_000 messages per month",
    frequency: "continuous low-volume transactional bursts",
    recipientConsent: "Collected at checkout with explicit order-notification consent.",
    unsubscribe: "One-click List-Unsubscribe plus account preference center.",
    bounceComplaintHandling: "SNS webhook into Nusend suppressions within minutes.",
    formAbuseControls: "Authenticated API only; no public unauthenticated send forms.",
    monitoring: "CloudWatch alarms plus daily complaint rate review.",
    contactLanguage: "EN",
  };
}

describe("aws pure helpers", () => {
  it("builds deterministic core/finalize parameters and phase", () => {
    const state = sampleState("prod");
    expect(determinePhase(state)).toBe("core");
    const core = buildStackParameters(state, "core");
    expect(core.find((p) => p.ParameterKey === "EnableWebhookSubscription")?.ParameterValue).toBe(
      "false",
    );
    expect(core.find((p) => p.ParameterKey === "InstallationName")?.ParameterValue).toBe("prod");
    expect(core.find((p) => p.ParameterKey === "EnableDeliveryEvents")?.ParameterValue).toBe(
      "true",
    );

    const withCore: SetupState = {
      ...state,
      stages: {
        ...state.stages,
        aws_core: {
          status: "complete",
          completedAt: "2026-01-02T00:00:00.000Z",
          evidence: { verified: true },
        },
      },
    };
    expect(determinePhase(withCore)).toBe("finalize");
    const finalize = buildStackParameters(withCore, "finalize");
    expect(
      finalize.find((p) => p.ParameterKey === "EnableWebhookSubscription")?.ParameterValue,
    ).toBe("true");
  });

  it("fingerprints template+parameters stably and changes with phase", () => {
    const state = sampleState("prod");
    const template = '{"Resources":{}}';
    const core = buildStackParameters(state, "core");
    const a = fingerprintTemplateAndParameters(template, core, {
      stackName: "nusend-prod",
      phase: "core",
    });
    const b = fingerprintTemplateAndParameters(template, core, {
      stackName: "nusend-prod",
      phase: "core",
    });
    const c = fingerprintTemplateAndParameters(template, buildStackParameters(state, "finalize"), {
      stackName: "nusend-prod",
      phase: "finalize",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires exact apply confirmation phrase with account/region/stack/phase", () => {
    const expected = {
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    };
    const phrase = buildApplyConfirmationPhrase(expected);
    expect(phrase).toBe("APPLY 123456789012 us-east-1 nusend-prod core");
    expect(phrase.startsWith(APPLY_PHRASE_PREFIX)).toBe(true);
    expect(() => validateApplyConfirmation(phrase, expected)).not.toThrow();
    expect(() => validateApplyConfirmation("APPLY wrong", expected)).toThrow(
      /Confirmation rejected/,
    );
  });

  it("rejects blank and fabricated production-access answers", () => {
    expect(isFabricatedPlaceholder("")).toBe(true);
    expect(isFabricatedPlaceholder("n/a")).toBe(true);
    expect(isFabricatedPlaceholder("TODO")).toBe(true);
    expect(isFabricatedPlaceholder("https://example.com")).toBe(true);
    expect(isFabricatedPlaceholder("xxx")).toBe(true);
    expect(isFabricatedPlaceholder("We send order receipts to paying customers only.")).toBe(false);

    const valid = validBrief();
    expect(validateProductionBrief(valid).mailType).toBe("TRANSACTIONAL");
    expect(validateProductionBrief(valid).website).toBe("https://shop.northwindtraders.com");
    expect(() => validateProductionBrief({ ...valid, website: "" })).toThrow(/website/);
    expect(() => validateProductionBrief({ ...valid, website: "https://example.com" })).toThrow(
      /fabricated|example/,
    );
    expect(() =>
      validateProductionBrief({ ...valid, website: "https://shop.contoso-mail.test" }),
    ).toThrow(/reserved|\.test/);
    expect(() => validateProductionBrief({ ...valid, website: "https://app.invalid" })).toThrow(
      /reserved|\.invalid/,
    );
    expect(() => validateProductionBrief({ ...valid, website: "https://app.localhost" })).toThrow(
      /localhost/,
    );
    expect(() => assertHonestWebsiteUrl("https://docs.example.org")).toThrow(/example/);
    expect(() => validateProductionBrief({ ...valid, useCase: "tbd" })).toThrow(/fabricated/);
    expect(() => validateProductionBrief({ ...valid, mailType: "OTHER" })).toThrow(/TRANSACTIONAL/);
  });

  it("parses change-set ARNs and classifies stack statuses", () => {
    const parsed = parseChangeSetArn(
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/abc",
    );
    expect(parsed).toMatchObject({
      partition: "aws",
      region: "us-east-1",
      accountId: "123456789012",
      changeSetName: "nusend-prod-core",
      changeSetUniqueId: "abc",
    });
    expect(() => parseChangeSetArn("not-an-arn")).toThrow(/malformed/);
    expect(isActiveStackStatus("UPDATE_IN_PROGRESS")).toBe(true);
    expect(isActiveStackStatus("REVIEW_IN_PROGRESS")).toBe(true);
    expect(isActiveStackStatus("CREATE_COMPLETE")).toBe(false);
    expect(isHealthyTerminalStackStatus("CREATE_COMPLETE")).toBe(true);
    expect(isHealthyTerminalStackStatus("UPDATE_ROLLBACK_COMPLETE")).toBe(false);
  });

  it("detects identity/DKIM readiness and no-change change sets", () => {
    expect(
      isIdentityReady({
        VerificationStatus: "SUCCESS",
        VerifiedForSendingStatus: true,
      }),
    ).toBe(true);
    expect(
      isIdentityReady({
        VerificationStatus: "PENDING",
        VerifiedForSendingStatus: true,
      }),
    ).toBe(false);
    expect(
      isDkimReady({
        DkimAttributes: { Status: "SUCCESS", SigningEnabled: true },
      }),
    ).toBe(true);
    expect(
      isDkimReady({
        DkimAttributes: { Status: "PENDING", SigningEnabled: true },
      }),
    ).toBe(false);
    expect(
      isNoChangeChangeSet({
        Status: "FAILED",
        StatusReason: "The submitted information didn't contain changes.",
        Changes: [],
      }),
    ).toBe(true);
  });

  it("summarizes change sets with replacement and IAM signals", () => {
    const summary = summarizeChangeSet({
      Status: "CREATE_COMPLETE",
      ChangeSetId: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/abc",
      StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/nusend-prod/xyz",
      StackName: "nusend-prod",
      Capabilities: [REQUIRED_CAPABILITY],
      Changes: [
        {
          ResourceChange: {
            Action: "Add",
            LogicalResourceId: "RuntimeUser",
            ResourceType: "AWS::IAM::User",
            Replacement: "False",
          },
        },
        {
          ResourceChange: {
            Action: "Modify",
            LogicalResourceId: "FeedbackTopic",
            ResourceType: "AWS::SNS::Topic",
            Replacement: "True",
          },
        },
      ],
    });
    expect(summary.resourceCount).toBe(2);
    expect(summary.replacements).toBe(1);
    expect(summary.iamChanges).toBe(1);
    expect(summary.capabilities).toContain(REQUIRED_CAPABILITY);
  });

  it("maps known non-secret outputs into env and formats DKIM records", () => {
    const state = sampleState("prod");
    const outputs = {
      AwsRegion: "us-east-1",
      SesFromEmail: "sender@example.com",
      TransactionalConfigurationSetName: "nusend-prod-transactional",
      MarketingConfigurationSetName: "",
      FeedbackTopicArn: "arn:aws:sns:us-east-1:123456789012:topic",
      TrackingEvents: "",
      RuntimeUserName: "nusend-prod-runtime",
      DkimRecordName1: "token1._domainkey.example.com",
      DkimRecordValue1: "token1.dkim.amazonses.com",
      DkimRecordName2: "token2._domainkey.example.com",
      DkimRecordValue2: "token2.dkim.amazonses.com",
      DkimRecordName3: "token3._domainkey.example.com",
      DkimRecordValue3: "token3.dkim.amazonses.com",
    };
    expect(mapStackOutputsToEnv(outputs, state)).toEqual({
      AWS_REGION: "us-east-1",
      NUSEND_SES_FROM_EMAIL: "sender@example.com",
      NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "nusend-prod-transactional",
      NUSEND_SES_FEEDBACK_TOPIC_ARNS: "arn:aws:sns:us-east-1:123456789012:topic",
    });
    expect(formatDkimRecords(outputs)).toHaveLength(3);
  });

  it("bounds failed stack event diagnostics without env dumps", () => {
    const failed = summarizeFailedStackEvents({
      StackEvents: [
        {
          LogicalResourceId: "RuntimeUser",
          ResourceStatus: "CREATE_FAILED",
          ResourceStatusReason: "Limit exceeded",
        },
        {
          LogicalResourceId: "Stack",
          ResourceStatus: "CREATE_IN_PROGRESS",
          ResourceStatusReason: "ok",
        },
      ],
    });
    expect(failed).toEqual([
      {
        logicalId: "RuntimeUser",
        status: "CREATE_FAILED",
        reason: "Limit exceeded",
        timestamp: "",
      },
    ]);
  });

  it("builds argv arrays with explicit profile and region and no shell", () => {
    const state = sampleState("prod");
    const args = awsArgv(state, ["sts", "get-caller-identity", "--output", "json"]);
    expect(args).toEqual([
      "sts",
      "get-caller-identity",
      "--output",
      "json",
      "--profile",
      "nusend-provisioner",
      "--region",
      "us-east-1",
    ]);
    expect(args.every((part) => typeof part === "string")).toBe(true);
    expect(buildStackName("prod")).toBe("nusend-prod");
  });
});
