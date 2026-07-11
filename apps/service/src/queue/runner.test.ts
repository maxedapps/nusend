import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import type { CreateMailingInput } from "../mailings/schema.ts";
import { DatabaseError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import {
  EmailTransport,
  EmailTransportError,
  type EmailTransportService,
  type SendResult,
} from "../services/email-transport.ts";
import { fakeEmailTransportLayer, fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { runTest, type CapturedLog, type TestServices } from "../testing/layers.ts";
import { seedJob } from "../testing/queue-fixtures.ts";
import { runSendWorkerOnce, type SendWorkerOnceResult } from "./runner.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

function baseInput(overrides: Partial<CreateMailingInput> = {}): CreateMailingInput {
  return {
    html: "<p>Hello</p>",
    listId: null,
    name: null,
    purpose: "transactional",
    recipients: [{ email: "user@example.com", varsJson: null }],
    scheduledAt: null,
    subject: "Hello",
    text: null,
    ...overrides,
  };
}

function runSendScenario<A, E, R>(effect: Effect.Effect<A, E, R>, logSink?: CapturedLog[]) {
  const fake = fakeEmailTransportLayer();
  const provided = effect.pipe(
    Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer())),
  ) as Effect.Effect<A, E, TestServices>;

  return runTest(provided, { logSink });
}

type StaleLeaseOutcome =
  | { readonly kind: "Fail"; readonly error: EmailTransportError }
  | { readonly kind: "Succeed"; readonly result: SendResult };

type StaleLeaseScenarioResult = {
  readonly job: unknown;
  readonly result: SendWorkerOnceResult;
  readonly workerRun: unknown;
};

function staleLeaseTransportLayer(
  outcome: StaleLeaseOutcome,
): Layer.Layer<EmailTransportService, never, DatabaseService> {
  return Layer.effect(
    EmailTransport,
    Effect.map(Database, (db) => ({
      send: (email) =>
        db
          .run(
            "test:steal-job-lease",
            `UPDATE jobs
             SET locked_by = 'other_worker'
             WHERE delivery_id = $deliveryId;`,
            { deliveryId: email.tags.delivery_id },
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new EmailTransportError({
                  cause,
                  kind: "ambiguous",
                  operation: "test:stale-lease",
                }),
            ),
            Effect.flatMap(() =>
              outcome.kind === "Succeed"
                ? Effect.succeed(outcome.result)
                : Effect.fail(outcome.error),
            ),
          ),
    })),
  );
}

