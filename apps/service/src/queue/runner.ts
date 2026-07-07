// One poll cycle over the queue: release expired leases, claim a batch, process
// each job sequentially. Repetition (the future worker loop) belongs to the
// caller via Schedule; durable retry stays in SQL (see jobs.ts).
import { Cause, Effect, Exit } from "effect";

import type { DatabaseError } from "../errors.ts";
import type { DatabaseService } from "../services/database.ts";
import { currentIso } from "../lib/iso-time.ts";
import { claimJobsAt, completeJob, failJob, releaseExpiredLeasesAt } from "./jobs.ts";
import type { JobKind, QueueJob } from "./schema.ts";

export type JobProcessor<R> = (job: QueueJob) => Effect.Effect<void, unknown, R>;

export type RunOnceOptions<R> = {
  workerId: string;
  processJob: JobProcessor<R>;
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

export type DrainOnceOptions<R> = RunOnceOptions<R> & {
  maxIterations?: number;
};

export type DrainOnceResult = RunOnceResult & {
  iterations: number;
  maxIterationsReached: boolean;
};

const defaultMaxIterations = 100;

export function runOnce<R>(
  options: RunOnceOptions<R>,
): Effect.Effect<RunOnceResult, DatabaseError, DatabaseService | R> {
  return Effect.gen(function* () {
    // One time snapshot for release + claim (matching the pre-Effect runner);
    // complete/fail read fresh time after each job is processed.
    const now = yield* currentIso;
    const releasedJobs = yield* releaseExpiredLeasesAt(now, {});
    const claimedJobs = yield* claimJobsAt(now, {
      kinds: options.kinds,
      leaseSeconds: options.leaseSeconds,
      limit: options.batchSize,
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

    // Jobs are processed sequentially to keep queue transitions simple and
    // bounded. Any processor failure (typed or defect) routes to failJob — the
    // job stays durable/retryable. Only a stale lease is swallowed, and it must
    // be caught INSIDE each branch: failJob's own stale error must never be
    // re-routed as a processor failure.
    for (const job of claimedJobs) {
      const processed = yield* Effect.exit(options.processJob(job));

      if (Exit.isSuccess(processed)) {
        const outcome = yield* completeJob({ jobId: job.id, workerId: options.workerId }).pipe(
          Effect.map(() => "succeeded" as const),
          Effect.catchTag("JobNotLeasedError", () => Effect.succeed("skippedStale" as const)),
        );
        result[outcome] += 1;
      } else {
        const outcome = yield* failJob({
          errorMessage: errorToMessage(Cause.squash(processed.cause)),
          jobId: job.id,
          workerId: options.workerId,
        }).pipe(
          Effect.map((failed) =>
            failed.state === "dead" ? ("dead" as const) : ("failed" as const),
          ),
          Effect.catchTag("JobNotLeasedError", () => Effect.succeed("skippedStale" as const)),
        );
        result[outcome] += 1;
      }
    }

    return result;
  });
}

export function drainOnce<R>(
  options: DrainOnceOptions<R>,
): Effect.Effect<DrainOnceResult, DatabaseError, DatabaseService | R> {
  return Effect.gen(function* () {
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
      const result = yield* runOnce(options);
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
  });
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
