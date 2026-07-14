import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import type { CreateMailingInput } from "../mailings/schema.ts";
import type { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { runTest } from "../testing/layers.ts";
import {
  recordRetryableFailure,
  recordSendSuccess,
  recordStaleSendingAsAmbiguous,
} from "./attempts.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

function baseInput(): CreateMailingInput {
  return {
    html: "<p>Hello</p>",
    listId: null,
    name: null,
    purpose: "transactional",
    recipients: [{ email: "user@example.com", varsJson: null }],
    scheduledAt: null,
    subject: "Hello",
    text: "Hi",
  };
}

describe("send attempt outcome recording", () => {
  it("ignores late retryable failures after stale ambiguity resolution", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:resolved-delivery",
          `UPDATE deliveries
           SET status = 'failed', last_error = 'stale ambiguity', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:resolved-job",
          "UPDATE jobs SET state = 'succeeded' WHERE id = $jobId;",
          { jobId: row.jobId },
        );
        yield* db.run(
          "seed:ambiguous-attempt",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, error_message, started_at, finished_at
           ) VALUES (
             'attempt_1', $deliveryId, $jobId, 1, 'ambiguous', 'stale ambiguity',
             '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
           );`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordRetryableFailure({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          errorMessage: "late retryable failure",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: "stale ambiguity",
      attemptMessageId: null,
      attemptStatus: "ambiguous",
      deliveryError: "stale ambiguity",
      deliveryMessageId: null,
      deliveryStatus: "failed",
      jobState: "succeeded",
    });
  });

  it("reconciles late exact-attempt MessageId evidence to succeeded and sent", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:resolved-delivery",
          `UPDATE deliveries
           SET status = 'ambiguous', last_error = 'stale ambiguity', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:resolved-job",
          "UPDATE jobs SET state = 'succeeded' WHERE id = $jobId;",
          { jobId: row.jobId },
        );
        yield* db.run(
          "seed:ambiguous-attempt",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, error_message, started_at, finished_at
           ) VALUES (
             'attempt_1', $deliveryId, $jobId, 1, 'ambiguous', 'stale ambiguity',
             '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
           );`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "late-message-id",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: null,
      attemptMessageId: "late-message-id",
      attemptStatus: "succeeded",
      deliveryError: null,
      deliveryMessageId: "late-message-id",
      deliveryStatus: "sent",
      jobState: "succeeded",
    });
  });

  it("does not record retryable failure when the attempt is still started but the delivery is terminal", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:terminal-delivery",
          `UPDATE deliveries
           SET status = 'failed', last_error = 'already resolved', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'started', '2026-07-03T12:00:00.000Z');`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordRetryableFailure({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          errorMessage: "late retryable failure",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: null,
      attemptMessageId: null,
      attemptStatus: "started",
      deliveryError: "already resolved",
      deliveryMessageId: null,
      deliveryStatus: "failed",
      jobState: "queued",
    });
  });

  it("does not attach late MessageId proof to an incompatible terminal delivery", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:terminal-delivery",
          `UPDATE deliveries
           SET status = 'failed', last_error = 'already resolved', updated_at = '2026-07-03T12:00:00.000Z'
           WHERE id = $deliveryId;`,
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'started', '2026-07-03T12:00:00.000Z');`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "late-message-id",
        });

        return yield* currentState();
      }),
    );

    expect(result).toEqual({
      attemptError: null,
      attemptMessageId: null,
      attemptStatus: "started",
      deliveryError: "already resolved",
      deliveryMessageId: null,
      deliveryStatus: "failed",
      jobState: "queued",
    });
  });

  it("is idempotent after reconciling exact late MessageId evidence", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();
        yield* db.run(
          "seed:ambiguous-delivery",
          "UPDATE deliveries SET status = 'ambiguous', last_error = 'unknown' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:ambiguous-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, error_message, started_at, finished_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'ambiguous', 'unknown', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
          row,
        );

        const first = yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "message_1",
        });
        const second = yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "message_1",
        });
        return { first, second, state: yield* currentState() };
      }),
    );

    expect(result.first).toBe("Reconciled");
    expect(result.second).toBe("AlreadyRecorded");
    expect(result.state).toMatchObject({
      attemptMessageId: "message_1",
      attemptStatus: "succeeded",
      deliveryMessageId: "message_1",
      deliveryStatus: "sent",
    });
  });

  it("does not overwrite a conflicting MessageId on an ambiguous exact attempt", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();
        yield* db.run(
          "seed:ambiguous-delivery",
          "UPDATE deliveries SET status = 'ambiguous', last_error = 'unknown' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:ambiguous-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message, started_at, finished_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'ambiguous', 'provider-a', 'unknown', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
          row,
        );

        const writeResult = yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "provider-b",
        });
        return { writeResult, state: yield* currentState() };
      }),
    );

    expect(result.writeResult).toBe("SupersededTerminal");
    expect(result.state).toMatchObject({
      attemptMessageId: "provider-a",
      attemptStatus: "ambiguous",
      deliveryMessageId: null,
      deliveryStatus: "ambiguous",
    });
  });

  it("does not promote a permanently suppressed delivery from a started attempt", async () => {
    const deliveryStatus = "suppressed" as const;
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();
        yield* db.run(
          "seed:terminal-delivery",
          "UPDATE deliveries SET status = $status, last_error = 'terminal' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId, status: deliveryStatus },
        );
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
             VALUES ('attempt_1', $deliveryId, $jobId, 1, 'started', '2026-07-03T12:00:00.000Z');`,
          row,
        );

        const writeResult = yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "late-message",
        });
        return { writeResult, state: yield* currentState() };
      }),
    );

    expect(result.writeResult).toBe("SupersededTerminal");
    expect(result.state).toMatchObject({
      attemptMessageId: null,
      attemptStatus: "started",
      deliveryMessageId: null,
      deliveryStatus,
    });
  });

  it("rolls back the first paired write when the delivery write is not applied", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const real = yield* Database;
        const row = yield* deliveryAndJob();
        yield* real.run(
          "seed:ambiguous-delivery",
          "UPDATE deliveries SET status = 'ambiguous', last_error = 'unknown' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId },
        );
        yield* real.run(
          "seed:ambiguous-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, error_message, started_at, finished_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'ambiguous', 'unknown', '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z');`,
          row,
        );
        const failingDb: DatabaseService = {
          ...real,
          get: <T>(
            operation: string,
            sql: string,
            params?: Record<string, string | number | null>,
          ) =>
            operation === "sending:delivery:succeed"
              ? Effect.succeed(null)
              : real.get<T>(operation, sql, params),
        };

        const exit = yield* Effect.exit(
          recordSendSuccess({
            attemptId: "attempt_1",
            deliveryId: row.deliveryId,
            messageId: "message_1",
          }).pipe(Effect.provideService(Database, failingDb)),
        );
        return { exit, state: yield* currentState() };
      }),
    );

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.state).toMatchObject({
      attemptMessageId: null,
      attemptStatus: "ambiguous",
      deliveryMessageId: null,
      deliveryStatus: "ambiguous",
    });
  });

  it("allows only terminal supersession when a newer attempt exists", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();
        yield* db.run(
          "seed:sending-delivery",
          "UPDATE deliveries SET status = 'sending' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:attempt-1",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           VALUES ('attempt_1', $deliveryId, $jobId, 1, 'started', '2026-07-03T12:00:00.000Z');`,
          row,
        );
        yield* db.run(
          "seed:attempt-2",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, error_message, started_at, finished_at)
           VALUES ('attempt_2', $deliveryId, $jobId, 2, 'failed', 'newer', '2026-07-03T12:00:01.000Z', '2026-07-03T12:00:02.000Z');`,
          row,
        );

        const nonterminal = yield* Effect.exit(
          recordSendSuccess({
            attemptId: "attempt_1",
            deliveryId: row.deliveryId,
            messageId: "late",
          }),
        );
        yield* db.run(
          "seed:terminal-delivery",
          "UPDATE deliveries SET status = 'failed', last_error = 'newer terminal' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId },
        );
        const terminal = yield* recordSendSuccess({
          attemptId: "attempt_1",
          deliveryId: row.deliveryId,
          messageId: "late",
        });
        const attempts = yield* db.all(
          "assert:attempts",
          "SELECT id, status, ses_message_id AS messageId FROM send_attempts ORDER BY attempt_no;",
        );
        return { attempts, nonterminal, terminal };
      }),
    );

    expect(Exit.isFailure(result.nonterminal)).toBe(true);
    expect(result.terminal).toBe("SupersededTerminal");
    expect(result.attempts).toEqual([
      { id: "attempt_1", messageId: null, status: "started" },
      { id: "attempt_2", messageId: null, status: "failed" },
    ]);
  });

  it("fails stale marking when a completed attempt leaves the delivery nonterminal", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const db = yield* Database;
        const row = yield* deliveryAndJob();

        yield* db.run(
          "seed:sending-delivery",
          "UPDATE deliveries SET status = 'sending' WHERE id = $deliveryId;",
          { deliveryId: row.deliveryId },
        );
        yield* db.run(
          "seed:succeeded-attempt",
          `INSERT INTO send_attempts (
             id, delivery_id, job_id, attempt_no, status, ses_message_id, started_at, finished_at
           ) VALUES (
             'attempt_1', $deliveryId, $jobId, 1, 'succeeded', 'message_1',
             '2026-07-03T12:00:00.000Z', '2026-07-03T12:00:00.000Z'
           );`,
          { deliveryId: row.deliveryId, jobId: row.jobId },
        );

        const exit = yield* Effect.exit(
          recordStaleSendingAsAmbiguous({
            deliveryId: row.deliveryId,
            errorMessage: "stale marker",
          }),
        );

        return { exit, state: yield* currentState() };
      }),
    );

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.state).toEqual({
      attemptError: null,
      attemptMessageId: "message_1",
      attemptStatus: "succeeded",
      deliveryError: null,
      deliveryMessageId: null,
      deliveryStatus: "sending",
      jobState: "queued",
    });
  });
});

