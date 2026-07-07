// Scenario assertion values are ported 1:1 from the pre-Effect bun-scenario
// bodies — all five counter paths (succeeded / failed / dead / stale-complete /
// stale-fail) stay covered.
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { runTest, steppingClockLayer } from "../testing/layers.ts";
import { seedJob } from "../testing/queue-fixtures.ts";
import { drainOnce, runOnce } from "./runner.ts";

describe("queue runner", () => {
  it("completes jobs after a successful processor", async () => {
    const seen: Array<{ attempts: number; id: string; state: string }> = [];

    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "job_1" });

        const result = yield* runOnce({
          processJob: (job) =>
            Effect.gen(function* () {
              seen.push({ attempts: job.attempts, id: job.id, state: job.state });
              yield* TestClock.setTime(Date.parse("2026-07-03T12:00:01.000Z"));
            }),
          workerId: "worker_1",
        });

        const db = yield* Database;
        return {
          result,
          row: yield* db.get(
            "assert:row",
            "SELECT state, locked_by AS lockedBy FROM jobs WHERE id = 'job_1';",
          ),
        };
      }),
    );

    expect(seen).toEqual([{ attempts: 1, id: "job_1", state: "leased" }]);
    expect(outcome.result).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      released: 0,
      skippedStale: 0,
      succeeded: 1,
    });
    expect(outcome.row).toEqual({ lockedBy: null, state: "succeeded" });
  });

  it("requeues or dead-letters jobs when processors fail", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "retry" });
        yield* seedJob({ id: "dead", maxAttempts: 1 });

        const result = yield* runOnce({
          batchSize: 2,
          processJob: () => Effect.fail(new Error("send failed")),
          workerId: "worker_1",
        });

        const db = yield* Database;
        return {
          result,
          rows: yield* db.all(
            "assert:rows",
            "SELECT id, state, run_at AS runAt, last_error AS lastError FROM jobs ORDER BY id;",
          ),
        };
      }),
    );

    expect(outcome.result).toEqual({
      claimed: 2,
      dead: 1,
      failed: 1,
      released: 0,
      skippedStale: 0,
      succeeded: 0,
    });
    expect(outcome.rows).toEqual([
      { id: "dead", lastError: "send failed", runAt: "2026-07-03T11:00:00.000Z", state: "dead" },
      { id: "retry", lastError: "send failed", runAt: "2026-07-03T12:01:00.000Z", state: "queued" },
    ]);
  });

  it("releases expired leases before claiming jobs", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({
          attempts: 1,
          id: "expired",
          lockedBy: "old_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          state: "leased",
        });
        yield* seedJob({
          attempts: 1,
          id: "expired_dead",
          lockedBy: "old_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          maxAttempts: 1,
          state: "leased",
        });

        const result = yield* runOnce({
          processJob: () => Effect.void,
          workerId: "worker_1",
        });

        const db = yield* Database;
        return {
          result,
          row: yield* db.get(
            "assert:row",
            "SELECT state, run_at AS runAt, locked_by AS lockedBy FROM jobs WHERE id = 'expired';",
          ),
        };
      }),
    );

    expect(outcome.result).toEqual({
      claimed: 0,
      dead: 1,
      failed: 0,
      released: 2,
      skippedStale: 0,
      succeeded: 0,
    });
    expect(outcome.row).toEqual({
      lockedBy: null,
      runAt: "2026-07-03T12:01:00.000Z",
      state: "queued",
    });
  });

  it("does not crash when completion observes a stale lease", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "success_stale" });

        return yield* runOnce({
          processJob: (job) =>
            Effect.gen(function* () {
              const db = yield* Database;
              yield* db.run("steal-lease", "UPDATE jobs SET locked_by = 'other' WHERE id = $id;", {
                id: job.id,
              });
              yield* TestClock.setTime(Date.parse("2026-07-03T12:00:01.000Z"));
            }),
          workerId: "worker_1",
        });
      }),
    );

    expect(result.skippedStale).toBe(1);
  });

  it("does not crash when failure handling observes a stale lease", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "failure_stale" });

        return yield* runOnce({
          processJob: (job) =>
            Effect.gen(function* () {
              const db = yield* Database;
              yield* db.run("steal-lease", "UPDATE jobs SET locked_by = 'other' WHERE id = $id;", {
                id: job.id,
              });
              yield* TestClock.setTime(Date.parse("2026-07-03T12:00:01.000Z"));
              return yield* Effect.die(new Error("boom"));
            }),
          workerId: "worker_1",
        });
      }),
    );

    expect(result.skippedStale).toBe(1);
  });

  it("shares one clock snapshot for release + claim and reads a later one to complete", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* seedJob({ id: "due", runAt: "2026-07-03T11:00:00.000Z" });
        // Between the snapshot and any later clock read — must NOT be claimed.
        yield* seedJob({ id: "late", runAt: "2026-07-03T12:00:00.500Z" });
        yield* seedJob({
          attempts: 1,
          id: "expired",
          lockedBy: "old_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          state: "leased",
        });

        const result = yield* runOnce({
          kinds: ["send_delivery"],
          processJob: () => Effect.void,
          workerId: "worker_1",
        });

        const db = yield* Database;
        return {
          due: yield* db.get(
            "assert:due",
            "SELECT state, updated_at AS updatedAt FROM jobs WHERE id = 'due';",
          ),
          expired: yield* db.get(
            "assert:expired",
            "SELECT state, run_at AS runAt, updated_at AS updatedAt FROM jobs WHERE id = 'expired';",
          ),
          late: yield* db.get("assert:late", "SELECT state FROM jobs WHERE id = 'late';"),
          result,
        };
      }),
      // First read = the runOnce snapshot (release + claim); later reads = complete.
      { clock: steppingClockLayer(["2026-07-03T12:00:00.000Z", "2026-07-03T12:00:01.000Z"]) },
    );

    expect(outcome.result).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      released: 1,
      skippedStale: 0,
      succeeded: 1,
    });
    expect(outcome.late).toEqual({ state: "queued" });
    // Release used the snapshot: backoff (60s at attempt 1) counts from 12:00:00.000.
    expect(outcome.expired).toEqual({
      runAt: "2026-07-03T12:01:00.000Z",
      state: "queued",
      updatedAt: "2026-07-03T12:00:00.000Z",
    });
    // Completion read fresh, later time.
    expect(outcome.due).toEqual({ state: "succeeded", updatedAt: "2026-07-03T12:00:01.000Z" });
  });

  it("drains repeatedly until no due jobs remain", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "job_1" });
        yield* seedJob({ id: "job_2" });

        return yield* drainOnce({
          batchSize: 1,
          processJob: () => Effect.void,
          workerId: "worker_1",
        });
      }),
    );

    expect(result).toEqual({
      claimed: 2,
      dead: 0,
      failed: 0,
      iterations: 3,
      maxIterationsReached: false,
      released: 0,
      skippedStale: 0,
      succeeded: 2,
    });
  });
});
