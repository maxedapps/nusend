import { describe, expect, it } from "vitest";

import { addSecondsIso, nowIso } from "./time.ts";

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("queue time helpers", () => {
  it("returns fixed-width UTC ISO timestamps", () => {
    expect(nowIso()).toMatch(isoPattern);
    expect(addSecondsIso("2026-07-03T12:00:00.000Z", 60)).toBe("2026-07-03T12:01:00.000Z");
    expect(addSecondsIso("2026-07-03T12:00:00.000Z", 60)).toMatch(isoPattern);
  });

  it("preserves lexicographic chronological order", () => {
    const earlier = "2026-07-03T12:00:00.000Z";
    const later = addSecondsIso(earlier, 90);

    expect(earlier < later).toBe(true);
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});