function runStaleLeaseScenario(outcome: StaleLeaseOutcome) {
  const provided = Effect.gen(function* () {
    yield* TestClock.setTime(fixedTime);
    yield* createMailing(baseInput());
    const result = yield* runSendWorkerOnce({ workerId: "worker_1" });
    const db = yield* Database;

    return {
      job: yield* db.get("assert:job", "SELECT state, locked_by AS lockedBy FROM jobs;"),
      result,
      workerRun: yield* db.get(
        "assert:worker-run",
        "SELECT skipped_stale AS skippedStale, succeeded, failed FROM worker_runs;",
      ),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(staleLeaseTransportLayer(outcome), fakeSendingConfigLayer())),
  ) as Effect.Effect<StaleLeaseScenarioResult, never, TestServices>;

  return runTest(provided);
}

describe("send queue runner", () => {
  it("claims and completes due send-delivery jobs with safe cycle logs", async () => {
    const logs: CapturedLog[] = [];
    const outcome = await runSendScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });
        const db = yield* Database;

        return {
          job: yield* db.get("assert:job", "SELECT state, locked_by AS lockedBy FROM jobs;"),
          mailing: yield* db.get("assert:mailing", "SELECT state FROM mailings;"),
          result,
        };
      }),
      logs,
    );

    expect(outcome.result).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      released: 0,
      skippedStale: 0,
      succeeded: 1,
    });
    expect(outcome.job).toEqual({ lockedBy: null, state: "succeeded" });
    expect(outcome.mailing).toEqual({ state: "completed" });
    const serialized = JSON.stringify(logs.map((entry) => entry.message));
    expect(serialized).toContain("send worker cycle completed");
    expect(serialized).toContain('"claimed":1');
    expect(serialized).toContain('"succeeded":1');
    for (const sensitive of [
      "user@example.com",
      "Hello",
      "sender@example.com",
      "unsubscribe-token",
      "api-key",
      "cookie",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it("finalizes the started attempt when the final outcome write dead-letters the job", async () => {
    const fake = fakeEmailTransportLayer();
    const outcome = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* createMailing(baseInput());
        const real = yield* Database;
        yield* real.run("force:max-attempts", "UPDATE jobs SET max_attempts = 1;");

        let failedOutcomeWrite = false;
        const failingDb: DatabaseService = {
          ...real,
          get: <T>(
            operation: string,
            sql: string,
            params?: Record<string, string | number | null>,
          ) => {
            if (operation === "sending:attempt:succeed" && !failedOutcomeWrite) {
              failedOutcomeWrite = true;
              return Effect.fail(
                new DatabaseError({
                  cause: new Error("one-shot outcome write failure"),
                  operation,
                }),
              );
            }
            return real.get<T>(operation, sql, params);
          },
        };

        const firstResult = yield* runSendWorkerOnce({ workerId: "worker_1" }).pipe(
          Effect.provideService(Database, failingDb),
        );
        const secondResult = yield* runSendWorkerOnce({ workerId: "worker_2" });

        return {
          attempt: yield* real.get(
            "assert:attempt",
            `SELECT status, error_message AS errorMessage,
                    CASE WHEN finished_at IS NULL THEN 0 ELSE 1 END AS finished
             FROM send_attempts;`,
          ),
          delivery: yield* real.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          firstResult,
          job: yield* real.get("assert:job", "SELECT state FROM jobs;"),
          mailing: yield* real.get("assert:mailing", "SELECT state FROM mailings;"),
          secondResult,
        };
      }).pipe(Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer()))),
    );

    expect(outcome.firstResult).toMatchObject({ claimed: 1, dead: 1 });
    expect(outcome.job).toEqual({ state: "dead" });
    expect(outcome.delivery).toMatchObject({ status: "failed" });
    expect(outcome.attempt).toMatchObject({ finished: 1, status: "ambiguous" });
    expect(outcome.mailing).toEqual({ state: "completed" });
    expect(outcome.secondResult).toMatchObject({ claimed: 0, dead: 0, failed: 0, succeeded: 0 });
    expect(fake.state.sent).toHaveLength(1);
  });

  it("counts skipped stale leases after processor success", async () => {
    const outcome = await runStaleLeaseScenario({
      kind: "Succeed",
      result: { messageId: "ses_1" },
    });

    expect(outcome.result).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      released: 0,
      skippedStale: 1,
      succeeded: 0,
    });
    expect(outcome.job).toEqual({ lockedBy: "other_worker", state: "leased" });
    expect(outcome.workerRun).toEqual({ skippedStale: 1, succeeded: 0, failed: 0 });
  });

  it("counts skipped stale leases after processor failure", async () => {
    const outcome = await runStaleLeaseScenario({
      error: new EmailTransportError({ kind: "retryable", operation: "ses:send" }),
      kind: "Fail",
    });

    expect(outcome.result).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      released: 0,
      skippedStale: 1,
      succeeded: 0,
    });
    expect(outcome.job).toEqual({ lockedBy: "other_worker", state: "leased" });
    expect(outcome.workerRun).toEqual({ skippedStale: 1, succeeded: 0, failed: 0 });
  });

  it("reconciles expired leases that dead-letter before claiming", async () => {
    const outcome = await runSendScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* seedJob({
          attempts: 1,
          id: "expired_dead",
          lockedBy: "old_worker",
          lockedUntil: "2026-07-03T11:59:00.000Z",
          maxAttempts: 1,
          state: "leased",
        });
        const db = yield* Database;
        yield* db.run(
          "seed:sending-delivery",
          "UPDATE deliveries SET status = 'sending' WHERE id = 'delivery_expired_dead';",
        );
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           VALUES ('attempt_1', 'delivery_expired_dead', 'expired_dead', 1, 'started', '2026-07-03T11:58:00.000Z');`,
        );

        const result = yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          attempt: yield* db.get(
            "assert:attempt",
            "SELECT status, error_message AS errorMessage FROM send_attempts;",
          ),
          delivery: yield* db.get(
            "assert:delivery",
            "SELECT status, last_error AS lastError FROM deliveries;",
          ),
          job: yield* db.get("assert:job", "SELECT state FROM jobs;"),
          mailing: yield* db.get("assert:mailing", "SELECT state FROM mailings;"),
          result,
        };
      }),
    );

    expect(outcome.result).toEqual({
      claimed: 0,
      dead: 1,
      failed: 0,
      released: 1,
      skippedStale: 0,
      succeeded: 0,
    });
    expect(outcome.job).toEqual({ state: "dead" });
    expect(outcome.delivery).toEqual({
      lastError: "Expired send-delivery job reached max attempts.",
      status: "failed",
    });
    expect(outcome.attempt).toEqual({
      errorMessage: "Expired send-delivery job reached max attempts.",
      status: "ambiguous",
    });
    expect(outcome.mailing).toEqual({ state: "completed" });
  });

  it("repairs an orphaned dead job whose delivery is still queued", async () => {
    const outcome = await runSendScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        // A dead job left behind by a crash before reconciliation ran; the
        // delivery is still queued and the mailing still sending.
        yield* seedJob({ id: "orphan", state: "dead" });
        const db = yield* Database;
        yield* db.run(
          "seed:sending-mailing",
          "UPDATE mailings SET state = 'sending' WHERE id = 'mailing_seed';",
        );

        yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          delivery: yield* db.get("assert:delivery", "SELECT status FROM deliveries;"),
          mailing: yield* db.get("assert:mailing", "SELECT state FROM mailings;"),
        };
      }),
    );

    expect(outcome.delivery).toEqual({ status: "failed" });
    expect(outcome.mailing).toEqual({ state: "completed" });
  });

  it("repairs an orphaned dead job whose delivery is stuck sending with a started attempt", async () => {
    const outcome = await runSendScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        yield* seedJob({ id: "orphan", state: "dead" });
        const db = yield* Database;
        yield* db.run(
          "seed:sending-delivery",
          "UPDATE deliveries SET status = 'sending' WHERE id = 'delivery_orphan';",
        );
        yield* db.run(
          "seed:started-attempt",
          `INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
           VALUES ('attempt_1', 'delivery_orphan', 'orphan', 1, 'started', '2026-07-03T11:58:00.000Z');`,
        );

        yield* runSendWorkerOnce({ workerId: "worker_1" });

        return {
          attempt: yield* db.get("assert:attempt", "SELECT status FROM send_attempts;"),
          delivery: yield* db.get("assert:delivery", "SELECT status FROM deliveries;"),
        };
      }),
    );

    // The started attempt must be finalized to ambiguous, not left dangling.
    expect(outcome.attempt).toEqual({ status: "ambiguous" });
    expect(outcome.delivery).toEqual({ status: "failed" });
  });

  it("repairs a mailing stuck sending though all deliveries are terminal", async () => {
    const outcome = await runSendScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        // A crash between the last delivery completing and the mailing refresh:
        // delivery is terminal (sent) but the mailing is still sending, with no
        // dead job to trigger the other sweep.
        yield* seedJob({ id: "done", state: "succeeded" });
        const db = yield* Database;
        yield* db.run(
          "seed:sent-delivery",
          "UPDATE deliveries SET status = 'sent' WHERE id = 'delivery_done';",
        );
        yield* db.run(
          "seed:sending-mailing",
          "UPDATE mailings SET state = 'sending' WHERE id = 'mailing_seed';",
        );

        yield* runSendWorkerOnce({ workerId: "worker_1" });

        return yield* db.get("assert:mailing", "SELECT state FROM mailings;");
      }),
    );

    expect(outcome).toEqual({ state: "completed" });
  });

  it("still returns the cycle result when recording the worker run fails", async () => {
    const result = await runSendScenario(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const real = yield* Database;
        // Fail only the observability worker-runs insert.
        const failingDb: DatabaseService = {
          ...real,
          run: (operation, sql, params) =>
            operation === "worker-runs:insert"
              ? Effect.fail(new DatabaseError({ cause: new Error("locked"), operation }))
              : real.run(operation, sql, params),
        };

        return yield* runSendWorkerOnce({ mode: "loop", workerId: "worker_1" }).pipe(
          Effect.provideService(Database, failingDb),
        );
      }),
    );

    // The cycle succeeds despite the failed worker-run insert (observability only).
    expect(result.succeeded).toBe(0);
    expect(result.claimed).toBe(0);
  });
});
