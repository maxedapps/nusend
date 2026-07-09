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

  it("persists once runs but skips repeated idle loop runs until heartbeat interval", async () => {
    const fake = fakeEmailTransportLayer();

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* runSendWorkerOnce({ mode: "once", workerId: "worker_1" });
        yield* runSendWorkerOnce({ mode: "loop", workerId: "worker_1" });
        yield* TestClock.setTime(fixedTime + 60_000);
        yield* runSendWorkerOnce({ mode: "loop", workerId: "worker_1" });
        yield* TestClock.setTime(fixedTime + 301_000);
        yield* runSendWorkerOnce({ mode: "loop", workerId: "worker_1" });

        const db = yield* Database;
        return yield* db.all(
          "assert:worker-runs",
          "SELECT mode, claimed, finished_at AS finishedAt FROM worker_runs ORDER BY finished_at ASC, id ASC;",
        );
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome).toEqual([
      { claimed: 0, finishedAt: "2026-07-03T12:00:00.000Z", mode: "once" },
      { claimed: 0, finishedAt: "2026-07-03T12:00:00.000Z", mode: "loop" },
      { claimed: 0, finishedAt: "2026-07-03T12:05:01.000Z", mode: "loop" },
    ]);
  });

  it("persists non-idle loop runs and prunes old worker runs", async () => {
    const fake = fakeEmailTransportLayer();

    const outcome = await runTest(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.run(
          "test:old-worker-run",
          `INSERT INTO worker_runs (
             id, worker_id, mode, released, claimed, succeeded, failed, dead, skipped_stale,
             started_at, finished_at
           ) VALUES (
             'old_run', 'worker_1', 'loop', 0, 0, 0, 0, 0, 0,
             '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
           );`,
        );
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
        yield* TestClock.setTime(Date.parse("2026-07-10T00:00:00.000Z"));
        yield* runSendWorkerOnce({ mode: "loop", workerId: "worker_1" });

        return yield* db.all(
          "assert:worker-runs",
          "SELECT id, mode, claimed, succeeded FROM worker_runs ORDER BY id ASC;",
        );
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome).toEqual([{ claimed: 1, id: "id_5", mode: "loop", succeeded: 1 }]);
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
