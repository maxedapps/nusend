import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { fakeSesFeedbackConfig, runTest, type TestServices } from "../testing/layers.ts";
import { handleSesFeedbackSnsRequest } from "./process.ts";
import type { VerifiedSnsEnvelope } from "./sns-schema.ts";

const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";
const signingCertUrl = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem";

describe("handleSesFeedbackSnsRequest", () => {
  it("fails as disabled when feedback config is absent", async () => {
    const envelope = notificationEnvelope({ Message: sesEvent({ eventType: "DeliveryDelay" }) });

    await expect(
      runTest(handleSesFeedbackSnsRequest(JSON.stringify(envelope))),
    ).rejects.toMatchObject({
      _tag: "SesFeedbackDisabledError",
    });
  });

  it("rejects malformed JSON before verifier processing", async () => {
    await expect(
      runTest(handleSesFeedbackSnsRequest("not-json"), {
        sesFeedback: Option.some(fakeSesFeedbackConfig()),
      }),
    ).rejects.toMatchObject({ _tag: "SesFeedbackMalformedError" });
  });

  it("rejects unexpected SNS topics", async () => {
    const envelope = notificationEnvelope({
      Message: sesEvent({ eventType: "DeliveryDelay" }),
      TopicArn: "arn:aws:sns:us-east-1:123456789012:other-topic",
    });

    await expect(runFeedback(envelope, queryRows("SELECT 1 AS ok;"))).rejects.toMatchObject({
      _tag: "SesFeedbackForbiddenError",
    });
  });

  it("confirms subscriptions after signature/topic validation and records an audit row", async () => {
    const subscribeUrl = "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription";
    const envelope = baseEnvelope({
      Message: "You have chosen to subscribe.",
      SubscribeURL: subscribeUrl,
      Token: "token-1",
      Type: "SubscriptionConfirmation",
    });
    const calls: string[] = [];

    const rows = await runFeedback(
      envelope,
      queryRows<{ sns_type: string }>("SELECT sns_type FROM ses_feedback_notifications;"),
      {
        snsConfirmerCalls: calls,
        seed: false,
      },
    );

    expect(calls).toEqual([subscribeUrl]);
    expect(rows).toEqual([{ sns_type: "SubscriptionConfirmation" }]);
  });

  it("records permanent bounces and inserts global bounce suppressions idempotently", async () => {
    const envelope = notificationEnvelope({
      Message: sesEvent({
        bounce: {
          bounceSubType: "General",
          bounceType: "Permanent",
          bouncedRecipients: [
            { diagnosticCode: "smtp; 550 hard bounce", emailAddress: "User@example.com" },
          ],
          feedbackId: "feedback-bounce",
        },
        eventType: "Bounce",
        tags: { delivery_id: ["delivery_1"], mailing_id: ["mailing_1"], purpose: ["marketing"] },
      }),
    });

    const result = await runFeedback(
      [envelope, envelope],
      Effect.gen(function* () {
        return {
          feedbackRows: yield* queryRows<{
            action_taken: string;
            bounce_type: string | null;
            delivery_id: string | null;
            recipient_email: string;
          }>(
            "SELECT action_taken, bounce_type, delivery_id, recipient_email FROM ses_feedback_recipients;",
          ),
          suppressions: yield* queryRows<{ email: string; reason: string; scope: string }>(
            "SELECT email, reason, scope FROM suppressions;",
          ),
        };
      }),
    );

    expect(result.feedbackRows).toEqual([
      {
        action_taken: "suppressed",
        bounce_type: "Permanent",
        delivery_id: "delivery_1",
        recipient_email: "user@example.com",
      },
    ]);
    expect(result.suppressions).toEqual([
      { email: "user@example.com", reason: "bounce", scope: "all" },
    ]);
  });

  it("records transient bounces without suppressing", async () => {
    const envelope = notificationEnvelope({
      Message: sesEvent({
        bounce: {
          bounceType: "Transient",
          bouncedRecipients: [{ emailAddress: "user@example.com" }],
        },
        eventType: "Bounce",
      }),
    });

    const result = await runFeedback(
      envelope,
      Effect.gen(function* () {
        return {
          feedback: yield* queryRows("SELECT action_taken FROM ses_feedback_recipients;"),
          suppressions: yield* queryRows("SELECT * FROM suppressions;"),
        };
      }),
    );

    expect(result.suppressions).toEqual([]);
    expect(result.feedback).toEqual([{ action_taken: "recorded" }]);
  });

  it("suppresses complaints except not-spam complaints", async () => {
    const result = await runFeedback(
      [
        notificationEnvelope({
          Message: sesEvent({
            complaint: {
              complainedRecipients: [{ emailAddress: "complainer@example.com" }],
              feedbackId: "feedback-complaint",
            },
            eventType: "Complaint",
          }),
          MessageId: "sns-complaint-1",
        }),
        notificationEnvelope({
          Message: sesEvent({
            complaint: {
              complainedRecipients: [{ emailAddress: "notspam@example.com" }],
              complaintFeedbackType: "not-spam",
            },
            eventType: "Complaint",
          }),
          MessageId: "sns-complaint-2",
        }),
      ],
      Effect.gen(function* () {
        return {
          feedback: yield* queryRows(
            "SELECT recipient_email, action_taken FROM ses_feedback_recipients ORDER BY recipient_email;",
          ),
          suppressions: yield* queryRows("SELECT email, reason FROM suppressions ORDER BY email;"),
        };
      }),
    );

    expect(result.suppressions).toEqual([{ email: "complainer@example.com", reason: "complaint" }]);
    expect(result.feedback).toEqual([
      { action_taken: "suppressed", recipient_email: "complainer@example.com" },
      { action_taken: "recorded", recipient_email: "notspam@example.com" },
    ]);
  });

  it("records reject and delivery delay events without suppressing", async () => {
    const result = await runFeedback(
      [
        notificationEnvelope({
          Message: sesEvent({ eventType: "Reject", reject: { reason: "Bad content" } }),
          MessageId: "sns-reject",
        }),
        notificationEnvelope({
          Message: sesEvent({
            deliveryDelay: {
              delayedRecipients: [
                { diagnosticCode: "4.4.7 delayed", emailAddress: "delay@example.com" },
              ],
            },
            eventType: "DeliveryDelay",
          }),
          MessageId: "sns-delay",
        }),
      ],
      Effect.gen(function* () {
        return {
          feedback: yield* queryRows(
            "SELECT event_type, recipient_email, diagnostic_code, action_taken FROM ses_feedback_recipients ORDER BY event_type;",
          ),
          suppressions: yield* queryRows("SELECT * FROM suppressions;"),
        };
      }),
    );

    expect(result.suppressions).toEqual([]);
    expect(result.feedback).toEqual([
      {
        action_taken: "recorded",
        diagnostic_code: "4.4.7 delayed",
        event_type: "DeliveryDelay",
        recipient_email: "delay@example.com",
      },
      {
        action_taken: "recorded",
        diagnostic_code: "Bad content",
        event_type: "Reject",
        recipient_email: "user@example.com",
      },
    ]);
  });

  it("records unmatched multi-recipient bounces and suppresses each recipient", async () => {
    const result = await runFeedback(
      notificationEnvelope({
        Message: sesEvent({
          bounce: {
            bounceType: "Permanent",
            bouncedRecipients: [
              { emailAddress: "one@example.com" },
              { emailAddress: "two@example.com" },
            ],
          },
          eventType: "Bounce",
          messageId: "unmatched-ses-message",
        }),
      }),
      Effect.gen(function* () {
        return {
          feedback: yield* queryRows(
            "SELECT delivery_id, recipient_email FROM ses_feedback_recipients ORDER BY recipient_email;",
          ),
          suppressions: yield* queryRows("SELECT email, reason FROM suppressions ORDER BY email;"),
        };
      }),
    );

    expect(result.feedback).toEqual([
      { delivery_id: null, recipient_email: "one@example.com" },
      { delivery_id: null, recipient_email: "two@example.com" },
    ]);
    expect(result.suppressions).toEqual([
      { email: "one@example.com", reason: "bounce" },
      { email: "two@example.com", reason: "bounce" },
    ]);
  });

  it("resolves deliveries by SES message id when the delivery_id tag does not match", async () => {
    const result = await runFeedback(
      notificationEnvelope({
        Message: sesEvent({
          bounce: {
            bounceType: "Transient",
            bouncedRecipients: [{ emailAddress: "user@example.com" }],
          },
          eventType: "Bounce",
          tags: { delivery_id: ["missing_delivery"] },
        }),
      }),
      queryRows("SELECT delivery_id, mailing_id FROM ses_feedback_recipients;"),
    );

    expect(result).toEqual([{ delivery_id: "delivery_1", mailing_id: "mailing_1" }]);
  });

  it("records unsubscribe confirmations without recipient rows", async () => {
    const envelope = baseEnvelope({
      Message: "Unsubscribe confirmed.",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
      Token: "token-1",
      Type: "UnsubscribeConfirmation",
    });

    const result = await runFeedback(
      envelope,
      Effect.gen(function* () {
        return {
          notifications: yield* queryRows("SELECT sns_type FROM ses_feedback_notifications;"),
          recipients: yield* queryRows("SELECT * FROM ses_feedback_recipients;"),
        };
      }),
      { seed: false },
    );

    expect(result.notifications).toEqual([{ sns_type: "UnsubscribeConfirmation" }]);
    expect(result.recipients).toEqual([]);
  });

  it("records delivery events without suppressing", async () => {
    const result = await runFeedback(
      notificationEnvelope({
        Message: JSON.stringify({
          delivery: { recipients: ["user@example.com"] },
          eventType: "Delivery",
          mail: { destination: ["user@example.com"], messageId: "ses-message-1", tags: {} },
        }),
      }),
      Effect.gen(function* () {
        return {
          feedback: yield* queryRows(
            "SELECT event_type, action_taken, recipient_email FROM ses_feedback_recipients;",
          ),
          suppressions: yield* queryRows("SELECT * FROM suppressions;"),
        };
      }),
    );

    expect(result.feedback).toEqual([
      { action_taken: "recorded", event_type: "Delivery", recipient_email: "user@example.com" },
    ]);
    expect(result.suppressions).toEqual([]);
  });

  it("records hard bounce followed by complaint but keeps the original suppression row", async () => {
    const result = await runFeedback(
      [
        notificationEnvelope({
          Message: sesEvent({
            bounce: {
              bounceType: "Permanent",
              bouncedRecipients: [{ emailAddress: "user@example.com" }],
            },
            eventType: "Bounce",
          }),
          MessageId: "sns-bounce-first",
        }),
        notificationEnvelope({
          Message: sesEvent({
            complaint: {
              complainedRecipients: [{ emailAddress: "user@example.com" }],
            },
            eventType: "Complaint",
          }),
          MessageId: "sns-complaint-second",
        }),
      ],
      Effect.gen(function* () {
        return {
          feedback: yield* queryRows(
            "SELECT event_type, action_taken FROM ses_feedback_recipients ORDER BY event_type;",
          ),
          suppressions: yield* queryRows("SELECT email, reason FROM suppressions;"),
        };
      }),
    );

    expect(result.feedback).toEqual([
      { action_taken: "suppressed", event_type: "Bounce" },
      { action_taken: "suppressed", event_type: "Complaint" },
    ]);
    expect(result.suppressions).toEqual([{ email: "user@example.com", reason: "bounce" }]);
  });

  it("records unknown authentic events without recipient rows", async () => {
    const result = await runFeedback(
      notificationEnvelope({ Message: sesEvent({ eventType: "Rendering Failure" }) }),
      Effect.gen(function* () {
        return {
          notifications: yield* queryRows("SELECT event_type FROM ses_feedback_notifications;"),
          recipients: yield* queryRows("SELECT * FROM ses_feedback_recipients;"),
        };
      }),
    );

    expect(result.notifications).toEqual([{ event_type: "Rendering Failure" }]);
    expect(result.recipients).toEqual([]);
  });
});

