import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { AwsAdminError } from "./errors.ts";
import { runSesReadinessChecks } from "./readiness.ts";
import type { SesAdminService } from "./ses-admin.ts";
import type { SnsAdminService } from "./sns-admin.ts";
import { fakeSesOperationsConfig, runTest } from "../testing/layers.ts";

describe("runSesReadinessChecks", () => {
  it("reports missing local config without AWS checks", async () => {
    const result = await runTest(runSesReadinessChecks({ includeAws: false }), {
      sesOperations: fakeSesOperationsConfig({
        awsRegion: Option.none(),
        feedbackTopicArns: [],
        fromEmail: Option.none(),
        marketingConfigurationSet: Option.none(),
        publicBaseUrl: Option.none(),
        transactionalConfigurationSet: Option.none(),
      }),
    });

    expect(result.status).toBe("warning");
    expect(
      result.checks.some((check) => check.id === "config.aws_region" && check.status === "warning"),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => check.id === "db.ses_operations_schema" && check.status === "ok",
      ),
    ).toBe(true);
    expect(result.expectedWebhookUrl).toBeNull();
  });

  it("normalizes trailing slash public base URL for expected webhook URL", async () => {
    const result = await runTest(runSesReadinessChecks({ includeAws: false }), {
      sesOperations: fakeSesOperationsConfig({
        publicBaseUrl: Option.some("https://mail.example.com"),
      }),
    });

    expect(result.expectedWebhookUrl).toBe("https://mail.example.com/api/webhooks/aws/sns/ses");
  });

  it("surfaces collected config diagnostics as readiness errors", async () => {
    const result = await runTest(runSesReadinessChecks({ includeAws: false }), {
      sesOperations: fakeSesOperationsConfig({
        configIssues: [{ id: "config.request_timeout_ms", message: "bad timeout" }],
      }),
    });

    expect(result.status).toBe("error");
    expect(result.checks.find((check) => check.id === "config.request_timeout_ms")).toMatchObject({
      message: "bad timeout",
      status: "error",
    });
  });

  it("surfaces all-invalid tracking input as an actionable readiness error", async () => {
    const message =
      "NUSEND_SES_TRACKING_EVENTS contains unsupported values: delivery, rendering. Use only open and click.";
    const result = await runTest(runSesReadinessChecks({ includeAws: false }), {
      sesOperations: fakeSesOperationsConfig({
        configIssues: [{ id: "config.tracking_events", message }],
        trackingEvents: [],
      }),
    });

    expect(result.status).toBe("error");
    expect(result.checks.find((check) => check.id === "config.tracking_events")).toMatchObject({
      action: "Fix the invalid environment variable value and restart Nusend.",
      message,
      status: "error",
    });
    expect(result.checks.some((check) => check.id === "config.tracking")).toBe(false);
  });

  it("does not emit duplicate check ids when a config issue shadows a local check", async () => {
    const result = await runTest(runSesReadinessChecks({ includeAws: false }), {
      sesOperations: fakeSesOperationsConfig({
        configIssues: [
          { id: "config.public_base_url", message: "invalid public base URL" },
          { id: "config.worker_budget", message: "invalid worker budget" },
        ],
      }),
    });

    const publicBaseUrlChecks = result.checks.filter(
      (check) => check.id === "config.public_base_url",
    );
    expect(publicBaseUrlChecks).toHaveLength(1);
    expect(publicBaseUrlChecks[0]).toMatchObject({
      message: "invalid public base URL",
      status: "error",
    });
    expect(result.checks.filter((check) => check.id === "config.worker_budget")).toHaveLength(1);
    const ids = result.checks.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns ok for configured fake AWS resources", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: okSesAdmin(),
      snsAdmin: okSnsAdmin(),
    });

    expect(result.checks.find((check) => check.id === "aws.credentials_and_account")?.status).toBe(
      "ok",
    );
    expect(result.checks.find((check) => check.id === "sns.subscription.webhook")?.status).toBe(
      "ok",
    );
    expect(
      result.checks.find((check) => check.id === "ses.account.suppression_recommendation")?.status,
    ).toBe("ok");
    expect(result.checks.find((check) => check.id === "ses.identity.dkim")?.status).toBe("ok");
    expect(result.checks.find((check) => check.id === "sns.topic.signature_version")?.status).toBe(
      "ok",
    );
  });

  it("accepts base SES events when optional tracking is not configured", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: sesAdminWithEvents({ marketing: baseEvents, transactional: baseEvents }),
      snsAdmin: okSnsAdmin(),
    });

    expect(
      result.checks.find((check) => check.id === "ses.config_set.marketing.events"),
    ).toMatchObject({ status: "ok" });
    expect(
      result.checks.find((check) => check.id === "ses.config_set.transactional.events"),
    ).toMatchObject({ status: "ok" });
  });

  it("requires only OPEN when marketing open tracking is configured", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: sesAdminWithEvents({ marketing: baseEvents, transactional: baseEvents }),
      sesOperations: fakeSesOperationsConfig({ trackingEvents: ["open"] }),
      snsAdmin: okSnsAdmin(),
    });

    expect(
      result.checks.find((check) => check.id === "ses.config_set.marketing.events"),
    ).toMatchObject({
      details: { missing: ["OPEN"] },
      message: "Missing configured SES event publishing for: OPEN.",
      status: "warning",
    });
  });

  it("accepts configured CLICK when the marketing destination publishes click events", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: sesAdminWithEvents({
        marketing: [...baseEvents, "CLICK"],
        transactional: baseEvents,
      }),
      sesOperations: fakeSesOperationsConfig({ trackingEvents: ["click"] }),
      snsAdmin: okSnsAdmin(),
    });

    expect(
      result.checks.find((check) => check.id === "ses.config_set.marketing.events"),
    ).toMatchObject({ status: "ok" });
  });

  it("does not apply configured marketing tracking requirements to transactional readiness", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: sesAdminWithEvents({
        marketing: [...baseEvents, "OPEN"],
        transactional: baseEvents,
      }),
      sesOperations: fakeSesOperationsConfig({ trackingEvents: ["open"] }),
      snsAdmin: okSnsAdmin(),
    });

    expect(
      result.checks.find((check) => check.id === "ses.config_set.marketing.events"),
    ).toMatchObject({ status: "ok" });
    expect(
      result.checks.find((check) => check.id === "ses.config_set.transactional.events"),
    ).toMatchObject({ status: "ok" });
  });

  it("warns when configured tracking domain does not match SES configuration set", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: okSesAdmin(),
      sesOperations: fakeSesOperationsConfig({
        trackingCustomRedirectDomain: Option.some("tracking.example.com"),
        trackingEvents: ["open", "click"],
      }),
      snsAdmin: okSnsAdmin(),
    });

    expect(
      result.checks.find((check) => check.id === "ses.config_set.marketing.tracking_domain"),
    ).toMatchObject({ status: "warning" });
  });

  it("falls back from unverified sender email identity to verified domain identity", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: {
        ...okSesAdmin(),
        getEmailIdentity: (identity) =>
          Effect.succeed(
            identity === "example.com"
              ? { dkimStatus: "SUCCESS", verifiedForSending: true }
              : { dkimStatus: "PENDING", verifiedForSending: false },
          ),
      },
      sesOperations: fakeSesOperationsConfig({ fromEmail: Option.some("sender@example.com") }),
      snsAdmin: okSnsAdmin(),
    });

    expect(result.checks.find((check) => check.id === "ses.identity.from_email")).toMatchObject({
      details: { identity: "example.com" },
      status: "ok",
    });
  });

  it("maps AWS admin failures into readiness checks", async () => {
    const result = await runTest(runSesReadinessChecks(), {
      sesAdmin: {
        ...okSesAdmin(),
        getAccount: () =>
          Effect.fail(
            new AwsAdminError({ kind: "missing_credentials", operation: "ses:get-account" }),
          ),
      },
    });

    expect(result.status).toBe("error");
    expect(result.checks.find((check) => check.id === "aws.credentials_and_account")).toMatchObject(
      {
        status: "error",
      },
    );
  });
});

