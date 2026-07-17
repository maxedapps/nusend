import { Effect, Schema } from "effect";

import { DatabaseError, NotFoundError } from "../errors.ts";
import { decodeDbRow, decodeDbRows } from "../http/sql-decode.ts";
import { JobState, JobStateValues, type JobState as JobStateType } from "../queue/schema.ts";
import { Database, type DatabaseService, type SqlParams } from "../services/database.ts";
import {
  DeliveryStatusValues,
  SendAttemptStatusValues,
  type DeliveryStatus,
  type SendAttemptStatus,
} from "../sending/schema.ts";
import type { DeliveriesQuery } from "./query.ts";

const DeliveryStatusSchema = Schema.Literals(DeliveryStatusValues);
const SendAttemptStatusSchema = Schema.Literals(SendAttemptStatusValues);
const MailingPurposeSchema = Schema.Literals(["transactional", "marketing"]);
const MailingStateSchema = Schema.Literals(["scheduled", "sending", "completed"]);

const JobCountRow = Schema.Struct({ count: Schema.Number, state: JobState });
const DeliveryCountRow = Schema.Struct({ count: Schema.Number, status: DeliveryStatusSchema });
const AttemptCountRow = Schema.Struct({ count: Schema.Number, status: SendAttemptStatusSchema });

const RecentIssueRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["job", "delivery", "send_attempt"]),
  message: Schema.NullOr(Schema.String),
  relatedId: Schema.NullOr(Schema.String),
  status: Schema.String,
  updatedAt: Schema.String,
});

const DeliveryListRow = Schema.Struct({
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  jobAttempts: Schema.NullOr(Schema.Number),
  jobId: Schema.NullOr(Schema.String),
  jobLastError: Schema.NullOr(Schema.String),
  jobLockedUntil: Schema.NullOr(Schema.String),
  jobMaxAttempts: Schema.NullOr(Schema.Number),
  jobRunAt: Schema.NullOr(Schema.String),
  jobState: Schema.NullOr(JobState),
  lastError: Schema.NullOr(Schema.String),
  latestAttemptErrorMessage: Schema.NullOr(Schema.String),
  latestAttemptFinishedAt: Schema.NullOr(Schema.String),
  latestAttemptId: Schema.NullOr(Schema.String),
  latestAttemptNo: Schema.NullOr(Schema.Number),
  latestAttemptSesMessageId: Schema.NullOr(Schema.String),
  latestAttemptStartedAt: Schema.NullOr(Schema.String),
  latestAttemptStatus: Schema.NullOr(SendAttemptStatusSchema),
  mailingId: Schema.String,
  mailingPurpose: MailingPurposeSchema,
  sesMessageId: Schema.NullOr(Schema.String),
  status: DeliveryStatusSchema,
  updatedAt: Schema.String,
});

type DeliveryListRow = typeof DeliveryListRow.Type;

const DeliveryDetailRow = Schema.Struct({
  contactId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  email: Schema.String,
  id: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  mailingCreatedAt: Schema.String,
  mailingId: Schema.String,
  mailingName: Schema.NullOr(Schema.String),
  mailingPurpose: MailingPurposeSchema,
  mailingScheduledAt: Schema.NullOr(Schema.String),
  mailingState: MailingStateSchema,
  mailingSubject: Schema.String,
  mailingUpdatedAt: Schema.String,
  sesMessageId: Schema.NullOr(Schema.String),
  status: DeliveryStatusSchema,
  updatedAt: Schema.String,
});

type DeliveryDetailRow = typeof DeliveryDetailRow.Type;

const JobDetailRow = Schema.Struct({
  attempts: Schema.Number,
  createdAt: Schema.String,
  id: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  lockedBy: Schema.NullOr(Schema.String),
  lockedUntil: Schema.NullOr(Schema.String),
  maxAttempts: Schema.Number,
  runAt: Schema.String,
  state: JobState,
  updatedAt: Schema.String,
});

const SendAttemptRow = Schema.Struct({
  attemptNo: Schema.Number,
  errorMessage: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  id: Schema.String,
  sesMessageId: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  status: SendAttemptStatusSchema,
});

export type OperationsSummaryResponse = {
  readonly deliveries: Record<DeliveryStatus, number>;
  readonly jobs: Record<JobStateType, number>;
  readonly recentIssues: readonly (typeof RecentIssueRow.Type)[];
  readonly sendAttempts: Record<SendAttemptStatus, number>;
};

export type DeliveriesListResponse = {
  readonly items: readonly ReturnType<typeof toDeliveryListItem>[];
};

export type DeliveryDetailResponse = ReturnType<typeof toDeliveryDetail>;

