import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { IdGenerator } from "../services/ids.ts";
import { currentIso } from "../lib/iso-time.ts";
import { runTest } from "./layers.ts";

describe("test layers", () => {
  it("drives Clock reads through TestClock.setTime across steps", async () => {
    const observed = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:00:00.000Z"));
        const first = yield* currentIso;

        yield* TestClock.setTime(Date.parse("2026-07-03T12:01:00.000Z"));
        const second = yield* Clock.currentTimeMillis;

        return { first, second };
      }),
    );

    expect(observed.first).toBe("2026-07-03T12:00:00.000Z");
    expect(observed.second).toBe(Date.parse("2026-07-03T12:01:00.000Z"));
  });

  it("draws ids from a fixed list and falls back after exhaustion", async () => {
    const ids = await runTest(
      Effect.gen(function* () {
        const generator = yield* IdGenerator;
        return [yield* generator.next, yield* generator.next, yield* generator.next];
      }),
      { ids: ["first", "second"] },
    );

    expect(ids).toEqual(["first", "second", "fallback"]);
  });

  it("generates sequential ids with the configured prefix", async () => {
    const ids = await runTest(
      Effect.gen(function* () {
        const generator = yield* IdGenerator;
        return [yield* generator.next, yield* generator.next, yield* generator.next];
      }),
      { idPrefix: "mailing" },
    );

    expect(ids).toEqual(["mailing_1", "mailing_2", "mailing_3"]);
  });
});
