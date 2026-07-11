// One send-worker poll cycle: release expired send-delivery leases, reconcile
// dead releases, claim a batch, and process each job sequentially. Repetition
// belongs to the caller; durable retry stays in SQL (see jobs.ts).
import { Cause, Effect, Exit } from "effect";

import type { DatabaseError } from "../errors.ts";
import { refreshMailingStateForDelivery } from "../mailings/lifecycle.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import type {
  EmailSendingConfigService,
  EmailTransportService,
} from "../services/email-transport.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import type { UnsubscribeConfigService } from "../unsubscribe/config.ts";
import { markReleasedDeadJobDeliveryAmbiguous } from "../sending/attempts.ts";
import { processSendDeliveryJob } from "../sending/process-delivery.ts";
import { addMillisecondsIso, currentIso, subtractDaysIso } from "../lib/iso-time.ts";
import {
  claimSendDeliveryJobsAt,
  completeSendDeliveryJob,
  failSendDeliveryJob,
  releaseExpiredSendDeliveryLeasesAt,
} from "./jobs.ts";

export type SendWorkerOnceOptions = {
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly mode?: "loop" | "once";
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
  | DatabaseService
  | EmailSendingConfigService
  | EmailTransportService
  | IdGeneratorService
  | UnsubscribeConfigService
> {
  return Effect.gen(function* () {
    // One time snapshot for release + claim; complete/fail read fresh time after
    // each job is processed.
    const now = yield* currentIso;
    const startedAt = now;
    // Crash-safe reconciliation: dead-job/mailing state is updated
    // non-transactionally after the release commit, so a crash in that window can
    // leave a dead job with a non-terminal delivery (and a mailing stuck
    // `sending`) that no later cycle re-observes (release only scans leased). This
    // idempotent sweep repairs those before doing new work.
    yield* reconcileOrphanedDeadJobs();
    yield* reconcileStuckSendingMailings();

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
              ? markReleasedDeadJobDeliveryAmbiguous({
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

    const finishedAt = yield* currentIso;
    yield* Effect.logInfo("send worker cycle completed", {
      claimed: result.claimed,
      dead: result.dead,
      failed: result.failed,
      mode: options.mode ?? "once",
      released: result.released,
      skippedStale: result.skippedStale,
      succeeded: result.succeeded,
      workerId: options.workerId,
    });
    // Observability only — a failure to record/prune the worker-run row must not
    // fail the cycle (which would, in loop mode, otherwise be fatal).
    yield* recordWorkerRun({
      finishedAt,
      mode: options.mode ?? "once",
      result,
      startedAt,
      workerId: options.workerId,
    }).pipe(
      Effect.catchTag("DatabaseError", (error) =>
        Effect.logWarning("failed to record worker run", { operation: error.operation }),
      ),
    );

    return result;
  });
}

// Repairs dead jobs whose delivery is still non-terminal (a crash between the
// release-to-dead commit and the post-release reconciliation). Idempotent: the
// underlying helpers no-op once the delivery is terminal.
function reconcileOrphanedDeadJobs(): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const orphans = yield* db.all<{ deliveryId: string; lastError: string | null }>(
      "queue:reconcile-dead-jobs",
      `SELECT j.delivery_id AS deliveryId, j.last_error AS lastError
       FROM jobs j
       JOIN deliveries d ON d.id = j.delivery_id
       WHERE j.state = 'dead' AND d.status IN ('queued', 'sending');`,
    );

    for (const orphan of orphans) {
      yield* markReleasedDeadJobDeliveryAmbiguous({
        deliveryId: orphan.deliveryId,
        errorMessage: orphan.lastError ?? "Dead send-delivery job reached max attempts.",
      });
      yield* refreshMailingStateForDelivery(orphan.deliveryId);
    }
  });
}

// Repairs mailings stuck in `sending` whose deliveries are all terminal (a crash
// between the last delivery completing and the mailing-state refresh).
function reconcileStuckSendingMailings(): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const stuck = yield* db.all<{ deliveryId: string }>(
      "queue:reconcile-stuck-mailings",
      `SELECT MIN(d.id) AS deliveryId
       FROM mailings m
       JOIN deliveries d ON d.mailing_id = m.id
       WHERE m.state = 'sending'
       GROUP BY m.id
       HAVING SUM(CASE WHEN d.status IN ('queued', 'sending') THEN 1 ELSE 0 END) = 0;`,
    );

    for (const mailing of stuck) {
      yield* refreshMailingStateForDelivery(mailing.deliveryId);
    }
  });
}

const workerRunRetentionDays = 30;
const idleHeartbeatMs = 5 * 60 * 1000;

function recordWorkerRun(options: {
  finishedAt: string;
  mode: "loop" | "once";
  result: SendWorkerOnceResult;
  startedAt: string;
  workerId: string;
}): Effect.Effect<void, DatabaseError, DatabaseService | IdGeneratorService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const shouldPersist = yield* shouldPersistWorkerRun(db, options);
    if (!shouldPersist) return;

    const ids = yield* IdGenerator;
    yield* db.run(
      "worker-runs:insert",
      `INSERT INTO worker_runs (
         id, worker_id, mode, released, claimed, succeeded, failed, dead, skipped_stale,
         started_at, finished_at
       ) VALUES (
         $id, $workerId, $mode, $released, $claimed, $succeeded, $failed, $dead, $skippedStale,
         $startedAt, $finishedAt
       );`,
      {
        claimed: options.result.claimed,
        dead: options.result.dead,
        failed: options.result.failed,
        finishedAt: options.finishedAt,
        id: yield* ids.next,
        mode: options.mode,
        released: options.result.released,
        skippedStale: options.result.skippedStale,
        startedAt: options.startedAt,
        succeeded: options.result.succeeded,
        workerId: options.workerId,
      },
    );
    yield* pruneWorkerRuns(db, options.finishedAt);
  });
}

function shouldPersistWorkerRun(
  db: DatabaseService,
  options: {
    finishedAt: string;
    mode: "loop" | "once";
    result: SendWorkerOnceResult;
    workerId: string;
  },
): Effect.Effect<boolean, DatabaseError> {
  if (options.mode === "once") return Effect.succeed(true);
  if (!isIdle(options.result)) return Effect.succeed(true);

  return Effect.gen(function* () {
    const latest = yield* db.get<{ finishedAt: string }>(
      "worker-runs:latest-idle-heartbeat",
      `SELECT finished_at AS finishedAt
       FROM worker_runs
       WHERE worker_id = $workerId
         AND mode = 'loop'
         AND released = 0
         AND claimed = 0
         AND succeeded = 0
         AND failed = 0
         AND dead = 0
         AND skipped_stale = 0
       ORDER BY finished_at DESC, id DESC
       LIMIT 1;`,
      { workerId: options.workerId },
    );
    const heartbeatBefore = addMillisecondsIso(options.finishedAt, -idleHeartbeatMs);
    return latest === null || latest.finishedAt <= heartbeatBefore;
  });
}

function isIdle(result: SendWorkerOnceResult): boolean {
  return (
    result.released === 0 &&
    result.claimed === 0 &&
    result.succeeded === 0 &&
    result.failed === 0 &&
    result.dead === 0 &&
    result.skippedStale === 0
  );
}

function pruneWorkerRuns(
  db: DatabaseService,
  finishedAt: string,
): Effect.Effect<void, DatabaseError> {
  return db.run("worker-runs:prune-old", "DELETE FROM worker_runs WHERE finished_at < $cutoff;", {
    cutoff: subtractDaysIso(finishedAt, workerRunRetentionDays),
  });
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