export function getOperationsSummary(): Effect.Effect<
  OperationsSummaryResponse,
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;

    const [jobRows, deliveryRows, attemptRows, recentIssueRows] = yield* Effect.all([
      db.all(
        "operations:summary:jobs",
        "SELECT state, count(*) AS count FROM jobs GROUP BY state;",
      ),
      db.all(
        "operations:summary:deliveries",
        "SELECT status, count(*) AS count FROM deliveries GROUP BY status;",
      ),
      db.all(
        "operations:summary:send-attempts",
        "SELECT status, count(*) AS count FROM send_attempts GROUP BY status;",
      ),
      db.all(
        "operations:summary:recent-issues",
        `SELECT kind, id, relatedId, status, message, updatedAt
         FROM (
           SELECT 'job' AS kind, id, delivery_id AS relatedId, state AS status,
             last_error AS message, updated_at AS updatedAt
           FROM jobs
           WHERE last_error IS NOT NULL
           UNION ALL
           SELECT 'delivery' AS kind, id, mailing_id AS relatedId, status,
             last_error AS message, updated_at AS updatedAt
           FROM deliveries
           WHERE last_error IS NOT NULL OR status = 'ambiguous'
           UNION ALL
           SELECT 'send_attempt' AS kind, id, delivery_id AS relatedId, status,
             error_message AS message, COALESCE(finished_at, started_at) AS updatedAt
           FROM send_attempts
           WHERE error_message IS NOT NULL OR status = 'ambiguous'
         )
         ORDER BY updatedAt DESC, id DESC
         LIMIT 10;`,
      ),
    ]);

    const jobs = zeroCounts(JobStateValues);
    for (const row of yield* decodeDbRows(JobCountRow, jobRows)) jobs[row.state] = row.count;

    const deliveries = zeroCounts(DeliveryStatusValues);
    for (const row of yield* decodeDbRows(DeliveryCountRow, deliveryRows)) {
      deliveries[row.status] = row.count;
    }

    const sendAttempts = zeroCounts(SendAttemptStatusValues);
    for (const row of yield* decodeDbRows(AttemptCountRow, attemptRows)) {
      sendAttempts[row.status] = row.count;
    }

    return {
      deliveries,
      jobs,
      recentIssues: yield* decodeDbRows(RecentIssueRow, recentIssueRows),
      sendAttempts,
    };
  });
}

export function listDeliveries(
  query: DeliveriesQuery,
): Effect.Effect<DeliveriesListResponse, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const { params, where } = deliveryListWhere(query);

    const rows = yield* db.all(
      "operations:deliveries:list",
      `SELECT
         d.id AS id,
         d.mailing_id AS mailingId,
         m.purpose AS mailingPurpose,
         d.email AS email,
         d.status AS status,
         d.ses_message_id AS sesMessageId,
         d.last_error AS lastError,
         j.id AS jobId,
         j.state AS jobState,
         j.attempts AS jobAttempts,
         j.max_attempts AS jobMaxAttempts,
         j.run_at AS jobRunAt,
         j.locked_until AS jobLockedUntil,
         j.last_error AS jobLastError,
         a.id AS latestAttemptId,
         a.attempt_no AS latestAttemptNo,
         a.status AS latestAttemptStatus,
         a.ses_message_id AS latestAttemptSesMessageId,
         a.error_message AS latestAttemptErrorMessage,
         a.started_at AS latestAttemptStartedAt,
         a.finished_at AS latestAttemptFinishedAt,
         d.created_at AS createdAt,
         d.updated_at AS updatedAt
       FROM deliveries d
       INNER JOIN mailings m ON m.id = d.mailing_id
       LEFT JOIN jobs j ON j.id = (
         SELECT latest_job.id
         FROM jobs latest_job
         WHERE latest_job.delivery_id = d.id
         ORDER BY latest_job.created_at DESC, latest_job.id DESC
         LIMIT 1
       )
       LEFT JOIN send_attempts a ON a.id = (
         SELECT latest.id
         FROM send_attempts latest
         WHERE latest.delivery_id = d.id
         ORDER BY latest.attempt_no DESC
         LIMIT 1
       )
       ${where}
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT $limit;`,
      params,
    );

    const decoded = yield* decodeDbRows(DeliveryListRow, rows);
    return { items: decoded.map(toDeliveryListItem) };
  });
}

export function getDeliveryDetail(
  deliveryId: string,
): Effect.Effect<DeliveryDetailResponse, DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const deliveryRow = yield* getDeliveryDetailRow(db, deliveryId);

    if (!deliveryRow) {
      return yield* Effect.fail(new NotFoundError({ message: "Delivery not found." }));
    }

    const [jobRow, attemptRows] = yield* Effect.all([
      db.get(
        "operations:deliveries:detail-job",
        `SELECT
           id AS id,
           state AS state,
           attempts AS attempts,
           max_attempts AS maxAttempts,
           locked_by AS lockedBy,
           locked_until AS lockedUntil,
           run_at AS runAt,
           last_error AS lastError,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM jobs
         WHERE delivery_id = $deliveryId
         ORDER BY created_at DESC, id DESC
         LIMIT 1;`,
        { deliveryId },
      ),
      db.all(
        "operations:deliveries:detail-attempts",
        `SELECT
           id AS id,
           attempt_no AS attemptNo,
           status AS status,
           ses_message_id AS sesMessageId,
           error_message AS errorMessage,
           started_at AS startedAt,
           finished_at AS finishedAt
         FROM send_attempts
         WHERE delivery_id = $deliveryId
         ORDER BY attempt_no ASC;`,
        { deliveryId },
      ),
    ]);

    return toDeliveryDetail(
      deliveryRow,
      jobRow === null ? null : yield* decodeDbRow(JobDetailRow, jobRow),
      yield* decodeDbRows(SendAttemptRow, attemptRows),
    );
  });
}

