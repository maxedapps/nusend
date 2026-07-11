import { describe, expect, it } from "vitest";

import type { SendWorkerOnceResult } from "../queue/runner.ts";
import { runSendWorkerLoop } from "./worker-loop.ts";

function result(overrides: Partial<SendWorkerOnceResult> = {}): SendWorkerOnceResult {
  return {
    claimed: 0,
    dead: 0,
    failed: 0,
    released: 0,
    skippedStale: 0,
    succeeded: 0,
    ...overrides,
  };
}

describe("runSendWorkerLoop", () => {
  it("continues after a transient cycle failure instead of exiting", async () => {
    let calls = 0;
    const errors: unknown[] = [];

    await runSendWorkerLoop({
      isShuttingDown: () => calls >= 3,
      maxConsecutiveFailures: 10,
      onError: (event) => {
        errors.push(event);
      },
      pollIntervalMs: 0,
      runOnce: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("recipient@example.com payload-secret SQLITE_BUSY"));
        }
        return Promise.resolve(result());
      },
      sleep: () => Promise.resolve(),
    });

    // The first cycle threw; the loop logged, backed off, and kept going.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([
      {
        consecutiveFailures: 1,
        event: "send_worker_cycle_failed",
        maxConsecutiveFailures: 10,
      },
    ]);
    expect(JSON.stringify(errors)).not.toContain("recipient@example.com");
    expect(JSON.stringify(errors)).not.toContain("payload-secret");
  });

  it("exits (rethrows) after too many consecutive failures", async () => {
    let calls = 0;

    await expect(
      runSendWorkerLoop({
        isShuttingDown: () => false,
        maxConsecutiveFailures: 3,
        pollIntervalMs: 0,
        runOnce: () => {
          calls += 1;
          return Promise.reject(new Error("still broken"));
        },
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("still broken");

    expect(calls).toBe(3);
  });

  it("stops when shutting down", async () => {
    let calls = 0;

    await runSendWorkerLoop({
      isShuttingDown: () => calls >= 1,
      pollIntervalMs: 0,
      runOnce: () => {
        calls += 1;
        return Promise.resolve(result({ claimed: 1 }));
      },
      sleep: () => Promise.resolve(),
    });

    expect(calls).toBe(1);
  });
});
