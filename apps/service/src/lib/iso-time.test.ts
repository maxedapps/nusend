import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { runTest } from "../testing/layers.ts";
import { addSecondsIso, currentIso, parseLenientDateToIso, toIso } from "./iso-time.ts";

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("iso time helpers", () => {
  it("returns fixed-width UTC ISO timestamps", () => {
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(addSecondsIso("2026-07-03T12:00:00.000Z", 60)).toBe("2026-07-03T12:01:00.000Z");
    expect(addSecondsIso("2026-07-03T12:00:00.000Z", 60)).toMatch(isoPattern);
  });

  it("parses lenient dates to ISO and rejects garbage", () => {
    expect(parseLenientDateToIso("2026-07-03T12:00:00.000Z")).toBe("2026-07-03T12:00:00.000Z");
    expect(parseLenientDateToIso("2026-07-03")).toBe("2026-07-03T00:00:00.000Z");
    expect(parseLenientDateToIso("not-a-date")).toBeNull();
  });

  it("rejects expanded-year dates that would not sort as ISO text", () => {
    expect(parseLenientDateToIso("+010000-01-01T00:00:00.000Z")).toBeNull();
    expect(parseLenientDateToIso("-000001-01-01T00:00:00.000Z")).toBeNull();
    expect(parseLenientDateToIso("9999-12-31T23:59:59.999Z")).toBe("9999-12-31T23:59:59.999Z");
  });

  it("reads the current time from the Clock", async () => {
    const observed = await runTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-07-03T12:34:56.789Z"));
        return yield* currentIso;
      }),
    );

    expect(observed).toBe("2026-07-03T12:34:56.789Z");
  });
});