function runFeedback<A, E>(
  envelopes: VerifiedSnsEnvelope | readonly VerifiedSnsEnvelope[],
  assertion: Effect.Effect<A, E, TestServices>,
  options: { readonly seed?: boolean; readonly snsConfirmerCalls?: string[] } = {},
): Promise<A> {
  const envelopeList = Array.isArray(envelopes) ? envelopes : [envelopes];
  return runTest(
    Effect.gen(function* () {
      if (options.seed !== false) yield* seedDelivery();
      for (const envelope of envelopeList) {
        yield* handleSesFeedbackSnsRequest(JSON.stringify(envelope));
      }
      return yield* assertion;
    }),
    {
      ids: [
        "feedback_recipient_1",
        "suppression_1",
        "feedback_recipient_2",
        "suppression_2",
        "feedback_recipient_3",
        "suppression_3",
        "feedback_recipient_4",
        "suppression_4",
      ],
      sesFeedback: Option.some(fakeSesFeedbackConfig()),
      snsConfirmerCalls: options.snsConfirmerCalls,
      snsVerifier: (message) => {
        const raw = String(message);
        const matching = envelopeList.find((envelope) => raw.includes(envelope.MessageId));
        return Effect.succeed(matching ?? envelopeList[0]);
      },
    },
  );
}

