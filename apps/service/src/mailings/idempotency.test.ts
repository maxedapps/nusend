import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { DatabaseError, RequestValidationError } from "../errors.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import {
  DatabaseNodeLive,
  fakeUnsubscribeConfigLayer,
  runTest,
  sequentialIdsLayer,
} from "../testing/layers.ts";
import { createMailingIdempotent } from "./idempotency.ts";
import type { CreateMailingInput } from "./schema.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

function input(overrides: Partial<CreateMailingInput> = {}): CreateMailingInput {
  return {
    html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
    listId: null,
    name: null,
    purpose: "marketing",
    recipients: [{ email: "user@example.com", varsJson: null }],
    scheduledAt: null,
    subject: "Hello",
    text: null,
    ...overrides,
  };
}

const failingCompliance = Effect.fail(
  new RequestValidationError({ message: "Marketing mailings require unsubscribe configuration." }),
);

describe("createMailingIdempotent", () => {
  it("replays an existing response before running new-create compliance checks", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const first = yield* createMailingIdempotent({
          beforeCreate: Effect.void,
          idempotencyKey: "marketing-1",
          input: input(),
        });
        const replay = yield* createMailingIdempotent({
          beforeCreate: failingCompliance,
          idempotencyKey: "marketing-1",
          input: input(),
        });
        const db = yield* Database;
        return {
          first,
          mailings: yield* db.get<{ count: number }>(
            "assert:mailings",
            "SELECT count(*) AS count FROM mailings;",
          ),
          replay,
        };
      }),
    );

    expect(result.replay).toEqual(result.first);
    expect(result.mailings).toEqual({ count: 1 });
  });

  it("recovers the captured replay through the synthetic UNIQUE branch with zero residue", async () => {
    // The in-transaction pre-check and post-commit serialization make this branch
    // unreachable within one process. This stateful fake injects the UNIQUE error;
    // it is branch coverage, not evidence of real cross-process concurrency.
    const transactionalInput = input({
      html: "<p>Hello</p>",
      purpose: "transactional",
      recipients: [{ email: "user@example.com", varsJson: null }],
    });

    const state: {
      captured: { requestHash: string; responseJson: string } | null;
      residueBeforeReplay: Record<string, { count: number } | null> | null;
    } = { captured: null, residueBeforeReplay: null };
    const racingDatabaseLayer = Layer.effect(
      Database,
      Effect.map(
        Database,
        (real): DatabaseService => ({
          ...real,
          get: <T>(
            operation: string,
            sql: string,
            params?: Record<string, string | number | null>,
          ) => {
            const capturedReplay = state.captured;
            if (operation === "mailing-idempotency:get" && capturedReplay) {
              return Effect.gen(function* () {
                state.residueBeforeReplay = {
                  deliveries: yield* real.get<{ count: number }>(
                    "assert:rollback-deliveries",
                    "SELECT count(*) AS count FROM deliveries;",
                  ),
                  idempotency: yield* real.get<{ count: number }>(
                    "assert:rollback-idempotency",
                    "SELECT count(*) AS count FROM mailing_idempotency_keys;",
                  ),
                  jobs: yield* real.get<{ count: number }>(
                    "assert:rollback-jobs",
                    "SELECT count(*) AS count FROM jobs;",
                  ),
                  mailings: yield* real.get<{ count: number }>(
                    "assert:rollback-mailings",
                    "SELECT count(*) AS count FROM mailings;",
                  ),
                };
                return {
                  requestHash: capturedReplay.requestHash,
                  responseJson: capturedReplay.responseJson,
                } as T;
              });
            }
            return real.get<T>(operation, sql, params);
          },
          run: (operation, sql, params) => {
            if (operation === "mailing-idempotency:insert" && !state.captured && params) {
              state.captured = {
                requestHash: String(params.requestHash),
                responseJson: String(params.responseJson),
              };
              return Effect.fail(
                new DatabaseError({
                  cause: new Error("UNIQUE constraint failed: mailing_idempotency_keys.key"),
                  operation: "mailing-idempotency:insert",
                }),
              );
            }
            return real.run(operation, sql, params);
          },
        }),
      ),
    ).pipe(Layer.provide(DatabaseNodeLive(":memory:")));

    const replay = await Effect.runPromise(
      createMailingIdempotent({
        beforeCreate: Effect.void,
        idempotencyKey: "racing-key",
        input: transactionalInput,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            racingDatabaseLayer,
            sequentialIdsLayer("id"),
            fakeUnsubscribeConfigLayer(),
          ),
        ),
      ),
    );

    expect(state.captured).not.toBeNull();
    expect(replay).toEqual(JSON.parse(state.captured?.responseJson ?? "null"));
    expect(state.residueBeforeReplay).toEqual({
      deliveries: { count: 0 },
      idempotency: { count: 0 },
      jobs: { count: 0 },
      mailings: { count: 0 },
    });
  });

  it("serializes concurrent same-key requests into one create and one replay", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const [first, second] = yield* Effect.all(
          [
            createMailingIdempotent({
              beforeCreate: Effect.void,
              idempotencyKey: "concurrent-1",
              input: input(),
            }),
            createMailingIdempotent({
              beforeCreate: Effect.void,
              idempotencyKey: "concurrent-1",
              input: input(),
            }),
          ],
          { concurrency: "unbounded" },
        );
        const db = yield* Database;
        return {
          first,
          mailings: yield* db.get<{ count: number }>(
            "assert:mailings",
            "SELECT count(*) AS count FROM mailings;",
          ),
          second,
        };
      }),
    );

    // One request created; the other replayed the same snapshot — no 500, one mailing.
    expect(result.second).toEqual(result.first);
    expect(result.mailings).toEqual({ count: 1 });
  });

  it("hashes requests independent of vars key order (canonicalization contract)", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(fixedTime);
        const first = yield* createMailingIdempotent({
          beforeCreate: Effect.void,
          idempotencyKey: "canonical-1",
          input: input({
            purpose: "transactional",
            recipients: [{ email: "user@example.com", varsJson: '{"a":"1","b":"2"}' }],
          }),
        });
        // Same request, vars with keys in a different order — must hash equal and
        // replay, not 409-conflict.
        const replay = yield* createMailingIdempotent({
          beforeCreate: Effect.void,
          idempotencyKey: "canonical-1",
          input: input({
            purpose: "transactional",
            recipients: [{ email: "user@example.com", varsJson: '{"b":"2","a":"1"}' }],
          }),
        });
        return { first, replay };
      }),
    );

    expect(result.replay).toEqual(result.first);
  });

  it("keeps same-key different-body conflicts ahead of new-create compliance checks", async () => {
    await expect(
      runTest(
        Effect.gen(function* () {
          yield* TestClock.setTime(fixedTime);
          yield* createMailingIdempotent({
            beforeCreate: Effect.void,
            idempotencyKey: "marketing-conflict",
            input: input(),
          });
          return yield* createMailingIdempotent({
            beforeCreate: failingCompliance,
            idempotencyKey: "marketing-conflict",
            input: input({ subject: "Different" }),
          });
        }),
      ),
    ).rejects.toMatchObject({ _tag: "IdempotencyConflictError" });
  });
});
