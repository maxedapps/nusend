import type { Database } from "bun:sqlite";

import {
  claimJobs,
  completeJob,
  failJob,
  type JobKind,
  type QueueJob,
  releaseExpiredLeases,
} from "./jobs.ts";
import { nowIso } from "./time.ts";

export type JobProcessor = (job: QueueJob) => Promise<void>;

export type RunOnceOptions = {
  db: Database;
  workerId: string;
  processJob: JobProcessor;
  now?: () => string;
  leaseSeconds?: number;
  batchSize?: number;
  kinds?: JobKind[];
};

export type RunOnceResult = {
  released: number;
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  skippedStale: number;
};

export type DrainOnceOptions = RunOnceOptions & {
  maxIterations?: number;
};

export type DrainOnceResult = RunOnceResult & {
  iterations: number;
  maxIterationsReached: boolean;
};

const defaultMaxIterations = 100;

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const now = (options.now ?? nowIso)();
  const releasedJobs = releaseExpiredLeases(options.db, { now });
  const claimedJobs = claimJobs(options.db, {
    kinds: options.kinds,
    leaseSeconds: options.leaseSeconds,
    limit: options.batchSize,
    now,
    workerId: options.workerId,
  });
  const result: RunOnceResult = {
    claimed: claimedJobs.length,
    dead: releasedJobs.filter((job) => job.state === "dead").length,
    failed: 0,
    released: releasedJobs.length,
    skippedStale: 0,
    succeeded: 0,
  };

  for (const job of claimedJobs) {
    try {
      // eslint-disable-next-line no-await-in-loop -- process jobs sequentially to keep queue transitions simple and bounded.
      await options.processJob(job);
      const completed = completeJob(options.db, {
        jobId: job.id,
        now: (options.now ?? nowIso)(),
        workerId: options.workerId,
      });
      if (completed.ok) {
        result.succeeded += 1;
      } else {
        result.skippedStale += 1;
      }
    } catch (error) {
      const failed = failJob(options.db, {
        errorMessage: errorToMessage(error),
        jobId: job.id,
        now: (options.now ?? nowIso)(),
        workerId: options.workerId,
      });
      if (!failed.ok) {
        result.skippedStale += 1;
      } else if (failed.job.state === "dead") {
        result.dead += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}

export async function drainOnce(options: DrainOnceOptions): Promise<DrainOnceResult> {
  const maxIterations = options.maxIterations ?? defaultMaxIterations;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError("maxIterations must be a positive integer");
  }

  const total: DrainOnceResult = {
    claimed: 0,
    dead: 0,
    failed: 0,
    iterations: 0,
    maxIterationsReached: false,
    released: 0,
    skippedStale: 0,
    succeeded: 0,
  };

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    // eslint-disable-next-line no-await-in-loop -- drain intentionally waits for each batch before claiming the next one.
    const result = await runOnce(options);
    total.iterations += 1;
    total.released += result.released;
    total.claimed += result.claimed;
    total.succeeded += result.succeeded;
    total.failed += result.failed;
    total.dead += result.dead;
    total.skippedStale += result.skippedStale;

    if (result.claimed === 0) return total;
  }

  total.maxIterationsReached = true;
  return total;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
