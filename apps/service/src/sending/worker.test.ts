import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import { Database } from "../services/database.ts";
import { fakeEmailTransportLayer, fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { runTest } from "../testing/layers.ts";
import { runSendWorkerOnce } from "./worker.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

describe("send worker", () => {
  it("processes due send_delivery jobs through the queue runner", async () => {
    const fake = fakeEmailTransportLayer();

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing({
          html: "<p>Hello</p>",
          listId: null,
          name: null,
          purpose: "transactional",
          recipients: [{ email: "user@example.com", varsJson: null }],
          scheduledAt: null,
          subject: "Hello",
          text: null,
        });

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });
        const db = yield* Database;

        return {
          delivery: yield* db.get("assert:delivery", "SELECT status FROM deliveries;"),
          job: yield* db.get("assert:job", "SELECT state FROM jobs;"),
          result,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.result.succeeded).toBe(1);
    expect(outcome.delivery).toEqual({ status: "sent" });
    expect(outcome.job).toEqual({ state: "succeeded" });
    expect(fake.state.sent).toHaveLength(1);
  });

  it("does not process future jobs", async () => {
    const fake = fakeEmailTransportLayer();

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing({
          html: "<p>Hello</p>",
          listId: null,
          name: null,
          purpose: "transactional",
          recipients: [{ email: "future@example.com", varsJson: null }],
          scheduledAt: "2026-07-03T13:00:00.000Z",
          subject: "Hello",
          text: null,
        });

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });
        const db = yield* Database;

        return {
          job: yield* db.get("assert:job", "SELECT state FROM jobs;"),
          result,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.result.claimed).toBe(0);
    expect(outcome.job).toEqual({ state: "queued" });
    expect(fake.state.sent).toHaveLength(0);
  });
});
