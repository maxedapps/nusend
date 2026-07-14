import { Effect } from "effect";

import { DatabaseError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { markMailingSending } from "../mailings/lifecycle.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import type { DeliveryContext, DeliveryStatus, StartedAttempt } from "./schema.ts";

const maxStoredErrorLength = 2000;

export type StartAttemptResult =
  | { readonly kind: "Started"; readonly attempt: StartedAttempt }
  | { readonly kind: "Skipped"; readonly status: DeliveryStatus | null };

export type AttemptWriteResult =
  | "Recorded"
  | "Reconciled"
  | "AlreadyRecorded"
  | "SupersededTerminal";

type PairState = {
  readonly attemptError: string | null;
  readonly attemptMessageId: string | null;
  readonly attemptNo: number | null;
  readonly attemptStatus: string | null;
  readonly deliveryError: string | null;
  readonly deliveryMessageId: string | null;
  readonly deliveryStatus: DeliveryStatus;
  readonly latestAttemptNo: number | null;
};

export function startSendAttempt(
  context: DeliveryContext,
): Effect.Effect<StartAttemptResult, DatabaseError, DatabaseService | IdGeneratorService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;

    return yield* db.transaction(
      Effect.gen(function* () {
        const now = yield* currentIso;
        const claimed = yield* db.get<{ id: string }>(
          "sending:delivery:mark-sending",
          `UPDATE deliveries
           SET status = 'sending', last_error = NULL, updated_at = $now
           WHERE id = $deliveryId AND status = 'queued'
           RETURNING id;`,
          { deliveryId: context.delivery.id, now },
        );

        if (!claimed) {
          const row = yield* db.get<{ status: DeliveryStatus }>(
            "sending:delivery:reload-status",
            "SELECT status FROM deliveries WHERE id = $deliveryId;",
            { deliveryId: context.delivery.id },
          );
          return { kind: "Skipped" as const, status: row?.status ?? null };
        }

        yield* markMailingSending(context.delivery.mailingId);

        const count = yield* db.get<{ count: number }>(
          "sending:attempt:count",
          "SELECT count(*) AS count FROM send_attempts WHERE delivery_id = $deliveryId;",
          { deliveryId: context.delivery.id },
        );
        const attemptNo = (count?.count ?? 0) + 1;
        const attemptId = yield* ids.next;

        yield* db.run(
          "sending:attempt:insert",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, started_at
           ) VALUES (
             $id, $deliveryId, $jobId, $attemptNo, 'started', $now
           );`,
          {
            attemptNo,
            deliveryId: context.delivery.id,
            id: attemptId,
            jobId: context.job.id,
            now,
          },
        );

        return { kind: "Started" as const, attempt: { attemptId, attemptNo } };
      }),
    );
  });
}

export function recordSendSuccess(options: {
  attemptId: string;
  deliveryId: string;
  messageId: string;
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;

    return yield* db.transaction(
      Effect.gen(function* () {
        const now = yield* currentIso;
        const before = yield* readPairState(db, options);
        if (isAlreadySent(before, options.messageId)) return "AlreadyRecorded";

        const normal = before.attemptStatus === "started" && before.deliveryStatus === "sending";
        const reconciliation =
          before.attemptStatus === "ambiguous" && before.deliveryStatus === "ambiguous";
        const exactLatest =
          before.attemptNo !== null && before.attemptNo === before.latestAttemptNo;
        const compatible =
          compatibleMessageId(before.attemptMessageId, options.messageId) &&
          compatibleMessageId(before.deliveryMessageId, options.messageId);

        if ((!normal && !reconciliation) || !exactLatest || !compatible) {
          return yield* classifyIncompatible(before, "sending:success:inconsistent");
        }

        const attempt = yield* db.get<{ id: string }>(
          "sending:attempt:succeed",
          `UPDATE send_attempts
           SET status = 'succeeded', ses_message_id = $messageId,
               error_message = NULL, finished_at = $now
           WHERE id = $attemptId
             AND delivery_id = $deliveryId
             AND status = $expectedAttemptStatus
             AND (ses_message_id IS NULL OR ses_message_id = $messageId)
             AND attempt_no = (
               SELECT MAX(candidate.attempt_no)
               FROM send_attempts candidate
               WHERE candidate.delivery_id = $deliveryId
             )
           RETURNING id;`,
          {
            attemptId: options.attemptId,
            deliveryId: options.deliveryId,
            expectedAttemptStatus: reconciliation ? "ambiguous" : "started",
            messageId: options.messageId,
            now,
          },
        );
        if (!attempt) return yield* readBackSuccess(db, options);

        const delivery = yield* db.get<{ id: string }>(
          "sending:delivery:succeed",
          `UPDATE deliveries
           SET status = 'sent', ses_message_id = $messageId,
               last_error = NULL, updated_at = $now
           WHERE id = $deliveryId
             AND status = $expectedDeliveryStatus
             AND (ses_message_id IS NULL OR ses_message_id = $messageId)
             AND EXISTS (
               SELECT 1
               FROM send_attempts exact
               WHERE exact.id = $attemptId
                 AND exact.delivery_id = $deliveryId
                 AND exact.status = 'succeeded'
                 AND exact.ses_message_id = $messageId
                 AND exact.attempt_no = (
                   SELECT MAX(candidate.attempt_no)
                   FROM send_attempts candidate
                   WHERE candidate.delivery_id = $deliveryId
                 )
             )
           RETURNING id;`,
          {
            attemptId: options.attemptId,
            deliveryId: options.deliveryId,
            expectedDeliveryStatus: reconciliation ? "ambiguous" : "sending",
            messageId: options.messageId,
            now,
          },
        );
        if (!delivery) {
          const readBack = yield* readPairState(db, options);
          if (isAlreadySent(readBack, options.messageId)) return "AlreadyRecorded";
          return yield* inconsistent("sending:success:half-pair");
        }

        const after = yield* readPairState(db, options);
        if (!isAlreadySent(after, options.messageId)) {
          return yield* inconsistent("sending:success:read-back");
        }
        return reconciliation ? "Reconciled" : "Recorded";
      }),
    );
  });
}

export function recordPermanentFailure(options: {
  attemptId: string;
  deliveryId: string;
  errorMessage: string;
  status?: "failed" | "suppressed";
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return recordFailure({
    ...options,
    attemptStatus: "failed",
    deliveryStatus: options.status ?? "failed",
  });
}

export function recordRetryableFailure(options: {
  attemptId: string;
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return recordFailure({ ...options, attemptStatus: "failed", deliveryStatus: "queued" });
}

export function recordAmbiguousFailure(options: {
  attemptId: string;
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return recordFailure({ ...options, attemptStatus: "ambiguous", deliveryStatus: "ambiguous" });
}

export function markDeliveryFailedForDeadJob(options: {
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const errorMessage = truncate(options.errorMessage);

    return yield* db.transaction(
      Effect.gen(function* () {
        const now = yield* currentIso;
        const updated = yield* db.get<{ id: string }>(
          "sending:delivery:dead-job-failed",
          `UPDATE deliveries
           SET status = 'failed', last_error = $errorMessage, updated_at = $now
           WHERE id = $deliveryId AND status = 'queued'
           RETURNING id;`,
          { deliveryId: options.deliveryId, errorMessage, now },
        );
        if (updated) return "Recorded";

        const delivery = yield* db.get<{ status: DeliveryStatus }>(
          "sending:delivery:dead-job-read-back",
          "SELECT status FROM deliveries WHERE id = $deliveryId;",
          { deliveryId: options.deliveryId },
        );
        if (delivery && isTerminal(delivery.status)) return "SupersededTerminal";
        return yield* inconsistent("sending:delivery:dead-job-inconsistent");
      }),
    );
  });
}

export function reconcileDeadJobDelivery(options: {
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const delivery = yield* db.get<{ status: DeliveryStatus }>(
      "sending:delivery:dead-job-status",
      "SELECT status FROM deliveries WHERE id = $deliveryId;",
      { deliveryId: options.deliveryId },
    );
    if (!delivery) return yield* inconsistent("sending:delivery:dead-job-missing");
    if (delivery.status === "queued") return yield* markDeliveryFailedForDeadJob(options);
    if (delivery.status === "sending") return yield* recordStaleSendingAsAmbiguous(options);
    if (isTerminal(delivery.status)) return "SupersededTerminal";
    return yield* inconsistent("sending:delivery:dead-job-inconsistent");
  });
}

export function recordStaleSendingAsAmbiguous(options: {
  deliveryId: string;
  errorMessage: string;
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const errorMessage = truncate(options.errorMessage);

    return yield* db.transaction(
      Effect.gen(function* () {
        const now = yield* currentIso;
        const before = yield* readLatestPairState(db, options.deliveryId);
        if (
          before.attemptStatus === "ambiguous" &&
          before.deliveryStatus === "ambiguous" &&
          before.attemptNo === before.latestAttemptNo
        ) {
          return "AlreadyRecorded";
        }
        if (before.attemptStatus !== "started" || before.deliveryStatus !== "sending") {
          return yield* classifyIncompatible(before, "sending:stale:inconsistent");
        }

        const attempt = yield* db.get<{ id: string }>(
          "sending:attempt:stale-ambiguous",
          `UPDATE send_attempts
           SET status = 'ambiguous', error_message = $errorMessage, finished_at = $now
           WHERE id = $attemptId
             AND delivery_id = $deliveryId
             AND status = 'started'
             AND attempt_no = (
               SELECT MAX(candidate.attempt_no)
               FROM send_attempts candidate
               WHERE candidate.delivery_id = $deliveryId
             )
           RETURNING id;`,
          {
            attemptId: before.attemptId,
            deliveryId: options.deliveryId,
            errorMessage,
            now,
          },
        );
        if (!attempt) return yield* readBackStale(db, options.deliveryId);

        const delivery = yield* db.get<{ id: string }>(
          "sending:delivery:stale-ambiguous",
          `UPDATE deliveries
           SET status = 'ambiguous', last_error = $errorMessage, updated_at = $now
           WHERE id = $deliveryId
             AND status = 'sending'
             AND EXISTS (
               SELECT 1
               FROM send_attempts exact
               WHERE exact.id = $attemptId
                 AND exact.delivery_id = $deliveryId
                 AND exact.status = 'ambiguous'
                 AND exact.attempt_no = (
                   SELECT MAX(candidate.attempt_no)
                   FROM send_attempts candidate
                   WHERE candidate.delivery_id = $deliveryId
                 )
             )
           RETURNING id;`,
          {
            attemptId: before.attemptId,
            deliveryId: options.deliveryId,
            errorMessage,
            now,
          },
        );
        if (!delivery) {
          const readBack = yield* readLatestPairState(db, options.deliveryId);
          if (
            readBack.attemptStatus === "ambiguous" &&
            readBack.deliveryStatus === "ambiguous" &&
            readBack.attemptNo === readBack.latestAttemptNo
          ) {
            return "AlreadyRecorded";
          }
          return yield* inconsistent("sending:stale:half-pair");
        }

        const after = yield* readLatestPairState(db, options.deliveryId);
        if (
          after.attemptStatus !== "ambiguous" ||
          after.deliveryStatus !== "ambiguous" ||
          after.attemptNo !== after.latestAttemptNo
        ) {
          return yield* inconsistent("sending:stale:read-back");
        }
        return "Recorded";
      }),
    );
  });
}

function recordFailure(options: {
  attemptId: string;
  attemptStatus: "ambiguous" | "failed";
  deliveryId: string;
  deliveryStatus: "ambiguous" | "failed" | "queued" | "suppressed";
  errorMessage: string;
}): Effect.Effect<AttemptWriteResult, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const errorMessage = truncate(options.errorMessage);

    return yield* db.transaction(
      Effect.gen(function* () {
        const now = yield* currentIso;
        const before = yield* readPairState(db, options);
        if (isAlreadyFailed(before, options, errorMessage)) return "AlreadyRecorded";
        if (
          before.attemptStatus !== "started" ||
          before.deliveryStatus !== "sending" ||
          before.attemptNo === null ||
          before.attemptNo !== before.latestAttemptNo
        ) {
          return yield* classifyIncompatible(before, "sending:failure:inconsistent");
        }

        const attempt = yield* db.get<{ id: string }>(
          "sending:attempt:fail",
          `UPDATE send_attempts
           SET status = $attemptStatus, error_message = $errorMessage, finished_at = $now
           WHERE id = $attemptId
             AND delivery_id = $deliveryId
             AND status = 'started'
             AND attempt_no = (
               SELECT MAX(candidate.attempt_no)
               FROM send_attempts candidate
               WHERE candidate.delivery_id = $deliveryId
             )
           RETURNING id;`,
          {
            attemptId: options.attemptId,
            attemptStatus: options.attemptStatus,
            deliveryId: options.deliveryId,
            errorMessage,
            now,
          },
        );
        if (!attempt) return yield* readBackFailure(db, options, errorMessage);

        const delivery = yield* db.get<{ id: string }>(
          "sending:delivery:fail",
          `UPDATE deliveries
           SET status = $deliveryStatus, last_error = $errorMessage, updated_at = $now
           WHERE id = $deliveryId
             AND status = 'sending'
             AND EXISTS (
               SELECT 1
               FROM send_attempts exact
               WHERE exact.id = $attemptId
                 AND exact.delivery_id = $deliveryId
                 AND exact.status = $attemptStatus
                 AND exact.attempt_no = (
                   SELECT MAX(candidate.attempt_no)
                   FROM send_attempts candidate
                   WHERE candidate.delivery_id = $deliveryId
                 )
             )
           RETURNING id;`,
          {
            attemptId: options.attemptId,
            attemptStatus: options.attemptStatus,
            deliveryId: options.deliveryId,
            deliveryStatus: options.deliveryStatus,
            errorMessage,
            now,
          },
        );
        if (!delivery) {
          const readBack = yield* readPairState(db, options);
          if (isAlreadyFailed(readBack, options, errorMessage)) return "AlreadyRecorded";
          return yield* inconsistent("sending:failure:half-pair");
        }

        const after = yield* readPairState(db, options);
        if (!isAlreadyFailed(after, options, errorMessage)) {
          return yield* inconsistent("sending:failure:read-back");
        }
        return "Recorded";
      }),
    );
  });
}

function readPairState(
  db: DatabaseService,
  options: { attemptId: string; deliveryId: string },
): Effect.Effect<PairState, DatabaseError> {
  return Effect.gen(function* () {
    const row = yield* db.get<PairState>(
      "sending:pair:read",
      `SELECT
         a.status AS attemptStatus,
         a.attempt_no AS attemptNo,
         a.ses_message_id AS attemptMessageId,
         a.error_message AS attemptError,
         d.status AS deliveryStatus,
         d.ses_message_id AS deliveryMessageId,
         d.last_error AS deliveryError,
         (SELECT MAX(candidate.attempt_no)
          FROM send_attempts candidate
          WHERE candidate.delivery_id = d.id) AS latestAttemptNo
       FROM deliveries d
       LEFT JOIN send_attempts a
         ON a.id = $attemptId AND a.delivery_id = d.id
       WHERE d.id = $deliveryId;`,
      { attemptId: options.attemptId, deliveryId: options.deliveryId },
    );
    if (!row) return yield* inconsistent("sending:pair:missing-delivery");
    return row;
  });
}

function readLatestPairState(
  db: DatabaseService,
  deliveryId: string,
): Effect.Effect<PairState & { readonly attemptId: string | null }, DatabaseError> {
  return Effect.gen(function* () {
    const row = yield* db.get<PairState & { attemptId: string | null }>(
      "sending:pair:read-latest",
      `SELECT
         a.id AS attemptId,
         a.status AS attemptStatus,
         a.attempt_no AS attemptNo,
         a.ses_message_id AS attemptMessageId,
         a.error_message AS attemptError,
         d.status AS deliveryStatus,
         d.ses_message_id AS deliveryMessageId,
         d.last_error AS deliveryError,
         (SELECT MAX(candidate.attempt_no)
          FROM send_attempts candidate
          WHERE candidate.delivery_id = d.id) AS latestAttemptNo
       FROM deliveries d
       LEFT JOIN send_attempts a
         ON a.delivery_id = d.id
        AND a.attempt_no = (
          SELECT MAX(candidate.attempt_no)
          FROM send_attempts candidate
          WHERE candidate.delivery_id = d.id
        )
       WHERE d.id = $deliveryId;`,
      { deliveryId },
    );
    if (!row) return yield* inconsistent("sending:pair:missing-delivery");
    return row;
  });
}

function readBackSuccess(
  db: DatabaseService,
  options: { attemptId: string; deliveryId: string; messageId: string },
): Effect.Effect<AttemptWriteResult, DatabaseError> {
  return Effect.flatMap(readPairState(db, options), (state) =>
    isAlreadySent(state, options.messageId)
      ? Effect.succeed("AlreadyRecorded" as const)
      : classifyIncompatible(state, "sending:success:zero-row"),
  );
}

function readBackFailure(
  db: DatabaseService,
  options: {
    attemptId: string;
    attemptStatus: "ambiguous" | "failed";
    deliveryId: string;
    deliveryStatus: "ambiguous" | "failed" | "queued" | "suppressed";
  },
  errorMessage: string,
): Effect.Effect<AttemptWriteResult, DatabaseError> {
  return Effect.flatMap(readPairState(db, options), (state) =>
    isAlreadyFailed(state, options, errorMessage)
      ? Effect.succeed("AlreadyRecorded" as const)
      : classifyIncompatible(state, "sending:failure:zero-row"),
  );
}

function readBackStale(
  db: DatabaseService,
  deliveryId: string,
): Effect.Effect<AttemptWriteResult, DatabaseError> {
  return Effect.flatMap(readLatestPairState(db, deliveryId), (state) =>
    state.attemptStatus === "ambiguous" &&
    state.deliveryStatus === "ambiguous" &&
    state.attemptNo === state.latestAttemptNo
      ? Effect.succeed("AlreadyRecorded" as const)
      : classifyIncompatible(state, "sending:stale:zero-row"),
  );
}

function isAlreadySent(state: PairState, messageId: string): boolean {
  return (
    state.attemptStatus === "succeeded" &&
    state.attemptMessageId === messageId &&
    state.deliveryStatus === "sent" &&
    state.deliveryMessageId === messageId &&
    state.attemptNo !== null &&
    state.attemptNo === state.latestAttemptNo
  );
}

function isAlreadyFailed(
  state: PairState,
  options: {
    attemptStatus: "ambiguous" | "failed";
    deliveryStatus: "ambiguous" | "failed" | "queued" | "suppressed";
  },
  errorMessage: string,
): boolean {
  return (
    state.attemptStatus === options.attemptStatus &&
    state.attemptError === errorMessage &&
    state.deliveryStatus === options.deliveryStatus &&
    state.deliveryError === errorMessage &&
    state.attemptNo !== null &&
    state.attemptNo === state.latestAttemptNo
  );
}

function compatibleMessageId(current: string | null, incoming: string): boolean {
  return current === null || current === incoming;
}

function classifyIncompatible(
  state: Pick<PairState, "deliveryStatus">,
  operation: string,
): Effect.Effect<AttemptWriteResult, DatabaseError> {
  return isTerminal(state.deliveryStatus)
    ? Effect.succeed("SupersededTerminal")
    : inconsistent(operation);
}

function isTerminal(status: DeliveryStatus): boolean {
  return (
    status === "sent" || status === "failed" || status === "suppressed" || status === "ambiguous"
  );
}

function inconsistent(operation: string): Effect.Effect<never, DatabaseError> {
  return Effect.fail(
    new DatabaseError({
      cause: new Error("Inconsistent paired send outcome state."),
      operation,
    }),
  );
}

function truncate(message: string): string {
  return message.slice(0, maxStoredErrorLength);
}
