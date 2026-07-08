import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { RequestValidationError } from "../errors.ts";
import { Database } from "../services/database.ts";
import { runTest } from "../testing/layers.ts";
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