function queryRows<T>(sql: string) {
  return Effect.flatMap(Database, (db) => db.all<T>("test:query", sql));
}

function seedDelivery() {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.run(
      "test:seed:mailing",
      `INSERT INTO mailings (id, purpose, state, subject, html, created_at, updated_at)
       VALUES ('mailing_1', 'marketing', 'scheduled', 'Subject', '<p>Hello</p>', '2026-07-08T00:00:00.000Z', '2026-07-08T00:00:00.000Z');`,
    );
    yield* db.run(
      "test:seed:delivery",
      `INSERT INTO deliveries (id, mailing_id, email, status, ses_message_id, created_at, updated_at)
       VALUES ('delivery_1', 'mailing_1', 'user@example.com', 'sent', 'ses-message-1', '2026-07-08T00:00:01.000Z', '2026-07-08T00:00:01.000Z');`,
    );
  });
}

type SesEventOptions = {
  readonly bounce?: unknown;
  readonly complaint?: unknown;
  readonly deliveryDelay?: unknown;
  readonly eventType: string;
  readonly messageId?: string;
  readonly reject?: unknown;
  readonly tags?: Record<string, readonly string[]>;
};

function sesEvent(options: SesEventOptions): string {
  return JSON.stringify({
    bounce: options.bounce,
    complaint: options.complaint,
    deliveryDelay: options.deliveryDelay,
    eventType: options.eventType,
    mail: {
      destination: ["user@example.com"],
      messageId: options.messageId ?? "ses-message-1",
      tags: options.tags ?? {},
    },
    reject: options.reject,
  });
}

function notificationEnvelope(overrides: Partial<VerifiedSnsEnvelope>): VerifiedSnsEnvelope {
  return baseEnvelope({
    Message: sesEvent({ eventType: "DeliveryDelay" }),
    Type: "Notification",
    ...overrides,
  });
}

function baseEnvelope(overrides: Partial<VerifiedSnsEnvelope>): VerifiedSnsEnvelope {
  return {
    Message: "{}",
    MessageId: "sns-message-1",
    Signature: "signature",
    SignatureVersion: "2",
    SigningCertURL: signingCertUrl,
    Timestamp: "2026-07-08T00:00:00.000Z",
    TopicArn: topicArn,
    Type: "Notification",
    ...overrides,
  };
}
