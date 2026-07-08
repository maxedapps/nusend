import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { runSendWorkerOnce } from "../queue/runner.ts";
import { Database } from "../services/database.ts";
import { fakeEmailTransportLayer, fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { withTestApp } from "../testing/layers.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

const auth = {
  apiKeyPermissions: { mailings: ["create"], operations: ["read"] },
};

const jsonHeaders = {
  "content-type": "application/json",
  "x-api-key": "valid",
};

describe("fake email workflow", () => {
  it("creates a mailing, processes it with the fake worker, and exposes operations state", async () => {
    const fake = fakeEmailTransportLayer();

    await withTestApp({ auth }, async (app, runtime) => {
      await runtime.runPromise(TestClock.setTime(fixedTime));

      const createResponse = await app.fetch(
        new Request("http://localhost/api/mailings", {
          body: JSON.stringify({
            html: "<p>Hello {{ vars.firstName }}</p>",
            purpose: "transactional",
            recipients: [{ email: "user@example.com", vars: { firstName: "Max" } }],
            subject: "Hello {{ user.email }}",
            text: "Hi {{ vars.firstName }}",
          }),
          headers: jsonHeaders,
          method: "POST",
        }),
      );

      expect(createResponse.status).toBe(201);
      const createBody = (await createResponse.json()) as {
        counts: unknown;
        mailing: { id: string; purpose: string; state: string };
      };
      expect(createBody).toMatchObject({
        counts: { deliveries: 1, queued: 1, suppressed: 0 },
        mailing: { purpose: "transactional", state: "scheduled" },
      });

      const delivery = await runtime.runPromise(
        Effect.flatMap(Database, (db) =>
          db.get<{ id: string }>(
            "test:delivery-id",
            "SELECT id FROM deliveries WHERE mailing_id = $mailingId;",
            { mailingId: createBody.mailing.id },
          ),
        ),
      );
      expect(delivery).not.toBeNull();
      const deliveryId = delivery?.id ?? "missing-delivery";

      const workerResult = await runtime.runPromise(
        runSendWorkerOnce({ workerId: "worker_1" }).pipe(
          Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer())),
        ),
      );

      expect(workerResult).toEqual({
        claimed: 1,
        dead: 0,
        failed: 0,
        released: 0,
        skippedStale: 0,
        succeeded: 1,
      });
      expect(fake.state.sent).toEqual([
        expect.objectContaining({
          configurationSetName: "txn-config",
          from: "sender@example.com",
          html: "<p>Hello Max</p>",
          subject: "Hello user@example.com",
          tags: {
            delivery_id: deliveryId,
            mailing_id: createBody.mailing.id,
            purpose: "transactional",
          },
          text: "Hi Max",
          to: "user@example.com",
        }),
      ]);

      const summaryResponse = await app.fetch(
        new Request("http://localhost/api/operations/summary", {
          headers: { "x-api-key": "valid" },
        }),
      );
      expect(summaryResponse.status).toBe(200);
      await expect(summaryResponse.json()).resolves.toMatchObject({
        deliveries: { sent: 1 },
        jobs: { succeeded: 1 },
        recentIssues: [],
        sendAttempts: { succeeded: 1 },
      });

      const detailResponse = await app.fetch(
        new Request(`http://localhost/api/operations/deliveries/${deliveryId}`, {
          headers: { "x-api-key": "valid" },
        }),
      );
      expect(detailResponse.status).toBe(200);
      await expect(detailResponse.json()).resolves.toMatchObject({
        attempts: [{ sesMessageId: "fake-message-1", status: "succeeded" }],
        delivery: { id: deliveryId, sesMessageId: "fake-message-1", status: "sent" },
        job: { state: "succeeded" },
        mailing: { id: createBody.mailing.id, state: "completed" },
      });
    });
  });
});