const baseEvents = ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"] as const;

function sesAdminWithEvents(events: {
  readonly marketing: readonly string[];
  readonly transactional: readonly string[];
}): SesAdminService {
  return {
    ...okSesAdmin(),
    getConfigurationSetEventDestinations: (name) =>
      Effect.succeed([
        {
          enabled: true,
          eventTypes: name === "marketing-set" ? events.marketing : events.transactional,
          matchingTopicArn: "arn:aws:sns:us-east-1:123456789012:nusend-test",
          name: "sns",
        },
      ]),
  };
}

function okSesAdmin(): SesAdminService {
  return {
    getAccount: () =>
      Effect.succeed({
        enforcementStatus: "HEALTHY",
        productionAccessEnabled: true,
        sendingEnabled: true,
        suppressionReasons: ["BOUNCE", "COMPLAINT"],
      }),
    getConfigurationSet: (name) =>
      Effect.succeed({ name, sendingEnabled: true, trackingCustomRedirectDomain: null }),
    getConfigurationSetEventDestinations: () =>
      Effect.succeed([
        {
          enabled: true,
          eventTypes: ["BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "OPEN", "CLICK"],
          matchingTopicArn: "arn:aws:sns:us-east-1:123456789012:nusend-test",
          name: "sns",
        },
      ]),
    getEmailIdentity: () => Effect.succeed({ dkimStatus: "SUCCESS", verifiedForSending: true }),
  };
}

function okSnsAdmin(): SnsAdminService {
  return {
    getTopicAttributes: (topicArn) => Effect.succeed({ signatureVersion: "2", topicArn }),
    listSubscriptionsByTopic: () =>
      Effect.succeed([
        {
          endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
          protocol: "https",
          subscriptionArn: "arn:subscription",
        },
      ]),
  };
}
