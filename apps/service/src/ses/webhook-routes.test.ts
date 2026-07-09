import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { fakeSesOperationsConfig, withTestApp } from "../testing/layers.ts";
import { maxSesWebhookBodyBytes } from "./webhook-routes.ts";
import type { VerifiedSnsEnvelope } from "./sns-schema.ts";

const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";
const webhookUrl = "http://localhost/api/webhooks/aws/sns/ses";

describe("SES webhook routes", () => {
  it("returns 204 for valid verified notifications", async () => {
    await withTestApp(
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request(webhookUrl, { method: "POST", body: JSON.stringify(notification("sns_1")) }),
        );

        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
        const stored = await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.get<{ count: number }>(
              "test:count-events",
              "SELECT count(*) AS count FROM ses_events;",
            ),
          ),
        );
        expect(stored).toEqual({ count: 1 });
      },
    );
  });

  it("returns 400 for malformed SNS or malformed SES events", async () => {
    await withTestApp(
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app, runtime) => {
        const malformedSns = await app.fetch(
          new Request(webhookUrl, { method: "POST", body: "{}" }),
        );
        expect(malformedSns.status).toBe(400);
        expect(await malformedSns.text()).toBe("");

        const malformedSes = await app.fetch(
          new Request(webhookUrl, {
            method: "POST",
            body: JSON.stringify({ ...notification("sns_bad"), Message: "{}" }),
          }),
        );
        expect(malformedSes.status).toBe(400);
        const stored = await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.get<{ count: number }>(
              "test:count-notifications",
              "SELECT count(*) AS count FROM ses_notifications WHERE sns_message_id = 'sns_bad';",
            ),
          ),
        );
        expect(stored).toEqual({ count: 1 });
      },
    );
  });

  it("maps verification failure, disabled config, and body limit to empty status responses", async () => {
    await withTestApp({}, async (app) => {
      const forbidden = await app.fetch(
        new Request(webhookUrl, { method: "POST", body: JSON.stringify(notification("sns_1")) }),
      );
      expect(forbidden.status).toBe(403);
      expect(await forbidden.text()).toBe("");
    });

    await withTestApp(
      {
        sesOperations: fakeSesOperationsConfig({ feedbackTopicArns: [] }),
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app) => {
        const disabled = await app.fetch(
          new Request(webhookUrl, { method: "POST", body: JSON.stringify(notification("sns_1")) }),
        );
        expect(disabled.status).toBe(404);
        expect(await disabled.text()).toBe("");
      },
    );

    await withTestApp({}, async (app) => {
      const tooLarge = await app.fetch(
        new Request(webhookUrl, { method: "POST", body: "x".repeat(maxSesWebhookBodyBytes + 1) }),
      );
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.text()).toBe("");
    });
  });

  it("confirms subscriptions and handles duplicate confirmation idempotently", async () => {
    const calls: string[] = [];
    const envelope = subscriptionConfirmation("sns_sub");
    await withTestApp(
      {
        snsConfirmerCalls: calls,
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app, runtime) => {
        const first = await app.fetch(
          new Request(webhookUrl, { method: "POST", body: JSON.stringify(envelope) }),
        );
        const second = await app.fetch(
          new Request(webhookUrl, { method: "POST", body: JSON.stringify(envelope) }),
        );

        expect(first.status).toBe(204);
        expect(second.status).toBe(204);
        expect(calls).toEqual([envelope.SubscribeURL, envelope.SubscribeURL]);
        const stored = await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.get<{ count: number }>(
              "test:count-subscriptions",
              "SELECT count(*) AS count FROM ses_notifications WHERE sns_message_id = 'sns_sub';",
            ),
          ),
        );
        expect(stored).toEqual({ count: 1 });
      },
    );
  });
});

function notification(messageId: string): VerifiedSnsEnvelope {
  return {
    Message: JSON.stringify({
      eventType: "Delivery",
      mail: {
        destination: ["user@example.com"],
        messageId: "ses_1",
        timestamp: "2026-07-03T12:00:00.000Z",
      },
      delivery: { recipients: ["user@example.com"] },
    }),
    MessageId: messageId,
    Signature: "signature",
    SignatureVersion: "1",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    Timestamp: "2026-07-03T12:00:00.000Z",
    TopicArn: topicArn,
    Type: "Notification",
  };
}

function subscriptionConfirmation(messageId: string): VerifiedSnsEnvelope {
  return {
    Message: "subscription",
    MessageId: messageId,
    Signature: "signature",
    SignatureVersion: "1",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    Timestamp: "2026-07-03T12:00:00.000Z",
    TopicArn: topicArn,
    Type: "SubscriptionConfirmation",
  };
}
