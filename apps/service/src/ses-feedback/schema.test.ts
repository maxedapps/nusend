import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeSesEvent } from "./ses-event-schema.ts";
import { decodeUnverifiedSnsEnvelopeString } from "./sns-schema.ts";

const signingCertUrl = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem";

describe("SES feedback schemas", () => {
  it("decodes SNS envelopes with subscription Token and unknown extra fields", async () => {
    const decoded = await Effect.runPromise(
      decodeUnverifiedSnsEnvelopeString(
        JSON.stringify({
          ExtraField: "ignored",
          Message: "Confirm subscription.",
          MessageId: "sns-message-1",
          Signature: "signature",
          SignatureVersion: "2",
          SigningCertURL: signingCertUrl,
          SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
          Timestamp: "2026-07-08T00:00:00.000Z",
          Token: "token-1",
          TopicArn: "arn:aws:sns:us-east-1:123456789012:nusend-test",
          Type: "SubscriptionConfirmation",
        }),
      ),
    );

    expect(decoded.Token).toBe("token-1");
    expect(decoded.Type).toBe("SubscriptionConfirmation");
  });

  it("decodes representative SES bounce, complaint, delay, reject, delivery, and unknown events", async () => {
    await expect(
      decode({
        bounce: {
          bounceSubType: "General",
          bounceType: "Permanent",
          bouncedRecipients: [{ diagnosticCode: "smtp; 550", emailAddress: "bounce@example.com" }],
          feedbackId: "bounce-feedback",
        },
        eventType: "Bounce",
      }),
    ).resolves.toMatchObject({ bounce: { bounceType: "Permanent" }, eventType: "Bounce" });

    await expect(
      decode({
        complaint: {
          complainedRecipients: [{ emailAddress: "complaint@example.com" }],
          complaintFeedbackType: "not-spam",
          feedbackId: "complaint-feedback",
        },
        eventType: "Complaint",
      }),
    ).resolves.toMatchObject({
      complaint: { complaintFeedbackType: "not-spam" },
      eventType: "Complaint",
    });

    await expect(
      decode({
        deliveryDelay: {
          delayedRecipients: [{ diagnosticCode: "smtp; 4.4.7", emailAddress: "delay@example.com" }],
        },
        eventType: "DeliveryDelay",
      }),
    ).resolves.toMatchObject({ eventType: "DeliveryDelay" });

    await expect(
      decode({ eventType: "Reject", reject: { reason: "Bad content" } }),
    ).resolves.toMatchObject({ eventType: "Reject", reject: { reason: "Bad content" } });

    await expect(
      decode({ delivery: { recipients: ["delivered@example.com"] }, eventType: "Delivery" }),
    ).resolves.toMatchObject({ delivery: { recipients: ["delivered@example.com"] } });

    await expect(
      decode({ eventType: "Rendering Failure", unknown: { nested: true } }),
    ).resolves.toMatchObject({ eventType: "Rendering Failure" });
  });
});

function decode(overrides: Record<string, unknown>) {
  return Effect.runPromise(
    decodeSesEvent(
      JSON.stringify({
        mail: {
          destination: ["user@example.com"],
          messageId: "ses-message-1",
          tags: { delivery_id: ["delivery_1"], mailing_id: ["mailing_1"] },
        },
        ...overrides,
      }),
    ),
  );
}
