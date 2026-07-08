// One send-worker poll cycle: release expired send-delivery leases, reconcile
// dead releases, claim a batch, and process each job sequentially. Repetition
// belongs to the caller; durable retry stays in SQL (see jobs.ts).
import { Cause, Effect, Exit } from "effect";

import type { DatabaseError } from "../errors.ts";
import { refreshMailingStateForDelivery } from "../mailings/lifecycle.ts";
import type { DatabaseService } from "../services/database.ts";
import type {
  EmailSendingConfigService,
  EmailTransportService,
} from "../services/email-transport.ts";
import type { IdGeneratorService } from "../services/ids.ts";
import {
  markDeliveryFailedForDeadJob,
  markReleasedDeadJobDeliveryAmbiguous,
} from "../sending/attempts.ts";
import { processSendDeliveryJob } from "../sending/process-delivery.ts";
import { currentIso } from "../lib/iso-time.ts";
import {
  claimSendDeliveryJobsAt,
  completeSendDeliveryJob,
  failSendDeliveryJob,
  releaseExpiredSendDeliveryLeasesAt,
} from "./jobs.ts";

export type SendWorkerOnceOptions = {
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly workerId: string;
};

export type SendWorkerOnceResult = {
  released: number;
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  skippedStale: number;
};

export function runSendWorkerOnce(
  options: SendWorkerOnceOptions,
): Effect.Effect<
  SendWorkerOnceResult,
  DatabaseError,
  DatabaseService | EmailSendingConfigService | EmailTransportService | IdGeneratorService
> {
  return Effect.gen(function* () {
    // One time snapshot for release + claim; complete/fail read fresh time after
    // each job is processed.
    const now = yield* currentIso;
    const releasedJobs = yield* releaseExpiredSendDeliveryLeasesAt(now, {});
    const claimedJobs = yield* claimSendDeliveryJobsAt(now, {
      leaseSeconds: options.leaseSeconds,
      limit: options.batchSize,
      workerId: options.workerId,
    });

    const result: SendWorkerOnceResult = {
      claimed: claimedJobs.length,
      dead: 0,
      failed: 0,
      released: releasedJobs.length,
      skippedStale: 0,
      succeeded: 0,
    };

    for (const job of releasedJobs) {
      if (job.state !== "dead") continue;
      result.dead += 1;
      const message = job.lastError ?? "Expired send-delivery job reached max attempts.";
      yield* markReleasedDeadJobDeliveryAmbiguous({
        deliveryId: job.deliveryId,
        errorMessage: message,
      });
      yield* refreshMailingStateForDelivery(job.deliveryId);
    }

    // Jobs are processed sequentially to keep queue transitions simple and
    // bounded. Any processor failure (typed or defect) routes to
    // failSendDeliveryJob. Only a stale lease is swallowed, and it must be
    // caught INSIDE each branch: failSendDeliveryJob's own stale error must
    // never be re-routed as a processor failure.
    for (const job of claimedJobs) {
      const processed = yield* Effect.exit(processSendDeliveryJob(job));

      if (Exit.isSuccess(processed)) {
        const outcome = yield* completeSendDeliveryJob({
          jobId: job.id,
          workerId: options.workerId,
        }).pipe(
          Effect.map(() => "succeeded" as const),
          Effect.catchTag("JobNotLeasedError", () => Effect.succeed("skippedStale" as const)),
        );
        result[outcome] += 1;
        if (outcome !== "skippedStale") yield* refreshMailingStateForDelivery(job.deliveryId);
      } else {
        const message = errorToMessage(Cause.squash(processed.cause));
        const outcome = yield* failSendDeliveryJob({
          errorMessage: message,
          jobId: job.id,
          workerId: options.workerId,
        }).pipe(
          Effect.flatMap((failedJob) =>
            failedJob.state === "dead"
              ? markDeliveryFailedForDeadJob({
                  deliveryId: job.deliveryId,
                  errorMessage: failedJob.lastError ?? message,
                }).pipe(Effect.as("dead" as const))
              : Effect.succeed("failed" as const),
          ),
          Effect.catchTag("JobNotLeasedError", () => Effect.succeed("skippedStale" as const)),
        );
        result[outcome] += 1;
        if (outcome !== "skippedStale") yield* refreshMailingStateForDelivery(job.deliveryId);
      }
    }

    return result;
  });
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
