import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { fakeSesFeedbackConfig, withTestApp } from "../testing/layers.ts";
import { SnsVerificationError } from "./errors.ts";
import { maxSesFeedbackWebhookBodyBytes } from "./routes.ts";
import type { VerifiedSnsEnvelope } from "./sns-schema.ts";

const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";

function envelope(overrides: Partial<VerifiedSnsEnvelope> = {}): VerifiedSnsEnvelope {
  return {
    Message: JSON.stringify({
      eventType: "Rendering Failure",
      mail: { destination: ["user@example.com"], messageId: "ses-message-1", tags: {} },
    }),
    MessageId: "sns-message-1",
    Signature: "signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
    Timestamp: "2026-07-08T00:00:00.000Z",
    TopicArn: topicArn,
    Type: "Notification",
    ...overrides,
  };
}

describe("SES feedback SNS webhook route", () => {
  it("returns 404 when feedback ingestion is disabled", async () => {
    await withTestApp({}, async (app) => {
      const body = JSON.stringify(envelope());
      const response = await app.fetch(
        new Request("http://localhost/api/webhooks/aws/sns/ses", { body, method: "POST" }),
      );

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("");
    });
  });

  it("accepts text/plain SNS notifications and returns 204", async () => {
    const verified = envelope();
    await withTestApp(
      {
        sesFeedback: Option.some(fakeSesFeedbackConfig()),
        snsVerifier: () => Effect.succeed(verified),
      },
      async (app) => {
        const response = await app.fetch(
          new Request("http://localhost/api/webhooks/aws/sns/ses", {
            body: JSON.stringify(verified),
            headers: { "content-type": "text/plain; charset=UTF-8" },
            method: "POST",
          }),
        );

        expect(response.status).toBe(204);
        await expect(response.text()).resolves.toBe("");
      },
    );
  });

  it("accepts bodies near the SNS payload limit when under 512 KiB", async () => {
    const verified = envelope({
      Message: JSON.stringify({
        eventType: "Rendering Failure",
        mail: {
          destination: ["user@example.com"],
          messageId: "ses-message-large",
          tags: { large: ["x".repeat(256 * 1024)] },
        },
      }),
      MessageId: "sns-large",
    });

    await withTestApp(
      {
        sesFeedback: Option.some(fakeSesFeedbackConfig()),
        snsVerifier: () => Effect.succeed(verified),
      },
      async (app) => {
        const response = await app.fetch(
          new Request("http://localhost/api/webhooks/aws/sns/ses", {
            body: JSON.stringify(verified),
            method: "POST",
          }),
        );

        expect(response.status).toBe(204);
      },
    );
  });

  it("rejects oversized bodies", async () => {
    await withTestApp({ sesFeedback: Option.some(fakeSesFeedbackConfig()) }, async (app) => {
      const response = await app.fetch(
        new Request("http://localhost/api/webhooks/aws/sns/ses", {
          body: "x".repeat(maxSesFeedbackWebhookBodyBytes + 1),
          method: "POST",
        }),
      );

      expect(response.status).toBe(413);
    });
  });

  it("maps verifier failures to 403 and transient DB failures to 500", async () => {
    const verified = envelope();

    await withTestApp(
      {
        sesFeedback: Option.some(fakeSesFeedbackConfig()),
        snsVerifier: () => Effect.fail(new SnsVerificationError({ reason: "bad signature" })),
      },
      async (app) => {
        const response = await app.fetch(
          new Request("http://localhost/api/webhooks/aws/sns/ses", {
            body: JSON.stringify(verified),
            method: "POST",
          }),
        );
        expect(response.status).toBe(403);
        await expect(response.text()).resolves.toBe("");
      },
    );

    await withTestApp(
      {
        migrate: false,
        sesFeedback: Option.some(fakeSesFeedbackConfig()),
        snsVerifier: () => Effect.succeed(verified),
      },
      async (app) => {
        const response = await app.fetch(
          new Request("http://localhost/api/webhooks/aws/sns/ses", {
            body: JSON.stringify(verified),
            method: "POST",
          }),
        );
        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toBe("");
      },
    );
  });

  it("maps malformed payloads to 400 and forbidden topics to 403", async () => {
    await withTestApp({ sesFeedback: Option.some(fakeSesFeedbackConfig()) }, async (app) => {
      const malformed = await app.fetch(
        new Request("http://localhost/api/webhooks/aws/sns/ses", {
          body: "not-json",
          method: "POST",
        }),
      );
      expect(malformed.status).toBe(400);
    });

    const verified = envelope({ TopicArn: "arn:aws:sns:us-east-1:123456789012:other" });
    await withTestApp(
      {
        sesFeedback: Option.some(fakeSesFeedbackConfig()),
        snsVerifier: () => Effect.succeed(verified),
      },
      async (app) => {
        const forbidden = await app.fetch(
          new Request("http://localhost/api/webhooks/aws/sns/ses", {
            body: JSON.stringify(verified),
            method: "POST",
          }),
        );
        expect(forbidden.status).toBe(403);
      },
    );
  });
});
