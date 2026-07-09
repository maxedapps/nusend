import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import type { CreateMailingInput } from "../mailings/schema.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import {
  EmailTransport,
  EmailTransportError,
  type EmailTransportService,
  type SendResult,
} from "../services/email-transport.ts";
import { fakeEmailTransportLayer, fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { runTest, type TestServices } from "../testing/layers.ts";
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

function runSendScenario<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const fake = fakeEmailTransportLayer();
  const provided = effect.pipe(
    Effect.provide(Layer.mergeAll(fake.layer, fakeSendingConfigLayer())),
  ) as Effect.Effect<A, E, TestServices>;

  return runTest(provided);
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
  it("claims and completes due send-delivery jobs", async () => {
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
});
