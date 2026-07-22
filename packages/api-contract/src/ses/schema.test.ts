import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SesEventDetailResponseSchema,
  SesEventsListResponseSchema,
  SesReadinessResponseSchema,
  SesSetupGuideResponseSchema,
  SesSimulatorRunDetailResponseSchema,
  SesSimulatorRunsListResponseSchema,
  SesSummaryResponseSchema,
  type SesEvent,
} from "./schema.js";

const event = {
  actionTaken: "suppressed",
  bounceSubType: "General",
  bounceType: "Permanent",
  complaintFeedbackType: null,
  createdAt: "2026-07-03T12:00:00.000Z",
  deliveryDelayType: null,
  deliveryId: "delivery_1",
  diagnosticCode: "smtp diagnostic",
  eventType: "Bounce",
  feedbackId: "feedback_1",
  id: "event_1",
  ipAddress: null,
  linkTags: null,
  linkUrl: null,
  mailingId: "mailing_1",
  notificationId: "notification_1",
  occurredAt: "2026-07-03T11:59:00.000Z",
  recipientEmail: "user@example.com",
  rejectReason: null,
  sesMessageId: "ses_1",
  userAgent: null,
};

const simulatorRun = {
  deliveryId: null,
  errorMessage: null,
  expectedEventType: "Delivery",
  expectedSuppressionReason: null,
  finishedAt: null,
  id: "run_1",
  mailingId: "mailing_1",
  mode: "send_acceptance",
  purpose: "transactional",
  recipientEmail: "success@simulator.amazonses.com",
  scenario: "success",
  startedAt: "2026-07-03T12:00:00.000Z",
  status: "started",
  targetBaseUrl: null,
};

describe("SES wire schemas", () => {
  it("decodes event list/detail fields and link-tag maps", () => {
    const withLinkTags = { ...event, linkTags: { campaign: ["summer"] } };
    expect(
      Schema.decodeUnknownSync(SesEventsListResponseSchema)({ items: [withLinkTags] }),
    ).toEqual({ items: [withLinkTags] });
    expect(Schema.decodeUnknownSync(SesEventDetailResponseSchema)(event)).toEqual(event);
    expectTypeOf<SesEvent["occurredAt"]>().toEqualTypeOf<string | null>();
  });

  it("decodes summary counts, recent issues, and the latest worker run", () => {
    const response = {
      counts: {
        Bounce: 1,
        Click: 0,
        Complaint: 0,
        Delivery: 0,
        DeliveryDelay: 0,
        Open: 0,
        Reject: 0,
        "Rendering Failure": 0,
        Send: 0,
        Subscription: 0,
        Unknown: 0,
      },
      latestEventAt: event.createdAt,
      latestNotificationAt: "2026-07-03T11:59:59.000Z",
      recentIssues: [event],
      totals: { bounce: 1, click: 0, complaint: 0, open: 0 },
      worker: {
        latestRun: {
          claimed: 1,
          dead: 0,
          failed: 0,
          finishedAt: "2026-07-03T12:01:00.000Z",
          id: "worker_run_1",
          mode: "loop",
          released: 0,
          skippedStale: 0,
          succeeded: 1,
          workerId: "worker_1",
        },
      },
    };
    expect(Schema.decodeUnknownSync(SesSummaryResponseSchema)(response)).toEqual(response);
  });

  it("decodes readiness checks with omitted optional details and setup action variants", () => {
    const readiness = {
      checkedAt: "2026-07-03T12:00:00.000Z",
      checks: [
        {
          action: null,
          docs: ["docs/deployment.md#ses-readiness"],
          id: "db.ses_operations_schema",
          message: "SES operations tables are migrated.",
          status: "ok",
          title: "SES operations schema",
        },
      ],
      expectedWebhookUrl: null,
      status: "ok",
    };
    expect(Schema.decodeUnknownSync(SesReadinessResponseSchema)(readiness)).toEqual(readiness);

    const guide = {
      docs: ["docs/deployment.md#aws-ses-and-sns-setup"],
      status: "warning",
      steps: [
        {
          actions: [
            { kind: "api", text: "Open readiness", url: "/api/operations/ses/readiness" },
            { command: "export AWS_REGION=us-east-1", kind: "cli" },
            { kind: "console", text: "Open SES" },
          ],
          id: "choose-region",
          relatedChecks: ["config.aws_region"],
          status: "warning",
          title: "Choose a region",
          why: "SES resources are regional.",
        },
      ],
      title: "Set up AWS SES for Nusend",
    };
    expect(Schema.decodeUnknownSync(SesSetupGuideResponseSchema)(guide)).toEqual(guide);
  });

  it("decodes simulator run list/detail nullability and rejects unknown statuses", () => {
    expect(
      Schema.decodeUnknownSync(SesSimulatorRunsListResponseSchema)({ items: [simulatorRun] }),
    ).toEqual({ items: [simulatorRun] });
    expect(Schema.decodeUnknownSync(SesSimulatorRunDetailResponseSchema)(simulatorRun)).toEqual(
      simulatorRun,
    );
    expect(() =>
      Schema.decodeUnknownSync(SesSimulatorRunDetailResponseSchema)({
        ...simulatorRun,
        status: "unknown",
      }),
    ).toThrow(/status/);
  });
});
