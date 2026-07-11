// The send-worker loop, factored out of worker-main.ts so it is unit-testable
// with injected dependencies (the entrypoint wires the real runtime/console).
import type { SendWorkerOnceResult } from "../queue/runner.ts";

export type SendWorkerLoopDeps = {
  readonly runOnce: () => Promise<SendWorkerOnceResult>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isShuttingDown: () => boolean;
  readonly pollIntervalMs: number;
  // Exit the process (throw) only after this many consecutive cycle failures so a
  // genuinely broken worker still surfaces to the supervisor.
  readonly maxConsecutiveFailures?: number;
  readonly onResult?: (result: SendWorkerOnceResult) => void;
  readonly onError?: (event: {
    readonly consecutiveFailures: number;
    readonly event: "send_worker_cycle_failed";
    readonly maxConsecutiveFailures: number;
  }) => Promise<void> | void;
};

export async function runSendWorkerLoop(deps: SendWorkerLoopDeps): Promise<void> {
  const maxConsecutiveFailures = deps.maxConsecutiveFailures ?? 10;
  let consecutiveFailures = 0;

  while (!deps.isShuttingDown()) {
    try {
      const result = await deps.runOnce();
      consecutiveFailures = 0;
      deps.onResult?.(result);
      if (result.claimed === 0) await deps.sleep(deps.pollIntervalMs);
    } catch (error) {
      // A transient cycle error (e.g. a brief SQLITE_BUSY) must not kill the loop.
      // Log, back off, and continue; exit only after too many consecutive failures.
      consecutiveFailures += 1;
      await deps.onError?.({
        consecutiveFailures,
        event: "send_worker_cycle_failed",
        maxConsecutiveFailures,
      });
      if (consecutiveFailures >= maxConsecutiveFailures) throw error;
      await deps.sleep(deps.pollIntervalMs);
    }
  }
}
