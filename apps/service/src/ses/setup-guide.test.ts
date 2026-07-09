import { describe, expect, it } from "vitest";

import type { SesReadinessResult } from "../aws/readiness.ts";
import { buildSesSetupGuide } from "./setup-guide.ts";

describe("buildSesSetupGuide", () => {
  it("includes the major operator setup steps and normalized webhook URL", () => {
    const guide = buildSesSetupGuide(readiness());

    expect(guide.steps.map((step) => step.id)).toEqual([
      "choose-region",
      "configure-env",
      "verify-sender-identity",
      "configure-dkim",
      "production-access",
      "account-suppression",
      "configuration-sets",
      "sns-topic",
      "webhook-subscription",
      "event-destinations",
      "sns-dlq-alarms",
      "engagement-tracking",
      "marketing-unsubscribe",
      "run-readiness",
      "simulator-validation",
      "manual-production-checks",
    ]);
    expect(
      guide.steps
        .find((step) => step.id === "webhook-subscription")
        ?.actions.find((action) => action.kind === "api"),
    ).toMatchObject({ url: "https://mail.example.com/api/webhooks/aws/sns/ses" });
  });

  it("aggregates related check status and does not expose secrets", () => {
    const guide = buildSesSetupGuide({
      ...readiness(),
      checks: [check("config.aws_region", "ok"), check("aws.credentials_and_account", "error")],
      status: "error",
    });

    expect(guide.status).toBe("error");
    expect(guide.steps.find((step) => step.id === "choose-region")?.status).toBe("error");
    expect(JSON.stringify(guide)).not.toContain("secret-value");
  });
});

function readiness(): SesReadinessResult {
  return {
    checkedAt: "2026-07-03T12:00:00.000Z",
    checks: [
      check("config.aws_region", "ok"),
      check("aws.credentials_and_account", "ok"),
      check("config.public_base_url", "ok"),
      check("sns.subscription.webhook", "ok"),
    ],
    expectedWebhookUrl: "https://mail.example.com/api/webhooks/aws/sns/ses",
    status: "ok",
  };
}

function check(id: string, status: "error" | "ok" | "skipped" | "warning") {
  return {
    action: null,
    id,
    message: `${id} ${status}`,
    status,
    title: id,
  };
}
