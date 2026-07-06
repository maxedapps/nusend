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
  db: D1Database;
  workerId: string;
  kinds: JobKind[];
  processJob: JobProcessor;
  now?: () => string;
  leaseSeconds?: number;
  batchSize?: number;
};

export type RunOnceResult = {
  released: number;
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  skippedStale: number;
};

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const clock = options.now ?? nowIso;
  const now = clock();
  const releasedJobs = await releaseExpiredLeases(options.db, { now });
  const claimedJobs = await claimJobs(options.db, {
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
      const completed = await completeJob(options.db, {
        jobId: job.id,
        now: clock(),
        workerId: options.workerId,
      });
      if (completed.ok) {
        result.succeeded += 1;
      } else {
        result.skippedStale += 1;
      }
    } catch (error) {
      const failed = await failJob(options.db, {
        errorMessage: errorToMessage(error),
        jobId: job.id,
        now: clock(),
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

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
