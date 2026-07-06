import { describe, expect, it } from "vitest";

import { db, seedJob, selectAll, selectSingle } from "../../test/helpers.ts";
import { runOnce } from "./runner.ts";

function fixedNow(values: string[]): () => string {
  return () => values.shift() ?? "2026-07-03T12:59:00.000Z";
}

describe("runOnce", () => {
  it("completes jobs after a successful processor", async () => {
    await seedJob({ id: "job_1" });
    const seen: { attempts: number; id: string; state: string }[] = [];

    const result = await runOnce({
      db,
      kinds: ["send_delivery"],
      now: fixedNow(["2026-07-03T12:00:00.000Z", "2026-07-03T12:00:01.000Z"]),
      processJob: async (job) => {
        seen.push({ attempts: job.attempts, id: job.id, state: job.state });
      },
      workerId: "worker_1",
    });

    expect(seen).toEqual([{ attempts: 1, id: "job_1", state: "leased" }]);
    expect(result).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      released: 0,
      skippedStale: 0,
      succeeded: 1,
    });
    expect(
      await selectSingle("SELECT state, locked_by AS lockedBy FROM jobs WHERE id = 'job_1';"),
    ).toEqual({ lockedBy: null, state: "succeeded" });
  });

  it("requeues or dead-letters jobs when processors throw", async () => {
    await seedJob({ id: "retry" });
    await seedJob({ id: "dead", maxAttempts: 1 });

    const result = await runOnce({
      batchSize: 2,
      db,
      kinds: ["send_delivery"],
      now: () => "2026-07-03T12:00:00.000Z",
      processJob: async () => {
        throw new Error("send failed");
      },
      workerId: "worker_1",
    });

    expect(result).toEqual({
      claimed: 2,
      dead: 1,
      failed: 1,
      released: 0,
      skippedStale: 0,
      succeeded: 0,
    });
    expect(
      await selectAll(
        "SELECT id, state, run_at AS runAt, last_error AS lastError FROM jobs ORDER BY id;",
      ),
    ).toEqual([
      { id: "dead", lastError: "send failed", runAt: "2026-07-03T11:00:00.000Z", state: "dead" },
      { id: "retry", lastError: "send failed", runAt: "2026-07-03T12:01:00.000Z", state: "queued" },
    ]);
  });

  it("releases expired leases before claiming jobs", async () => {
    await seedJob({
      attempts: 1,
      id: "expired",
      lockedBy: "old_worker",
      lockedUntil: "2026-07-03T11:59:00.000Z",
      state: "leased",
    });
    await seedJob({
      attempts: 1,
      id: "expired_dead",
      lockedBy: "old_worker",
      lockedUntil: "2026-07-03T11:59:00.000Z",
      maxAttempts: 1,
      state: "leased",
    });

    const result = await runOnce({
      db,
      kinds: ["send_delivery"],
      now: fixedNow(["2026-07-03T12:00:00.000Z"]),
      processJob: async () => {},
      workerId: "worker_1",
    });

    expect(result).toEqual({
      claimed: 0,
      dead: 1,
      failed: 0,
      released: 2,
      skippedStale: 0,
      succeeded: 0,
    });
    expect(
      await selectSingle(
        "SELECT state, run_at AS runAt, locked_by AS lockedBy FROM jobs WHERE id = 'expired';",
      ),
    ).toEqual({ lockedBy: null, runAt: "2026-07-03T12:01:00.000Z", state: "queued" });
  });

  it("does not crash when completion or failure observes a stale lease", async () => {
    await seedJob({ id: "success_stale" });
    const success = await runOnce({
      db,
      kinds: ["send_delivery"],
      now: fixedNow(["2026-07-03T12:00:00.000Z", "2026-07-03T12:00:01.000Z"]),
      processJob: async (job) => {
        await db.prepare("UPDATE jobs SET locked_by = 'other' WHERE id = ?1;").bind(job.id).run();
      },
      workerId: "worker_1",
    });
    expect(success.skippedStale).toBe(1);

    await seedJob({ id: "failure_stale" });
    const failure = await runOnce({
      db,
      kinds: ["send_delivery"],
      now: fixedNow(["2026-07-03T12:10:00.000Z", "2026-07-03T12:10:01.000Z"]),
      processJob: async (job) => {
        await db.prepare("UPDATE jobs SET locked_by = 'other' WHERE id = ?1;").bind(job.id).run();
        throw new Error("boom");
      },
      workerId: "worker_1",
    });
    expect(failure.skippedStale).toBe(1);
  });
});
