import { Effect, Exit, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { fakeEmailTransportLayer, fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { runTest } from "../testing/layers.ts";
import { runSesSimulator } from "./simulator.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

describe("runSesSimulator", () => {
  it("finalizes simulator runs as failed when create mailing fails with a typed error", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const db = yield* Database;
        yield* db.run(
          "test:suppression",
          `INSERT INTO suppressions (id, email, scope, reason, created_at)
           VALUES ('suppression_1', 'bounce@simulator.amazonses.com', 'all', 'manual', '2026-07-03T12:00:00.000Z');`,
        );

        const exit = yield* Effect.exit(
          runSesSimulator({
            mode: "send_acceptance",
            purpose: "transactional",
            scenario: "bounce",
            targetBaseUrl: null,
            timeoutMs: 0,
            workerId: "worker_1",
          }),
        );
        const run = yield* db.get<{
          errorMessage: string | null;
          finishedAt: string | null;
          status: string;
        }>(
          "test:simulator-run",
          "SELECT status, error_message AS errorMessage, finished_at AS finishedAt FROM ses_simulator_runs LIMIT 1;",
        );
        return { exit, run };
      }).pipe(
        Effect.provide(Layer.mergeAll(fakeEmailTransportLayer().layer, fakeSendingConfigLayer())),
      ),
      { ids: ["run_1"] },
    );

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.run).toMatchObject({ status: "failed" });
    expect(result.run?.errorMessage).toContain("Mailing has no sendable recipients");
    expect(result.run?.finishedAt).toBe("2026-07-03T12:00:00.000Z");
  });

  it("records timeout status with finished_at", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const runResult = yield* runSesSimulator({
          mode: "end_to_end",
          purpose: "transactional",
          scenario: "success",
          targetBaseUrl: null,
          timeoutMs: 0,
          workerId: "worker_1",
        });
        const db = yield* Database;
        const run = yield* db.get(
          "test:simulator-run",
          "SELECT status, finished_at AS finishedAt FROM ses_simulator_runs WHERE id = $id;",
          { id: runResult.runId },
        );
        return { run, runResult };
      }).pipe(
        Effect.provide(Layer.mergeAll(fakeEmailTransportLayer().layer, fakeSendingConfigLayer())),
      ),
      { ids: ["run_1", "mailing_1", "delivery_1", "job_1"] },
    );

    expect(result.runResult.status).toBe("timed_out");
    expect(result.run).toEqual({ finishedAt: "2026-07-03T12:00:00.000Z", status: "timed_out" });
  });

  it("records send acceptance success as sent", async () => {
    const fake = fakeEmailTransportLayer();
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const runResult = yield* runSesSimulator({
          mode: "send_acceptance",
          purpose: "transactional",
          scenario: "success",
          targetBaseUrl: null,
          timeoutMs: 1000,
          workerId: "worker_1",
        });
        const db = yield* Database;
        const run = yield* db.get(
          "test:simulator-run",
          "SELECT status, mailing_id AS mailingId, delivery_id AS deliveryId, finished_at AS finishedAt FROM ses_simulator_runs WHERE id = $id;",
          { id: runResult.runId },
        );
        return { run, runResult };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
      { ids: ["run_1", "mailing_1", "delivery_1", "job_1", "attempt_1"] },
    );

    expect(result.runResult.status).toBe("sent");
    expect(result.run).toEqual({
      deliveryId: "delivery_1",
      finishedAt: "2026-07-03T12:00:00.000Z",
      mailingId: "mailing_1",
      status: "sent",
    });
    expect(fake.state.sent).toHaveLength(1);
  });
});
