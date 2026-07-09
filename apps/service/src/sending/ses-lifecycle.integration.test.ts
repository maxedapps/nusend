import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { runSendWorkerOnce } from "../queue/runner.ts";
import { Database } from "../services/database.ts";
import { fakeEmailTransportLayer, fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { fakeUnsubscribeConfig, type TestRuntime, withTestApp } from "../testing/layers.ts";
import type { VerifiedSnsEnvelope } from "../ses/sns-schema.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");
const topicArn = "arn:aws:sns:us-east-1:123456789012:nusend-test";
const jsonHeaders = { "content-type": "application/json", "x-api-key": "valid" };
const auth = {
  apiKeyPermissions: {
    contacts: ["read", "write"],
    lists: ["read", "write"],
    mailings: ["create"],
    operations: ["read"],
    suppressions: ["read"],
  },
};

describe("SES lifecycle integration", () => {
  it("records a worker-produced SES bounce and suppresses future sends", async () => {
    const fake = fakeEmailTransportLayer();

    await withTestApp(
      {
        auth,
        snsVerifier: (message) =>
          Effect.succeed(JSON.parse(String(message)) as VerifiedSnsEnvelope),
        unsubscribe: Option.some(fakeUnsubscribeConfig()),
      },
      async (app, runtime) => {
        await runtime.runPromise(TestClock.setTime(fixedTime));

        const contact = await postJson<{ contact: { id: string } }>(app, "/api/contacts", {
          email: "user@example.com",
        });
        expect(contact.response.status).toBe(201);

        const list = await postJson<{ list: { id: string } }>(app, "/api/lists", {
          name: "Customers",
        });
        expect(list.response.status).toBe(201);

        const importResponse = await postJson(app, `/api/lists/${list.body.list.id}/contacts`, {
          contacts: [{ email: "user@example.com" }],
        });
        expect(importResponse.response.status).toBe(200);

        const mailing = await postJson<{ mailing: { id: string } }>(app, "/api/mailings", {
          html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
          listId: list.body.list.id,
          purpose: "marketing",
          subject: "Marketing",
        });
        expect(mailing.response.status).toBe(201);

        const workerResult = await runtime.runPromise(
          runSendWorkerOnce({ workerId: "worker_1" }).pipe(
            Effect.provide(
              Layer.mergeAll(
                fake.layer,
                fakeSendingConfigLayer({ marketingConfigurationSet: "marketing-set" }),
              ),
            ),
          ),
        );
        expect(workerResult).toMatchObject({ claimed: 1, skippedStale: 0, succeeded: 1 });

        expect(fake.state.sent).toHaveLength(1);
        const sent = fake.state.sent[0];
        expect(sent.tags).toMatchObject({
          mailing_id: mailing.body.mailing.id,
          purpose: "marketing",
        });
        expect(sent.tags.delivery_id).toEqual(expect.any(String));

        const sentDelivery = await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.get<{ sesMessageId: string }>(
              "test:sent-delivery-message-id",
              "SELECT ses_message_id AS sesMessageId FROM deliveries WHERE id = $deliveryId;",
              { deliveryId: sent.tags.delivery_id },
            ),
          ),
        );
        expect(sentDelivery?.sesMessageId).toBe("fake-message-1");

        const bounce = await app.fetch(
          new Request("http://localhost/api/webhooks/aws/sns/ses", {
            body: JSON.stringify(
              bounceNotification({
                deliveryId: sent.tags.delivery_id,
                mailingId: mailing.body.mailing.id,
                sesMessageId: "fake-message-1",
              }),
            ),
            method: "POST",
          }),
        );
        expect(bounce.status).toBe(204);

        const events = await app.fetch(
          new Request("http://localhost/api/operations/ses/events", {
            headers: { "x-api-key": "valid" },
          }),
        );
        expect(events.status).toBe(200);
        const eventsBody = (await events.json()) as { items: unknown[] };
        expect(eventsBody.items).toEqual([
          expect.objectContaining({
            actionTaken: "suppressed",
            deliveryId: sent.tags.delivery_id,
            eventType: "Bounce",
            mailingId: mailing.body.mailing.id,
            recipientEmail: "user@example.com",
            sesMessageId: "fake-message-1",
          }),
        ]);
        expect(JSON.stringify(eventsBody)).not.toContain("RAW_JSON_SENTINEL");

        const suppressions = await app.fetch(
          new Request("http://localhost/api/suppressions?email=user%40example.com", {
            headers: { "x-api-key": "valid" },
          }),
        );
        expect(suppressions.status).toBe(200);
        await expect(suppressions.json()).resolves.toMatchObject({
          items: [{ email: "user@example.com", reason: "bounce", scope: "all" }],
        });

        const countsBeforeSecondMailing = await deliveryAndJobCounts(runtime);
        const secondMailing = await postJson(app, "/api/mailings", {
          html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
          listId: list.body.list.id,
          purpose: "marketing",
          subject: "Marketing again",
        });

        expect(secondMailing.response.status).toBe(422);
        expect(secondMailing.body).toEqual({
          error: {
            code: "empty_recipient_set",
            message: "Mailing has no sendable recipients after suppression checks.",
          },
        });
        await expect(deliveryAndJobCounts(runtime)).resolves.toEqual(countsBeforeSecondMailing);
      },
    );
  });
});

async function postJson<T = unknown>(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  path: string,
  body: unknown,
): Promise<{ readonly body: T; readonly response: Response }> {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      body: JSON.stringify(body),
      headers: jsonHeaders,
      method: "POST",
    }),
  );
  return { body: (await response.json()) as T, response };
}

function bounceNotification(input: {
  readonly deliveryId: string;
  readonly mailingId: string;
  readonly sesMessageId: string;
}): VerifiedSnsEnvelope & { readonly RawJsonSentinel: string } {
  return {
    Message: JSON.stringify({
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "user@example.com" }],
        timestamp: "2026-07-03T12:01:00.000Z",
      },
      eventType: "Bounce",
      mail: {
        destination: ["user@example.com"],
        messageId: input.sesMessageId,
        tags: { delivery_id: [input.deliveryId], mailing_id: [input.mailingId] },
        timestamp: "2026-07-03T12:00:00.000Z",
      },
      rawAuditSentinel: "RAW_JSON_SENTINEL",
    }),
    MessageId: "sns_bounce_lifecycle",
    RawJsonSentinel: "RAW_JSON_SENTINEL",
    Signature: "signature",
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    Timestamp: "2026-07-03T12:01:00.000Z",
    TopicArn: topicArn,
    Type: "Notification",
  };
}

async function deliveryAndJobCounts(runtime: TestRuntime) {
  return runtime.runPromise(
    Effect.flatMap(Database, (db) =>
      Effect.all({
        deliveries: db.get<{ count: number }>(
          "test:count-deliveries",
          "SELECT count(*) AS count FROM deliveries;",
        ),
        jobs: db.get<{ count: number }>("test:count-jobs", "SELECT count(*) AS count FROM jobs;"),
      }),
    ).pipe(
      Effect.map(({ deliveries, jobs }) => ({
        deliveries: deliveries?.count ?? 0,
        jobs: jobs?.count ?? 0,
      })),
    ),
  );
}
