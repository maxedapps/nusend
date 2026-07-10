import { describe, expect, it } from "vitest";

import { makeAttemptLimiter } from "./attempt-limiter.ts";

describe("device authorization attempt limiter", () => {
  it("locks after the configured failures and unlocks after the window", () => {
    let now = 1_000;
    const limiter = makeAttemptLimiter({ max: 2, now: () => now, windowMs: 100 });

    limiter.recordFailure("user_1");
    expect(limiter.isLocked("user_1")).toBe(false);
    limiter.recordFailure("user_1");
    expect(limiter.isLocked("user_1")).toBe(true);

    now += 101;
    expect(limiter.isLocked("user_1")).toBe(false);
  });

  it("tracks failures independently by user", () => {
    const limiter = makeAttemptLimiter({ max: 1, windowMs: 100 });

    limiter.recordFailure("user_1");

    expect(limiter.isLocked("user_1")).toBe(true);
    expect(limiter.isLocked("user_2")).toBe(false);
  });
});
