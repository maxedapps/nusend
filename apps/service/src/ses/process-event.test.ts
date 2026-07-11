import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { fakeSesOperationsConfig, runTest } from "../testing/layers.ts";
import { handleSesSnsRequest } from "./process-event.ts";
import type { VerifiedSnsEnvelope } from "./sns-schema.ts";

const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";

describe("handleSesSnsRequest", () => {
  it("stores open and click events without suppressions", async () => {
    const openEnvelope = envelope("sns_open", {
      eventType: "Open",
      mail: mail("ses_open", "opened@example.com"),
      open: {
        ipAddress: "192.0.2.1",
        timestamp: "2026-07-03T12:00:00.000Z",
        userAgent: "Example UA",
      },
    });
    const clickEnvelope = envelope("sns_click", {
      click: {
        ipAddress: "192.0.2.2",
        link: "https://example.com/path",
        linkTags: { campaign: ["summer"] },
        timestamp: "2026-07-03T12:01:00.000Z",
        userAgent: "Example Click UA",
      },
      eventType: "Click",
      mail: mail("ses_click", "clicked@example.com"),
    });

    const result = await runTest(
      Effect.gen(function* () {
        yield* handleSesSnsRequest(JSON.stringify(openEnvelope));
        yield* handleSesSnsRequest(JSON.stringify(clickEnvelope));
        const db = yield* Database;
        return {
          events: yield* db.all(
            "test:events",
            "SELECT event_type AS eventType, recipient_email AS recipientEmail, link_url AS linkUrl, user_agent AS userAgent FROM ses_events ORDER BY event_type ASC;",
          ),
          suppressions: yield* db.all("test:suppressions", "SELECT * FROM suppressions;"),
        };
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    expect(result.events).toEqual([
      {
        eventType: "Click",
        linkUrl: "https://example.com/path",
        recipientEmail: "clicked@example.com",
        userAgent: "Example Click UA",
      },
      {
        eventType: "Open",
        linkUrl: null,
        recipientEmail: "opened@example.com",
        userAgent: "Example UA",
      },
    ]);
    expect(result.suppressions).toEqual([]);
  });

  it("records (not suppresses) a permanent bounce that carries no recipient email", async () => {
    const bounceEnvelope = envelope("sns_bounce_noemail", {
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "" }],
        feedbackId: "feedback-id",
      },
      eventType: "Bounce",
      mail: mail("ses_bounce_noemail", ""),
    });

    const result = await runTest(
      Effect.gen(function* () {
        yield* handleSesSnsRequest(JSON.stringify(bounceEnvelope));
        const db = yield* Database;
        return {
          events: yield* db.all<{ actionTaken: string }>(
            "test:events",
            "SELECT action_taken AS actionTaken FROM ses_events;",
          ),
          suppressions: yield* db.all("test:suppressions", "SELECT email FROM suppressions;"),
        };
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    // No usable email → no suppression was written, so action must not claim "suppressed".
    expect(result.suppressions).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.actionTaken).not.toBe("suppressed");
  });

  it("dedupes SNS redelivery and suppresses permanent bounces once", async () => {
    const bounceEnvelope = envelope("sns_bounce", {
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "bounce@example.com" }],
        feedbackId: "feedback-id",
      },
      eventType: "Bounce",
      mail: mail("ses_bounce", "bounce@example.com"),
    });

    const result = await runTest(
      Effect.gen(function* () {
        yield* handleSesSnsRequest(JSON.stringify(bounceEnvelope));
        yield* handleSesSnsRequest(JSON.stringify(bounceEnvelope));
        const db = yield* Database;
        return {
          events: yield* db.all("test:events", "SELECT event_type AS eventType FROM ses_events;"),
          notifications: yield* db.all(
            "test:notifications",
            "SELECT sns_message_id AS snsMessageId FROM ses_notifications;",
          ),
          suppressions: yield* db.all(
            "test:suppressions",
            "SELECT email, reason, scope FROM suppressions;",
          ),
        };
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    expect(result.notifications).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.suppressions).toEqual([
      { email: "bounce@example.com", reason: "bounce", scope: "all" },
    ]);
  });

  it("reprocesses a redelivered notification whose event rows were never written", async () => {
    const bounceEnvelope = envelope("sns_partial", {
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "bounce@example.com" }],
      },
      eventType: "Bounce",
      mail: mail("ses_partial", "bounce@example.com"),
    });

    const result = await runTest(
      Effect.gen(function* () {
        const db = yield* Database;
        // Simulate a prior delivery that failed between the audit insert and
        // the event transaction: notification stored, no metadata, no events.
        yield* db.run(
          "test:seed:partial-notification",
          `INSERT INTO ses_notifications (
             id, sns_message_id, sns_topic_arn, sns_type, event_type, ses_message_id, raw_json, received_at
           ) VALUES (
             'notification_partial', 'sns_partial', '${topicArn}',
             'Notification', NULL, NULL, '{}', '2026-07-03T12:00:00.000Z'
           );`,
        );

        yield* handleSesSnsRequest(JSON.stringify(bounceEnvelope));
        return {
          events: yield* db.all(
            "test:events",
            "SELECT notification_id AS notificationId, event_type AS eventType FROM ses_events;",
          ),
          notifications: yield* db.all(
            "test:notifications",
            "SELECT id, event_type AS eventType, ses_message_id AS sesMessageId FROM ses_notifications;",
          ),
          suppressions: yield* db.all(
            "test:suppressions",
            "SELECT email, reason, scope FROM suppressions;",
          ),
        };
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    expect(result.notifications).toEqual([
      { eventType: "Bounce", id: "notification_partial", sesMessageId: "ses_partial" },
    ]);
    expect(result.events).toEqual([
      { eventType: "Bounce", notificationId: "notification_partial" },
    ]);
    expect(result.suppressions).toEqual([
      { email: "bounce@example.com", reason: "bounce", scope: "all" },
    ]);
  });

  it("audits verified malformed SES notifications before returning malformed", async () => {
    const malformedEnvelope = { ...envelope("sns_malformed", {}), Message: "{}" };

    const result = await runTest(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(handleSesSnsRequest(JSON.stringify(malformedEnvelope)));
        const db = yield* Database;
        return {
          exit,
          notifications: yield* db.all(
            "test:notifications",
            "SELECT event_type AS eventType, ses_message_id AS sesMessageId, sns_message_id AS snsMessageId FROM ses_notifications;",
          ),
        };
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.notifications).toEqual([
      { eventType: null, sesMessageId: null, snsMessageId: "sns_malformed" },
    ]);
  });

  it("records not-spam complaints and transient bounces without suppressing", async () => {
    const complaintEnvelope = envelope("sns_not_spam", {
      complaint: {
        complainedRecipients: [{ emailAddress: "user@example.com" }],
        complaintFeedbackType: "not-spam",
      },
      eventType: "Complaint",
      mail: mail("ses_complaint", "user@example.com"),
    });
    const bounceEnvelope = envelope("sns_transient", {
      bounce: {
        bounceType: "Transient",
        bouncedRecipients: [{ emailAddress: "temp@example.com" }],
      },
      eventType: "Bounce",
      mail: mail("ses_bounce", "temp@example.com"),
    });

    const result = await runTest(
      Effect.gen(function* () {
        yield* handleSesSnsRequest(JSON.stringify(complaintEnvelope));
        yield* handleSesSnsRequest(JSON.stringify(bounceEnvelope));
        const db = yield* Database;
        return {
          events: yield* db.all(
            "test:events",
            "SELECT event_type AS eventType, action_taken AS actionTaken, recipient_email AS recipientEmail FROM ses_events ORDER BY recipient_email ASC;",
          ),
          suppressions: yield* db.all("test:suppressions", "SELECT * FROM suppressions;"),
        };
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    expect(result.events).toEqual([
      { actionTaken: "recorded", eventType: "Bounce", recipientEmail: "temp@example.com" },
      { actionTaken: "recorded", eventType: "Complaint", recipientEmail: "user@example.com" },
    ]);
    expect(result.suppressions).toEqual([]);
  });

  it("falls back to SES message ID when delivery tag email mismatches", async () => {
    const bounceEnvelope = envelope("sns_fallback", {
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "actual@example.com" }],
      },
      eventType: "Bounce",
      mail: {
        ...mail("ses_fallback", "actual@example.com"),
        tags: { delivery_id: ["delivery_wrong"] },
      },
    });

    const result = await runTest(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.run(
          "test:mailing",
          `INSERT INTO mailings (id, purpose, state, subject, html, created_at, updated_at)
           VALUES ('mailing_fallback', 'transactional', 'completed', 's', '<p>s</p>', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
        );
        yield* db.run(
          "test:delivery",
          `INSERT INTO deliveries (id, mailing_id, email, status, ses_message_id, created_at, updated_at)
           VALUES ('delivery_fallback', 'mailing_fallback', 'actual@example.com', 'sent', 'ses_fallback', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
        );
        yield* handleSesSnsRequest(JSON.stringify(bounceEnvelope));
        return yield* db.get(
          "test:event",
          "SELECT delivery_id AS deliveryId, mailing_id AS mailingId FROM ses_events LIMIT 1;",
        );
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    expect(result).toEqual({ deliveryId: "delivery_fallback", mailingId: "mailing_fallback" });
  });

  it("records row shapes for remaining SES event types without suppressions", async () => {
    const envelopes = [
      envelope("sns_delay", {
        deliveryDelay: {
          delayedRecipients: [
            { diagnosticCode: "Mailbox busy", emailAddress: "delayed@example.com" },
          ],
          delayType: "MailboxFull",
          timestamp: "2026-07-03T12:10:00.000Z",
        },
        eventType: "DeliveryDelay",
        mail: mail("ses_delay", "delayed@example.com"),
      }),
      envelope("sns_delivery", {
        delivery: {
          recipients: ["one@example.com", "two@example.com"],
          timestamp: "2026-07-03T12:11:00.000Z",
        },
        eventType: "Delivery",
        mail: mail("ses_delivery", "one@example.com"),
      }),
      envelope("sns_reject", {
        eventType: "Reject",
        mail: mail("ses_reject", "reject@example.com"),
        reject: { reason: "Bad content" },
      }),
      envelope("sns_send", {
        eventType: "Send",
        mail: mail("ses_send", "sent@example.com"),
      }),
      envelope("sns_rendering", {
        eventType: "Rendering Failure",
        mail: mail("ses_rendering", "render@example.com"),
        renderingFailure: { errorMessage: "Template data missing", templateName: "welcome" },
      }),
      envelope("sns_subscription", {
        eventType: "Subscription",
        mail: mail("ses_subscription", "subscription@example.com"),
        subscription: { contactList: "news" },
      }),
      envelope("sns_unknown", {
        eventType: "Reputation",
        mail: { ...mail("ses_unknown", "unused@example.com"), destination: [] },
      }),
    ];

    const result = await runTest(
      Effect.gen(function* () {
        for (const item of envelopes) {
          yield* handleSesSnsRequest(JSON.stringify(item));
        }
        const db = yield* Database;
        return {
          events: yield* db.all(
            "test:row-shapes",
            `SELECT ses_message_id AS sesMessageId, event_type AS eventType,
                    recipient_email AS recipientEmail, action_taken AS actionTaken,
                    diagnostic_code AS diagnosticCode,
                    delivery_delay_type AS deliveryDelayType,
                    reject_reason AS rejectReason,
                    occurred_at AS occurredAt
             FROM ses_events
             ORDER BY ses_message_id ASC, recipient_email ASC;`,
          ),
          suppressions: yield* db.all("test:suppressions", "SELECT * FROM suppressions;"),
        };
      }),
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
    );

    expect(result.suppressions).toEqual([]);
    expect(result.events).toEqual([
      {
        actionTaken: "recorded",
        deliveryDelayType: "MailboxFull",
        diagnosticCode: "Mailbox busy",
        eventType: "DeliveryDelay",
        occurredAt: "2026-07-03T12:10:00.000Z",
        recipientEmail: "delayed@example.com",
        rejectReason: null,
        sesMessageId: "ses_delay",
      },
      {
        actionTaken: "recorded",
        deliveryDelayType: null,
        diagnosticCode: null,
        eventType: "Delivery",
        occurredAt: "2026-07-03T12:11:00.000Z",
        recipientEmail: "one@example.com",
        rejectReason: null,
        sesMessageId: "ses_delivery",
      },
      {
        actionTaken: "recorded",
        deliveryDelayType: null,
        diagnosticCode: null,
        eventType: "Delivery",
        occurredAt: "2026-07-03T12:11:00.000Z",
        recipientEmail: "two@example.com",
        rejectReason: null,
        sesMessageId: "ses_delivery",
      },
      {
        actionTaken: "recorded",
        deliveryDelayType: null,
        diagnosticCode: null,
        eventType: "Reject",
        occurredAt: "2026-07-03T12:00:00.000Z",
        recipientEmail: "reject@example.com",
        rejectReason: "Bad content",
        sesMessageId: "ses_reject",
      },
      {
        actionTaken: "recorded",
        deliveryDelayType: null,
        diagnosticCode: null,
        eventType: "Rendering Failure",
        occurredAt: "2026-07-03T12:00:00.000Z",
        recipientEmail: "render@example.com",
        rejectReason: null,
        sesMessageId: "ses_rendering",
      },
      {
        actionTaken: "recorded",
        deliveryDelayType: null,
        diagnosticCode: null,
        eventType: "Send",
        occurredAt: "2026-07-03T12:00:00.000Z",
        recipientEmail: "sent@example.com",
        rejectReason: null,
        sesMessageId: "ses_send",
      },
      {
        actionTaken: "recorded",
        deliveryDelayType: null,
        diagnosticCode: null,
        eventType: "Subscription",
        occurredAt: "2026-07-03T12:00:00.000Z",
        recipientEmail: "subscription@example.com",
        rejectReason: null,
        sesMessageId: "ses_subscription",
      },
      {
        actionTaken: "recorded",
        deliveryDelayType: null,
        diagnosticCode: null,
        eventType: "Unknown",
        occurredAt: "2026-07-03T12:00:00.000Z",
        recipientEmail: null,
        rejectReason: null,
        sesMessageId: "ses_unknown",
      },
    ]);
  });

  it("returns disabled when no feedback topics are configured", async () => {
    await expect(
      runTest(
        handleSesSnsRequest(
          JSON.stringify(
            envelope("sns_1", { eventType: "Send", mail: mail("ses_1", "user@example.com") }),
          ),
        ),
        {
          sesOperations: fakeSesOperationsConfig({ feedbackTopicArns: [] }),
        },
      ),
    ).rejects.toMatchObject({ _tag: "SesOperationsDisabledError" });
  });
});

function envelope(messageId: string, message: unknown): VerifiedSnsEnvelope {
  return {
    Message: JSON.stringify(message),
    MessageId: messageId,
    Signature: "signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    Timestamp: "2026-07-03T12:00:00.000Z",
    TopicArn: topicArn,
    Type: "Notification",
  };
}

function mail(messageId: string, email: string) {
  return {
    destination: [email],
    messageId,
    tags: { delivery_id: ["delivery_1"] },
    timestamp: "2026-07-03T12:00:00.000Z",
  };
}
