import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import {
  fakeSesOperationsConfig,
  type CapturedLog,
  type TestRuntime,
  withTestApp,
} from "../testing/layers.ts";
import { maxSesWebhookBodyBytes } from "./webhook-routes.ts";
import type { VerifiedSnsEnvelope } from "./sns-schema.ts";

const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";
const secondTopicArn = "arn:aws:sns:us-east-1:123456789012:nusend-second";
const webhookUrl = "http://localhost/api/webhooks/aws/sns/ses";

describe("SES webhook routes", () => {
  it("returns 204 for valid verified notifications with safe high-level logs", async () => {
    const logs: CapturedLog[] = [];
    await withTestApp(
      {
        logSink: logs,
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
        const serialized = JSON.stringify(logs.map((entry) => entry.message));
        expect(serialized).toContain("ses sns message verified");
        expect(serialized).toContain("ses notification inserted");
        expect(serialized).toContain('"snsType":"Notification"');
        for (const sensitive of [
          "user@example.com",
          '"destination"',
          '"delivery"',
          '"Message"',
          "unsubscribe-token",
          "api-key",
          "cookie",
        ]) {
          expect(serialized).not.toContain(sensitive);
        }
      },
    );
  });

  it("ingests unique notifications from two independently allowlisted topics", async () => {
    await withTestApp(
      {
        sesOperations: fakeSesOperationsConfig({
          feedbackTopicArns: [topicArn, secondTopicArn],
        }),
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app, runtime) => {
        for (const [messageId, arn] of [
          ["sns_topic_1", topicArn],
          ["sns_topic_2", secondTopicArn],
        ] as const) {
          const response = await app.fetch(
            new Request(webhookUrl, {
              body: JSON.stringify(notification(messageId, { TopicArn: arn })),
              method: "POST",
            }),
          );
          expect(response.status).toBe(204);
        }

        const rows = await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.all<{ topicArn: string }>(
              "test:topics",
              "SELECT sns_topic_arn AS topicArn FROM ses_notifications ORDER BY sns_topic_arn ASC;",
            ),
          ),
        );
        expect(rows).toEqual([{ topicArn: secondTopicArn }, { topicArn }]);
        await expect(countRows(runtime)).resolves.toEqual({ events: 2, notifications: 2 });
      },
    );
  });

  it("audits verified UnsubscribeConfirmation once without confirming or creating SES events", async () => {
    const confirmerCalls: string[] = [];
    await withTestApp(
      {
        snsConfirmerCalls: confirmerCalls,
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app, runtime) => {
        const body = JSON.stringify(unsubscribeConfirmation("sns_unsubscribe_1"));
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await app.fetch(new Request(webhookUrl, { body, method: "POST" }));
          expect(response.status).toBe(204);
        }
        await expect(countRows(runtime)).resolves.toEqual({ events: 0, notifications: 1 });
        expect(confirmerCalls).toEqual([]);
      },
    );
  });

  it("returns an empty 400 for malformed outer SNS", async () => {
    await withTestApp(
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app) => {
        const response = await app.fetch(new Request(webhookUrl, { method: "POST", body: "{}" }));
        expect(response.status).toBe(400);
        expect(await response.text()).toBe("");
      },
    );
  });

  it("audits verified malformed SES before returning 400", async () => {
    await withTestApp(
      {
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request(webhookUrl, {
            method: "POST",
            body: JSON.stringify({ ...notification("sns_bad"), Message: "{}" }),
          }),
        );
        expect(response.status).toBe(400);
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

  it("maps verifier failure to an empty 403", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(
        new Request(webhookUrl, { method: "POST", body: JSON.stringify(notification("sns_1")) }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
    });
  });

  it("maps disabled SES webhook config to an empty 404", async () => {
    await withTestApp(
      {
        sesOperations: fakeSesOperationsConfig({ feedbackTopicArns: [] }),
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app) => {
        const response = await app.fetch(
          new Request(webhookUrl, { method: "POST", body: JSON.stringify(notification("sns_1")) }),
        );
        expect(response.status).toBe(404);
        expect(await response.text()).toBe("");
      },
    );
  });

  it("maps an oversized webhook body to an empty 413", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(
        new Request(webhookUrl, { method: "POST", body: "x".repeat(maxSesWebhookBodyBytes + 1) }),
      );
      expect(response.status).toBe(413);
      expect(await response.text()).toBe("");
    });
  });

  it("returns empty 403 before verifier/cert work for non-allowlisted topics", async () => {
    let verifierCalls = 0;
    await withTestApp(
      {
        snsVerifier: (message) => {
          verifierCalls += 1;
          return Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope);
        },
      },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request(webhookUrl, {
            method: "POST",
            body: JSON.stringify(
              notification("sns_unallowed", {
                TopicArn: "arn:aws:sns:us-east-1:123456789012:other-topic",
              }),
            ),
          }),
        );

        expect(response.status).toBe(403);
        expect(await response.text()).toBe("");
        expect(verifierCalls).toBe(0);
        await expect(countRows(runtime)).resolves.toEqual({ events: 0, notifications: 0 });
      },
    );
  });

  it("returns empty 500 for subscription confirmations without SubscribeURL", async () => {
    const calls: string[] = [];
    await withTestApp(
      {
        snsConfirmerCalls: calls,
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
      },
      async (app, runtime) => {
        const response = await app.fetch(
          new Request(webhookUrl, {
            method: "POST",
            body: JSON.stringify({
              ...subscriptionConfirmation("sns_missing_subscribe_url"),
              SubscribeURL: undefined,
            }),
          }),
        );

        expect(response.status).toBe(500);
        expect(await response.text()).toBe("");
        expect(calls).toEqual([]);
        await expect(countRows(runtime)).resolves.toEqual({ events: 0, notifications: 0 });
      },
    );
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

function notification(
  messageId: string,
  overrides: Partial<VerifiedSnsEnvelope> = {},
): VerifiedSnsEnvelope {
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
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    Timestamp: "2026-07-03T12:00:00.000Z",
    TopicArn: topicArn,
    Type: "Notification",
    ...overrides,
  };
}

async function countRows(runtime: TestRuntime): Promise<{
  readonly events: number;
  readonly notifications: number;
}> {
  return runtime.runPromise(
    Effect.flatMap(Database, (db) =>
      Effect.all({
        events: db.get<{ count: number }>(
          "test:count-events",
          "SELECT count(*) AS count FROM ses_events;",
        ),
        notifications: db.get<{ count: number }>(
          "test:count-notifications",
          "SELECT count(*) AS count FROM ses_notifications;",
        ),
      }),
    ).pipe(
      Effect.map(({ events, notifications }) => ({
        events: events?.count ?? 0,
        notifications: notifications?.count ?? 0,
      })),
    ),
  );
}

function unsubscribeConfirmation(messageId: string): VerifiedSnsEnvelope {
  return {
    Message: "subscription removed",
    MessageId: messageId,
    Signature: "signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    Timestamp: "2026-07-03T12:00:00.000Z",
    TopicArn: topicArn,
    Type: "UnsubscribeConfirmation",
  };
}

function subscriptionConfirmation(messageId: string): VerifiedSnsEnvelope {
  return {
    Message: "subscription",
    MessageId: messageId,
    Signature: "signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    Timestamp: "2026-07-03T12:00:00.000Z",
    TopicArn: topicArn,
    Type: "SubscriptionConfirmation",
  };
}
