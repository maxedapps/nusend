import { placeholders } from "../lib/d1-batch.ts";
import { calculateBackoffSeconds } from "./backoff.ts";
import { addSecondsIso, nowIso } from "./time.ts";

const jobKinds = [
  "expand_mailing",
  "send_delivery",
  "process_ses_event",
  "finalize_mailing",
] as const;

export type JobKind = (typeof jobKinds)[number];
export type JobState = "queued" | "leased" | "succeeded" | "failed" | "dead" | "cancelled";

export type QueueJob = {
  id: string;
  kind: JobKind;
  state: JobState;
  priority: number;
  payloadJson: string | null;
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
  kinds: JobKind[];
  now?: string;
  leaseSeconds?: number;
  limit?: number;
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

export type InsertJobInput = {
  id: string;
  kind: JobKind;
  refId: string;
  runAt: string;
  now: string;
  priority?: number;
  payloadJson?: string | null;
  maxAttempts?: number;
};

const defaultLeaseSeconds = 300;
const defaultClaimLimit = 10;
const defaultReleaseLimit = 100;
const maxStoredErrorLength = 2000;

const returningQueueJobSql = `
  id,
  kind,
  state,
  priority,
  payload_json AS payloadJson,
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

export async function claimJobs(db: D1Database, options: ClaimJobsOptions): Promise<QueueJob[]> {
  const kinds = [...new Set(options.kinds)];
  if (kinds.length === 0) return [];

  const now = options.now ?? nowIso();
  const limit = normalizeLimit(options.limit, defaultClaimLimit);
  const leaseSeconds = options.leaseSeconds ?? defaultLeaseSeconds;
  const lockedUntil = addSecondsIso(now, leaseSeconds);
  const kindPlaceholders = kinds.map((_, index) => `?${index + 5}`).join(", ");

  const result = await db
    .prepare(
      `
        UPDATE jobs
        SET state = 'leased',
            attempts = attempts + 1,
            locked_by = ?1,
            locked_until = ?2,
            updated_at = ?3
        WHERE state = 'queued'
          AND run_at <= ?3
          AND kind IN (${kindPlaceholders})
          AND id IN (
            SELECT id
            FROM jobs
            WHERE state = 'queued'
              AND run_at <= ?3
              AND kind IN (${kindPlaceholders})
            ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
            LIMIT ?4
          )
        RETURNING ${returningQueueJobSql};
      `,
    )
    .bind(options.workerId, lockedUntil, now, limit, ...kinds)
    .all<QueueJob>();

  return result.results.sort(compareJobsBySchedule);
}

export async function completeJob(
  db: D1Database,
  options: CompleteJobOptions,
): Promise<JobTransitionResult> {
  const job = await db
    .prepare(
      `
        UPDATE jobs
        SET state = 'succeeded',
            locked_by = NULL,
            locked_until = NULL,
            last_error = NULL,
            updated_at = ?1
        WHERE id = ?2
          AND state = 'leased'
          AND locked_by = ?3
        RETURNING ${returningQueueJobSql};
      `,
    )
    .bind(options.now ?? nowIso(), options.jobId, options.workerId)
    .first<QueueJob>();

  if (!job) return { ok: false, reason: "not_leased_by_worker" };

  return { job, ok: true };
}

export async function failJob(
  db: D1Database,
  options: FailJobOptions,
): Promise<JobTransitionResult> {
  const now = options.now ?? nowIso();
  const retrySchedule = createRetrySchedule(now, 5);
  const job = await db
    .prepare(
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
            last_error = ?1,
            updated_at = ?2
        WHERE id = ?3
          AND state = 'leased'
          AND locked_by = ?4
        RETURNING ${returningQueueJobSql};
      `,
    )
    .bind(
      truncateError(options.errorMessage),
      now,
      options.jobId,
      options.workerId,
      ...retrySchedule.params,
    )
    .first<QueueJob>();

  if (!job) return { ok: false, reason: "not_leased_by_worker" };

  return { job, ok: true };
}

export async function releaseExpiredLeases(
  db: D1Database,
  options: ReleaseExpiredLeasesOptions = {},
): Promise<QueueJob[]> {
  const now = options.now ?? nowIso();
  const limit = normalizeLimit(options.limit, defaultReleaseLimit);
  const retrySchedule = createRetrySchedule(now, 3);

  const result = await db
    .prepare(
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
            updated_at = ?1
        WHERE state = 'leased'
          AND locked_until <= ?1
          AND id IN (
            SELECT id
            FROM jobs
            WHERE state = 'leased'
              AND locked_until <= ?1
            ORDER BY locked_until ASC, run_at ASC, created_at ASC, id ASC
            LIMIT ?2
          )
        RETURNING ${returningQueueJobSql};
      `,
    )
    .bind(now, limit, ...retrySchedule.params)
    .all<QueueJob>();

  return result.results;
}

export async function getNextQueuedRunAt(db: D1Database, kinds: JobKind[]): Promise<string | null> {
  const uniqueKinds = [...new Set(kinds)];
  if (uniqueKinds.length === 0) return null;

  const row = await db
    .prepare(
      `SELECT MIN(run_at) AS nextRunAt FROM jobs WHERE state = 'queued' AND kind IN (${placeholders(uniqueKinds.length)});`,
    )
    .bind(...uniqueKinds)
    .first<{ nextRunAt: string | null }>();

  return row?.nextRunAt ?? null;
}

// Uses INSERT OR IGNORE so callers may pass deterministic job ids and compose
// these statements into at-least-once batches without creating duplicates.
export function buildInsertJobStatement(
  db: D1Database,
  input: InsertJobInput,
): D1PreparedStatement {
  return db
    .prepare(
      `
        INSERT OR IGNORE INTO jobs (
          id, kind, state, priority, payload_json, run_at, max_attempts, ref_id, created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?);
      `,
    )
    .bind(
      input.id,
      input.kind,
      input.priority ?? 0,
      input.payloadJson ?? null,
      input.runAt,
      input.maxAttempts ?? 10,
      input.refId,
      input.now,
      input.now,
    );
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  return limit;
}

function createRetrySchedule(
  now: string,
  firstParamIndex: number,
): { sql: string; params: string[] } {
  const params: string[] = [];
  const branches: string[] = [];

  for (const attempt of [1, 2, 3, 4, 5, 6]) {
    params.push(addSecondsIso(now, calculateBackoffSeconds(attempt)));
    branches.push(`WHEN attempts = ${attempt} THEN ?${firstParamIndex + attempt - 1}`);
  }

  params.push(addSecondsIso(now, calculateBackoffSeconds(7)));
  branches.push(`ELSE ?${firstParamIndex + 6}`);

  return { params, sql: branches.join("\n              ") };
}

function truncateError(errorMessage: string): string {
  return errorMessage.slice(0, maxStoredErrorLength);
}

function compareJobsBySchedule(left: QueueJob, right: QueueJob): number {
  return (
    right.priority - left.priority ||
    left.runAt.localeCompare(right.runAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
