// Scenario assertion values are ported 1:1 from the pre-Effect bun-scenario
// bodies — they are the golden fixtures for the frozen queue behavior (§8).
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { runTest } from "../testing/layers.ts";
import { seedJob } from "../testing/queue-fixtures.ts";
import {
  claimSendDeliveryJobs,
  completeSendDeliveryJob,
  failSendDeliveryJob,
  releaseExpiredSendDeliveryLeases,
} from "./jobs.ts";

describe("queue jobs", () => {
  it("claims due queued send-delivery jobs atomically with lease metadata and limit", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "future", runAt: "2026-07-03T12:10:00.000Z" });
        yield* seedJob({
          createdAt: "2026-07-03T11:59:01.000Z",
          id: "due_2",
          runAt: "2026-07-03T11:59:00.000Z",
        });
        yield* seedJob({
          id: "due_0",
          runAt: "2026-07-03T11:58:00.000Z",
        });
        yield* seedJob({
          createdAt: "2026-07-03T11:59:00.000Z",
          id: "due_1",
          runAt: "2026-07-03T11:59:00.000Z",
        });

        const claimed = yield* claimSendDeliveryJobs({
          leaseSeconds: 30,
          limit: 1,
          workerId: "worker_1",
        });

        const db = yield* Database;
        return {
          claimed,
          future: yield* db.get(
            "assert:future",
            "SELECT state, attempts, locked_by AS lockedBy, locked_until AS lockedUntil FROM jobs WHERE id = 'future';",
          ),
          rows: yield* db.all(
            "assert:rows",
            "SELECT id, state, attempts, locked_by AS lockedBy FROM jobs ORDER BY id;",
          ),
        };
      }),
    );

    expect(outcome.claimed.map((job) => job.id)).toEqual(["due_0"]);
    expect(outcome.claimed[0]).toEqual({
      attempts: 1,
      createdAt: "2026-07-03T11:00:00.000Z",
      id: "due_0",
      lastError: null,
      lockedBy: "worker_1",
      lockedUntil: "2026-07-03T12:00:30.000Z",
      maxAttempts: 10,
      deliveryId: "delivery_due_0",
      runAt: "2026-07-03T11:58:00.000Z",
      state: "leased",
      updatedAt: "2026-07-03T12:00:00.000Z",
    });
    expect(outcome.rows).toEqual([
      { attempts: 1, id: "due_0", lockedBy: "worker_1", state: "leased" },
      { attempts: 0, id: "due_1", lockedBy: null, state: "queued" },
      { attempts: 0, id: "due_2", lockedBy: null, state: "queued" },
      { attempts: 0, id: "future", lockedBy: null, state: "queued" },
    ]);
    expect(outcome.future).toEqual({
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
      state: "queued",
    });
  });

  it("does not claim terminal jobs", async () => {
    const claimed = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        for (const state of ["succeeded", "dead"]) {
          yield* seedJob({ id: state, state });
        }
        return yield* claimSendDeliveryJobs({ workerId: "worker_1" });
      }),
    );

    expect(claimed).toEqual([]);
  });

  it("completes only jobs leased by the owning worker", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "job_1" });
        yield* claimSendDeliveryJobs({ workerId: "worker_1" });

        yield* TestClock.setTime(Date.parse("2026-07-03T12:01:00.000Z"));
        const staleAttempt = yield* completeSendDeliveryJob({
          jobId: "job_1",
          workerId: "other",
        }).pipe(
          Effect.map(() => "unexpected success"),
          Effect.catchTag("JobNotLeasedError", (error) =>
            Effect.succeed(`not_leased:${error.jobId}`),
          ),
        );
        const completed = yield* completeSendDeliveryJob({ jobId: "job_1", workerId: "worker_1" });

        const db = yield* Database;
        return {
          completed,
          row: yield* db.get(
            "assert:row",
            "SELECT state, locked_by AS lockedBy, locked_until AS lockedUntil, last_error AS lastError FROM jobs WHERE id = 'job_1';",
          ),
          staleAttempt,
        };
      }),
    );

    expect(outcome.staleAttempt).toBe("not_leased:job_1");
    expect(outcome.completed.state).toBe("succeeded");
    expect(outcome.completed.lockedBy).toBeNull();
    expect(outcome.completed.lockedUntil).toBeNull();
    expect(outcome.row).toEqual({
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
      state: "succeeded",
    });
  });

  it("requeues failed jobs with backoff and dead-letters exhausted jobs", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({ id: "retry" });
        yield* seedJob({ id: "dead", maxAttempts: 1 });
        yield* claimSendDeliveryJobs({ limit: 2, workerId: "worker_1" });

        yield* TestClock.setTime(Date.parse("2026-07-03T12:01:00.000Z"));
        const retry = yield* failSendDeliveryJob({
          errorMessage: "temporary failure",
          jobId: "retry",
          workerId: "worker_1",
        });
        const dead = yield* failSendDeliveryJob({
          errorMessage: "permanent failure",
          jobId: "dead",
          workerId: "worker_1",
        });

        return { dead, retry };
      }),
    );

    expect(outcome.retry.state).toBe("queued");
    expect(outcome.retry.runAt).toBe("2026-07-03T12:02:00.000Z");
    expect(outcome.retry.lastError).toBe("temporary failure");
    expect(outcome.dead.state).toBe("dead");
    expect(outcome.dead.lockedBy).toBeNull();
    expect(outcome.dead.lastError).toBe("permanent failure");
  });

  it("recovers expired leases with backoff or dead-letter transitions", async () => {
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        yield* seedJob({
          attempts: 2,
          id: "expired_retry",
          lockedBy: "dead_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          state: "leased",
        });
        yield* seedJob({
          attempts: 2,
          id: "expired_dead",
          lockedBy: "dead_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          maxAttempts: 2,
          state: "leased",
        });
        yield* seedJob({
          attempts: 4,
          id: "expired_attempt4",
          lockedBy: "dead_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          state: "leased",
        });
        yield* seedJob({
          attempts: 1,
          id: "active_lease",
          lockedBy: "worker",
          lockedUntil: "2026-07-03T12:10:00.000Z",
          state: "leased",
        });

        const released = yield* releaseExpiredSendDeliveryLeases({});

        const db = yield* Database;
        return {
          activeLease: yield* db.get(
            "assert:active-lease",
            "SELECT state, locked_by AS lockedBy FROM jobs WHERE id = 'active_lease';",
          ),
          released,
        };
      }),
    );

    expect(
      outcome.released
        .map((job) => ({ id: job.id, runAt: job.runAt, state: job.state }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "expired_attempt4", runAt: "2026-07-03T12:08:00.000Z", state: "queued" },
      { id: "expired_dead", runAt: "2026-07-03T11:00:00.000Z", state: "dead" },
      { id: "expired_retry", runAt: "2026-07-03T12:02:00.000Z", state: "queued" },
    ]);
    expect(outcome.activeLease).toEqual({ lockedBy: "worker", state: "leased" });
  });
});
