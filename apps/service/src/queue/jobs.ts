import type { Database } from "bun:sqlite";

import { calculateBackoffSeconds } from "./backoff.ts";
import { addSecondsIso, nowIso } from "./time.ts";

export type JobKind = "process_ses_event" | "send_delivery";
export type JobState = "queued" | "leased" | "succeeded" | "failed" | "dead" | "cancelled";

export type QueueJob = {
  id: string;
  kind: JobKind;
  state: JobState;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  refId: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimJobsOptions = {
  workerId: string;
  now?: string;
  leaseSeconds?: number;
  limit?: number;
  kinds?: JobKind[];
};

export type JobTransitionResult =
  | { ok: true; job: QueueJob }
  | { ok: false; reason: "not_leased_by_worker" };

export type CompleteJobOptions = {
  jobId: string;
  workerId: string;
  now?: string;
};

export type FailJobOptions = {
  jobId: string;
  workerId: string;
  errorMessage: string;
  now?: string;
};

export type ReleaseExpiredLeasesOptions = {
  now?: string;
  limit?: number;
};

const defaultLeaseSeconds = 300;
const defaultClaimLimit = 10;
const defaultReleaseLimit = 100;
const maxStoredErrorLength = 2000;

const returningQueueJobSql = `
  id,
  kind,
  state,
  run_at AS runAt,
  attempts,
  max_attempts AS maxAttempts,
  locked_by AS lockedBy,
  locked_until AS lockedUntil,
  ref_id AS refId,
  last_error AS lastError,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export function claimJobs(db: Database, options: ClaimJobsOptions): QueueJob[] {
  const now = options.now ?? nowIso();
  const limit = normalizeLimit(options.limit, defaultClaimLimit);
  const leaseSeconds = options.leaseSeconds ?? defaultLeaseSeconds;
  const lockedUntil = addSecondsIso(now, leaseSeconds);
  const kindFilter = createKindFilter(options.kinds);

  return db
    .query<QueueJob, Record<string, string | number>>(
      `
        UPDATE jobs
        SET state = 'leased',
            attempts = attempts + 1,
            locked_by = $workerId,
            locked_until = $lockedUntil,
            updated_at = $now
        WHERE state = 'queued'
          AND run_at <= $now
          ${kindFilter.outerSql}
          AND id IN (
            SELECT id
            FROM jobs
            WHERE state = 'queued'
              AND run_at <= $now
              ${kindFilter.innerSql}
            ORDER BY run_at ASC, created_at ASC, id ASC
            LIMIT $limit
          )
        RETURNING ${returningQueueJobSql};
      `,
    )
    .all({
      ...kindFilter.params,
      limit,
      lockedUntil,
      now,
      workerId: options.workerId,
    })
    .sort(compareJobsBySchedule);
}

export function completeJob(db: Database, options: CompleteJobOptions): JobTransitionResult {
  const job = db
    .query<QueueJob, { jobId: string; now: string; workerId: string }>(
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
        RETURNING ${returningQueueJobSql};
      `,
    )
    .get({ jobId: options.jobId, now: options.now ?? nowIso(), workerId: options.workerId });

  if (!job) return { ok: false, reason: "not_leased_by_worker" };

  return { job, ok: true };
}

export function failJob(db: Database, options: FailJobOptions): JobTransitionResult {
  const now = options.now ?? nowIso();
  const retrySchedule = createRetrySchedule(now);
  const job = db
    .query<QueueJob, Record<string, string>>(
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
        RETURNING ${returningQueueJobSql};
      `,
    )
    .get({
      ...retrySchedule.params,
      jobId: options.jobId,
      lastError: truncateError(options.errorMessage),
      now,
      workerId: options.workerId,
    });

  if (!job) return { ok: false, reason: "not_leased_by_worker" };

  return { job, ok: true };
}

export function releaseExpiredLeases(
  db: Database,
  options: ReleaseExpiredLeasesOptions = {},
): QueueJob[] {
  const now = options.now ?? nowIso();
  const limit = normalizeLimit(options.limit, defaultReleaseLimit);
  const retrySchedule = createRetrySchedule(now);

  return db
    .query<QueueJob, Record<string, string | number>>(
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
        RETURNING ${returningQueueJobSql};
      `,
    )
    .all({ ...retrySchedule.params, limit, now });
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return limit;
}

function createKindFilter(kinds: JobKind[] | undefined): {
  innerSql: string;
  outerSql: string;
  params: Record<string, string>;
} {
  if (!kinds || kinds.length === 0) return { innerSql: "", outerSql: "", params: {} };

  const uniqueKinds = [...new Set(kinds)];
  const params: Record<string, string> = {};
  const placeholders = uniqueKinds.map((kind, index) => {
    const name = `kind${index}`;
    params[name] = kind;
    return `$${name}`;
  });

  return {
    innerSql: `AND kind IN (${placeholders.join(", ")})`,
    outerSql: `AND kind IN (${placeholders.join(", ")})`,
    params,
  };
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

function compareJobsBySchedule(left: QueueJob, right: QueueJob): number {
  return (
    left.runAt.localeCompare(right.runAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
