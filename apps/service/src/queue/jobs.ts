// Durable send-delivery queue transitions. Retry/backoff is deliberately encoded
// in SQL (the run_at CASE ladder) so it survives process restarts — never
// converted to Effect.retry/Schedule, which only cover in-process repetition.
import { Effect, Schema } from "effect";

import { JobNotLeasedError, type DatabaseError } from "../errors.ts";
import { addSecondsIso, currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { calculateBackoffSeconds } from "./backoff.ts";
import { SendDeliveryJob } from "./schema.ts";

export type ClaimSendDeliveryJobsOptions = {
  workerId: string;
  leaseSeconds?: number;
  limit?: number;
};

export type CompleteSendDeliveryJobOptions = {
  jobId: string;
  workerId: string;
};

export type FailSendDeliveryJobOptions = {
  jobId: string;
  workerId: string;
  errorMessage: string;
};

export type ReleaseExpiredSendDeliveryLeasesOptions = {
  limit?: number;
};

const defaultLeaseSeconds = 300;
const defaultClaimLimit = 10;
const defaultReleaseLimit = 100;
const maxStoredErrorLength = 2000;

const returningSendDeliveryJobSql = `
  id,
  state,
  run_at AS runAt,
  attempts,
  max_attempts AS maxAttempts,
  locked_by AS lockedBy,
  locked_until AS lockedUntil,
  delivery_id AS deliveryId,
  last_error AS lastError,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

// Row decoding failures are defects (§ CHECK constraints in migrations).
const decodeJob = (row: unknown): Effect.Effect<SendDeliveryJob> =>
  Schema.decodeUnknownEffect(SendDeliveryJob)(row).pipe(Effect.orDie);

export function claimSendDeliveryJobs(
  options: ClaimSendDeliveryJobsOptions,
): Effect.Effect<SendDeliveryJob[], DatabaseError, DatabaseService> {
  return Effect.flatMap(currentIso, (now) => claimSendDeliveryJobsAt(now, options));
}

// Snapshot variant used by the runner so release + claim share one `now`.
export function claimSendDeliveryJobsAt(
  now: string,
  options: ClaimSendDeliveryJobsOptions,
): Effect.Effect<SendDeliveryJob[], DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const limit = normalizeLimit(options.limit, defaultClaimLimit);
    const leaseSeconds = options.leaseSeconds ?? defaultLeaseSeconds;
    const lockedUntil = addSecondsIso(now, leaseSeconds);

    const rows = yield* db.all(
      "jobs:claim-send-delivery",
      `
        UPDATE jobs
        SET state = 'leased',
            attempts = attempts + 1,
            locked_by = $workerId,
            locked_until = $lockedUntil,
            updated_at = $now
        WHERE state = 'queued'
          AND run_at <= $now
          AND id IN (
            SELECT id
            FROM jobs
            WHERE state = 'queued'
              AND run_at <= $now
            ORDER BY run_at ASC, created_at ASC, id ASC
            LIMIT $limit
          )
        RETURNING ${returningSendDeliveryJobSql};
      `,
      {
        limit,
        lockedUntil,
        now,
        workerId: options.workerId,
      },
    );

    const jobs = yield* Effect.forEach(rows, decodeJob);
    return jobs.sort(compareJobsBySchedule);
  });
}

export function completeSendDeliveryJob(
  options: CompleteSendDeliveryJobOptions,
): Effect.Effect<SendDeliveryJob, DatabaseError | JobNotLeasedError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;

    const row = yield* db.get(
      "jobs:complete-send-delivery",
      `
        UPDATE jobs
        SET state = 'succeeded',
            locked_by = NULL,
            locked_until = NULL,
            last_error = NULL,
            updated_at = $now
        WHERE id = $jobId
          AND state = 'leased'
          AND locked_by = $workerId
        RETURNING ${returningSendDeliveryJobSql};
      `,
      { jobId: options.jobId, now, workerId: options.workerId },
    );

    if (row === null) {
      return yield* Effect.fail(new JobNotLeasedError({ jobId: options.jobId }));
    }

    return yield* decodeJob(row);
  });
}

export function failSendDeliveryJob(
  options: FailSendDeliveryJobOptions,
): Effect.Effect<SendDeliveryJob, DatabaseError | JobNotLeasedError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;
    const retrySchedule = createRetrySchedule(now);

    const row = yield* db.get(
      "jobs:fail-send-delivery",
      `
        UPDATE jobs
        SET state = CASE
              WHEN attempts >= max_attempts THEN 'dead'
              ELSE 'queued'
            END,
            run_at = CASE
              WHEN attempts >= max_attempts THEN run_at
              ${retrySchedule.sql}
            END,
            locked_by = NULL,
            locked_until = NULL,
            last_error = $lastError,
            updated_at = $now
        WHERE id = $jobId
          AND state = 'leased'
          AND locked_by = $workerId
        RETURNING ${returningSendDeliveryJobSql};
      `,
      {
        ...retrySchedule.params,
        jobId: options.jobId,
        lastError: truncateError(options.errorMessage),
        now,
        workerId: options.workerId,
      },
    );

    if (row === null) {
      return yield* Effect.fail(new JobNotLeasedError({ jobId: options.jobId }));
    }

    return yield* decodeJob(row);
  });
}

export function releaseExpiredSendDeliveryLeases(
  options: ReleaseExpiredSendDeliveryLeasesOptions = {},
): Effect.Effect<SendDeliveryJob[], DatabaseError, DatabaseService> {
  return Effect.flatMap(currentIso, (now) => releaseExpiredSendDeliveryLeasesAt(now, options));
}

// Snapshot variant used by the runner (see claimSendDeliveryJobsAt).
export function releaseExpiredSendDeliveryLeasesAt(
  now: string,
  options: ReleaseExpiredSendDeliveryLeasesOptions = {},
): Effect.Effect<SendDeliveryJob[], DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const limit = normalizeLimit(options.limit, defaultReleaseLimit);
    const retrySchedule = createRetrySchedule(now);

    const rows = yield* db.all(
      "jobs:release-expired-send-delivery",
      `
        UPDATE jobs
        SET state = CASE
              WHEN attempts >= max_attempts THEN 'dead'
              ELSE 'queued'
            END,
            run_at = CASE
              WHEN attempts >= max_attempts THEN run_at
              ${retrySchedule.sql}
            END,
            locked_by = NULL,
            locked_until = NULL,
            updated_at = $now
        WHERE state = 'leased'
          AND locked_until <= $now
          AND id IN (
            SELECT id
            FROM jobs
            WHERE state = 'leased'
              AND locked_until <= $now
            ORDER BY locked_until ASC, run_at ASC, created_at ASC, id ASC
            LIMIT $limit
          )
        RETURNING ${returningSendDeliveryJobSql};
      `,
      { ...retrySchedule.params, limit, now },
    );

    return yield* Effect.forEach(rows, decodeJob);
  });
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return limit;
}

function createRetrySchedule(now: string): { sql: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const branches: string[] = [];

  for (const attempt of [1, 2, 3, 4, 5, 6]) {
    const name = `retryAt${attempt}`;
    params[name] = addSecondsIso(now, calculateBackoffSeconds(attempt));
    branches.push(`WHEN attempts = ${attempt} THEN $${name}`);
  }

  params.retryAtCap = addSecondsIso(now, calculateBackoffSeconds(7));
  branches.push("ELSE $retryAtCap");

  return { params, sql: branches.join("\n              ") };
}

function truncateError(errorMessage: string): string {
  return errorMessage.slice(0, maxStoredErrorLength);
}

function compareJobsBySchedule(left: SendDeliveryJob, right: SendDeliveryJob): number {
  return (
    left.runAt.localeCompare(right.runAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