function getDeliveryDetailRow(
  db: DatabaseService,
  deliveryId: string,
): Effect.Effect<DeliveryDetailRow | null, DatabaseError> {
  return db
    .get(
      "operations:deliveries:detail",
      `SELECT
         d.id AS id,
         d.mailing_id AS mailingId,
         d.email AS email,
         d.contact_id AS contactId,
         d.status AS status,
         d.ses_message_id AS sesMessageId,
         d.last_error AS lastError,
         d.created_at AS createdAt,
         d.updated_at AS updatedAt,
         m.purpose AS mailingPurpose,
         m.state AS mailingState,
         m.name AS mailingName,
         m.subject AS mailingSubject,
         m.scheduled_at AS mailingScheduledAt,
         m.created_at AS mailingCreatedAt,
         m.updated_at AS mailingUpdatedAt
       FROM deliveries d
       INNER JOIN mailings m ON m.id = d.mailing_id
       WHERE d.id = $deliveryId
       LIMIT 1;`,
      { deliveryId },
    )
    .pipe(
      Effect.flatMap((row) =>
        row === null ? Effect.succeed(null) : decodeDbRow(DeliveryDetailRow, row),
      ),
    );
}

function deliveryListWhere(query: DeliveriesQuery): { params: SqlParams; where: string } {
  const clauses: string[] = [];
  const params: SqlParams = { limit: query.limit };

  if (query.status !== null) {
    clauses.push("d.status = $status");
    params.status = query.status;
  }
  if (query.mailingId !== null) {
    clauses.push("d.mailing_id = $mailingId");
    params.mailingId = query.mailingId;
  }
  if (query.email !== null) {
    clauses.push("d.email = $email");
    params.email = query.email;
  }
  if (query.sesMessageId !== null) {
    clauses.push("d.ses_message_id = $sesMessageId");
    params.sesMessageId = query.sesMessageId;
  }
  if (query.issue === "failed_or_ambiguous") {
    clauses.push(
      "(d.status IN ('failed', 'ambiguous') OR d.last_error IS NOT NULL OR a.status IN ('failed', 'ambiguous'))",
    );
  }

  return { params, where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}` };
}

function toDeliveryListItem(row: DeliveryListRow) {
  return {
    createdAt: row.createdAt,
    email: row.email,
    id: row.id,
    job:
      row.jobId === null
        ? null
        : {
            attempts: required(row.jobAttempts, "jobAttempts"),
            id: row.jobId,
            lastError: row.jobLastError,
            lockedUntil: row.jobLockedUntil,
            maxAttempts: required(row.jobMaxAttempts, "jobMaxAttempts"),
            runAt: required(row.jobRunAt, "jobRunAt"),
            state: required(row.jobState, "jobState"),
          },
    lastError: row.lastError,
    latestAttempt:
      row.latestAttemptId === null
        ? null
        : {
            attemptNo: required(row.latestAttemptNo, "latestAttemptNo"),
            errorMessage: row.latestAttemptErrorMessage,
            finishedAt: row.latestAttemptFinishedAt,
            id: row.latestAttemptId,
            sesMessageId: row.latestAttemptSesMessageId,
            startedAt: required(row.latestAttemptStartedAt, "latestAttemptStartedAt"),
            status: required(row.latestAttemptStatus, "latestAttemptStatus"),
          },
    mailingId: row.mailingId,
    mailingPurpose: row.mailingPurpose,
    sesMessageId: row.sesMessageId,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}

function toDeliveryDetail(
  row: DeliveryDetailRow,
  job: typeof JobDetailRow.Type | null,
  attempts: readonly (typeof SendAttemptRow.Type)[],
) {
  return {
    attempts,
    delivery: {
      contactId: row.contactId,
      createdAt: row.createdAt,
      email: row.email,
      id: row.id,
      lastError: row.lastError,
      mailingId: row.mailingId,
      sesMessageId: row.sesMessageId,
      status: row.status,
      updatedAt: row.updatedAt,
    },
    job,
    mailing: {
      createdAt: row.mailingCreatedAt,
      id: row.mailingId,
      name: row.mailingName,
      purpose: row.mailingPurpose,
      scheduledAt: row.mailingScheduledAt,
      state: row.mailingState,
      subject: row.mailingSubject,
      updatedAt: row.mailingUpdatedAt,
    },
  };
}

function zeroCounts<const T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`Decoded joined row unexpectedly omitted ${name}.`);
  return value;
}
