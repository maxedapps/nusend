import { describe, expect, it } from "vitest";

import type { SesReadinessResult } from "../aws/readiness.ts";
import { sesDocs } from "./constants.ts";
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
      "configuration-sets",
      "configuration-set-suppression",
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
    expect(guide.steps.find((step) => step.id === "configuration-set-suppression")).toMatchObject({
      relatedChecks: [
        "ses.config_set.transactional.suppression",
        "ses.config_set.marketing.suppression",
      ],
      title: "Confirm configuration-set suppression",
    });
    expect(
      guide.steps
        .find((step) => step.id === "configuration-set-suppression")
        ?.actions.some(
          (action) =>
            action.kind === "console" && action.text.includes("CloudFormation configuration sets"),
        ),
    ).toBe(true);
    expect(guide.steps.some((step) => step.id === "account-suppression")).toBe(false);
    expect(guide.docs).toEqual([
      sesDocs.setup,
      sesDocs.readiness,
      sesDocs.simulator,
      sesDocs.productionReadiness,
    ]);
    expect(
      guide.steps
        .find((step) => step.id === "webhook-subscription")
        ?.actions.find((action) => action.kind === "api"),
    ).toMatchObject({ url: "https://mail.example.com/api/webhooks/aws/sns/ses" });
    expect(
      guide.steps
        .find((step) => step.id === "simulator-validation")
        ?.actions.filter((action) => action.kind === "cli")
        .map((action) => action.command),
    ).toEqual([
      "docker compose exec -T api bun apps/service/src/ses/simulator-main.ts success --purpose transactional --mode send-acceptance",
      "docker compose exec -T api bun apps/service/src/ses/simulator-main.ts bounce --purpose transactional --mode end-to-end",
    ]);

    const stackResourceSteps = [
      "verify-sender-identity",
      "configuration-sets",
      "configuration-set-suppression",
      "sns-topic",
      "webhook-subscription",
      "event-destinations",
      "sns-dlq-alarms",
    ];
    for (const id of stackResourceSteps) {
      const actions = guide.steps.find((step) => step.id === id)?.actions ?? [];
      const instructions = actions
        .map((action) => (action.kind === "cli" ? action.command : action.text))
        .join("\n");
      expect(instructions, id).toMatch(/pnpm nusend:setup|CloudFormation/iu);
    }
    const allCommands = guide.steps
      .flatMap((step) => step.actions)
      .filter((action) => action.kind === "cli")
      .map((action) => action.command);
    expect(allCommands.some((command) => /^aws\s+.*\bcreate-/u.test(command))).toBe(false);
    const subscriptionInstructions = guide.steps
      .find((step) => step.id === "webhook-subscription")
      ?.actions.map((action) => (action.kind === "cli" ? action.command : action.text))
      .join("\n");
    expect(subscriptionInstructions).toMatch(/Never manually create a second subscription/iu);
  });

  it("aggregates duplicate per-topic checks in pass-then-error order", () => {
    const guide = buildSesSetupGuide({
      ...readiness(),
      checks: [check("sns.subscription.webhook", "ok"), check("sns.subscription.webhook", "error")],
      status: "error",
    });

    expect(guide.status).toBe("error");
    expect(guide.steps.find((step) => step.id === "webhook-subscription")?.status).toBe("error");
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
