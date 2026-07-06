import { describe, expect, it } from "vitest";

import { seedJob, selectAll, selectSingle } from "../../test/helpers.ts";
import {
  claimJobs,
  completeJob,
  failJob,
  getNextQueuedRunAt,
  releaseExpiredLeases,
} from "./jobs.ts";
import { db } from "../../test/helpers.ts";

describe("claimJobs", () => {
  it("claims due queued jobs atomically with lease metadata, limit, and kind filters", async () => {
    await seedJob({ id: "future", runAt: "2026-07-03T12:10:00.000Z" });
    await seedJob({
      id: "due_2",
      runAt: "2026-07-03T11:59:00.000Z",
      createdAt: "2026-07-03T11:59:01.000Z",
    });
    await seedJob({ id: "event_1", kind: "process_ses_event", runAt: "2026-07-03T11:58:00.000Z" });
    await seedJob({
      id: "due_1",
      runAt: "2026-07-03T11:59:00.000Z",
      createdAt: "2026-07-03T11:59:00.000Z",
    });

    const claimed = await claimJobs(db, {
      kinds: ["send_delivery"],
      leaseSeconds: 30,
      limit: 1,
      now: "2026-07-03T12:00:00.000Z",
      workerId: "worker_1",
    });

    expect(claimed).toEqual([
      {
        attempts: 1,
        createdAt: "2026-07-03T11:59:00.000Z",
        id: "due_1",
        kind: "send_delivery",
        lastError: null,
        lockedBy: "worker_1",
        lockedUntil: "2026-07-03T12:00:30.000Z",
        maxAttempts: 10,
        payloadJson: null,
        priority: 0,
        refId: "ref_due_1",
        runAt: "2026-07-03T11:59:00.000Z",
        state: "leased",
        updatedAt: "2026-07-03T12:00:00.000Z",
      },
    ]);
    expect(
      await selectAll("SELECT id, state, attempts, locked_by AS lockedBy FROM jobs ORDER BY id;"),
    ).toEqual([
      { attempts: 1, id: "due_1", lockedBy: "worker_1", state: "leased" },
      { attempts: 0, id: "due_2", lockedBy: null, state: "queued" },
      { attempts: 0, id: "event_1", lockedBy: null, state: "queued" },
      { attempts: 0, id: "future", lockedBy: null, state: "queued" },
    ]);
  });

  it("claims higher-priority jobs before earlier lower-priority jobs", async () => {
    await seedJob({ id: "old_low", priority: 0, runAt: "2026-07-03T11:00:00.000Z" });
    await seedJob({ id: "new_high", priority: 10, runAt: "2026-07-03T11:30:00.000Z" });

    const claimed = await claimJobs(db, {
      kinds: ["send_delivery"],
      limit: 1,
      now: "2026-07-03T12:00:00.000Z",
      workerId: "worker_1",
    });

    expect(claimed.map((job) => job.id)).toEqual(["new_high"]);
  });

  it("claims nothing when the kind list is empty", async () => {
    await seedJob({ id: "job_1" });

    const claimed = await claimJobs(db, {
      kinds: [],
      now: "2026-07-03T12:00:00.000Z",
      workerId: "worker_1",
    });

    expect(claimed).toEqual([]);
    expect(await selectSingle("SELECT state FROM jobs WHERE id = 'job_1';")).toEqual({
      state: "queued",
    });
  });

  it("does not claim terminal or cancelled jobs", async () => {
    for (const state of ["succeeded", "dead", "cancelled"] as const) {
      await seedJob({ id: state, state });
    }

    expect(
      await claimJobs(db, {
        kinds: ["send_delivery"],
        now: "2026-07-03T12:00:00.000Z",
        workerId: "worker_1",
      }),
    ).toEqual([]);
  });
});

describe("completeJob", () => {
  it("completes only jobs leased by the owning worker", async () => {
    await seedJob({ id: "job_1" });
    await claimJobs(db, {
      kinds: ["send_delivery"],
      now: "2026-07-03T12:00:00.000Z",
      workerId: "worker_1",
    });

    expect(
      await completeJob(db, { jobId: "job_1", now: "2026-07-03T12:01:00.000Z", workerId: "other" }),
    ).toEqual({ ok: false, reason: "not_leased_by_worker" });

    const completed = await completeJob(db, {
      jobId: "job_1",
      now: "2026-07-03T12:01:00.000Z",
      workerId: "worker_1",
    });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.job.state).toBe("succeeded");
      expect(completed.job.lockedBy).toBeNull();
      expect(completed.job.lockedUntil).toBeNull();
    }
  });
});