function deliveryAndJob(): Effect.Effect<
  { deliveryId: string; jobId: string },
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ deliveryId: string; jobId: string }>(
      "test:delivery-job",
      `SELECT deliveries.id AS deliveryId, jobs.id AS jobId
       FROM deliveries
       INNER JOIN jobs ON jobs.delivery_id = deliveries.id
       LIMIT 1;`,
    );
    if (!row) throw new Error("Expected seeded delivery and job.");
    return row;
  });
}

function currentState(): Effect.Effect<
  {
    attemptError: string | null;
    attemptMessageId: string | null;
    attemptStatus: string;
    deliveryError: string | null;
    deliveryMessageId: string | null;
    deliveryStatus: string;
    jobState: string;
  },
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{
      attemptError: string | null;
      attemptMessageId: string | null;
      attemptStatus: string;
      deliveryError: string | null;
      deliveryMessageId: string | null;
      deliveryStatus: string;
      jobState: string;
    }>(
      "test:current-state",
      `SELECT
         send_attempts.error_message AS attemptError,
         send_attempts.ses_message_id AS attemptMessageId,
         send_attempts.status AS attemptStatus,
         deliveries.last_error AS deliveryError,
         deliveries.ses_message_id AS deliveryMessageId,
         deliveries.status AS deliveryStatus,
         jobs.state AS jobState
       FROM deliveries
       INNER JOIN jobs ON jobs.delivery_id = deliveries.id
       INNER JOIN send_attempts ON send_attempts.delivery_id = deliveries.id
       LIMIT 1;`,
    );
    if (!row) throw new Error("Expected current state row.");
    return row;
  });
}