describe("failJob", () => {
  it("requeues failed jobs with backoff and dead-letters exhausted jobs", async () => {
    await seedJob({ id: "retry" });
    await seedJob({ id: "dead", maxAttempts: 1 });
    await claimJobs(db, {
      kinds: ["send_delivery"],
      limit: 2,
      now: "2026-07-03T12:00:00.000Z",
      workerId: "worker_1",
    });

    const retry = await failJob(db, {
      errorMessage: "temporary failure",
      jobId: "retry",
      now: "2026-07-03T12:01:00.000Z",
      workerId: "worker_1",
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.job.state).toBe("queued");
      expect(retry.job.runAt).toBe("2026-07-03T12:02:00.000Z");
      expect(retry.job.lastError).toBe("temporary failure");
    }

    const dead = await failJob(db, {
      errorMessage: "permanent failure",
      jobId: "dead",
      now: "2026-07-03T12:01:00.000Z",
      workerId: "worker_1",
    });
    expect(dead.ok).toBe(true);
    if (dead.ok) {
      expect(dead.job.state).toBe("dead");
      expect(dead.job.lockedBy).toBeNull();
      expect(dead.job.lastError).toBe("permanent failure");
    }
  });
});

describe("releaseExpiredLeases", () => {
  it("recovers expired leases with backoff or dead-letter transitions", async () => {
    await seedJob({
      attempts: 2,
      id: "expired_retry",
      lockedBy: "dead_worker",
      lockedUntil: "2026-07-03T11:59:00.000Z",
      state: "leased",
    });
    await seedJob({
      attempts: 2,
      id: "expired_dead",
      lockedBy: "dead_worker",
      lockedUntil: "2026-07-03T11:59:00.000Z",
      maxAttempts: 2,
      state: "leased",
    });
    await seedJob({
      attempts: 4,
      id: "expired_attempt4",
      lockedBy: "dead_worker",
      lockedUntil: "2026-07-03T11:59:00.000Z",
      state: "leased",
    });
    await seedJob({
      attempts: 1,
      id: "active_lease",
      lockedBy: "worker",
      lockedUntil: "2026-07-03T12:10:00.000Z",
      state: "leased",
    });

    const released = await releaseExpiredLeases(db, { now: "2026-07-03T12:00:00.000Z" });

    expect(
      released
        .map((job) => ({ id: job.id, runAt: job.runAt, state: job.state }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([
      { id: "expired_attempt4", runAt: "2026-07-03T12:08:00.000Z", state: "queued" },
      { id: "expired_dead", runAt: "2026-07-03T11:00:00.000Z", state: "dead" },
      { id: "expired_retry", runAt: "2026-07-03T12:02:00.000Z", state: "queued" },
    ]);
    expect(
      await selectSingle(
        "SELECT state, locked_by AS lockedBy FROM jobs WHERE id = 'active_lease';",
      ),
    ).toEqual({ lockedBy: "worker", state: "leased" });
  });
});

describe("queued job lookups", () => {
  it("reports queued work and the earliest run_at per kind list", async () => {
    await seedJob({ id: "expand", kind: "expand_mailing", runAt: "2026-07-03T12:30:00.000Z" });
    await seedJob({ id: "send", kind: "send_delivery", runAt: "2026-07-03T11:00:00.000Z" });
    await seedJob({
      id: "leased",
      kind: "expand_mailing",
      lockedBy: "worker",
      lockedUntil: "2026-07-03T12:10:00.000Z",
      runAt: "2026-07-03T10:00:00.000Z",
      state: "leased",
    });

    expect(await getNextQueuedRunAt(db, ["process_ses_event"])).toBeNull();
    expect(await getNextQueuedRunAt(db, [])).toBeNull();
    expect(await getNextQueuedRunAt(db, ["expand_mailing"])).toBe("2026-07-03T12:30:00.000Z");
    expect(await getNextQueuedRunAt(db, ["expand_mailing", "send_delivery"])).toBe(
      "2026-07-03T11:00:00.000Z",
    );
  });
});
