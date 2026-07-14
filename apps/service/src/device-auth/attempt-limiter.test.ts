import { describe, expect, it } from "vitest";

import { makeAttemptLimiter } from "./attempt-limiter.ts";

describe("device authorization attempt limiter", () => {
  it("atomically records allowed attempts and returns the exact rate-limit retry", () => {
    let now = 1_000;
    const limiter = makeAttemptLimiter({
      max: 2,
      maxEntries: 2,
      now: () => now,
      windowMs: 100,
    });

    expect(limiter.attempt("user_1")).toEqual({ kind: "Allowed" });
    expect(limiter.attempt("user_1")).toEqual({ kind: "Allowed" });
    expect(limiter.attempt("user_1")).toEqual({
      kind: "Limited",
      reason: "rate",
      retryAfterMs: 100,
    });

    // Rejection records nothing: the original oldest attempt still determines
    // the exact retry and both timestamps expire together.
    now += 40;
    expect(limiter.attempt("user_1")).toEqual({
      kind: "Limited",
      reason: "rate",
      retryAfterMs: 60,
    });
    now += 60;
    expect(limiter.attempt("user_1")).toEqual({ kind: "Allowed" });
  });

  it("fails closed at key capacity without exceeding the key or timestamp bounds", () => {
    let now = 5_000;
    const limiter = makeAttemptLimiter({
      max: 2,
      maxEntries: 2,
      now: () => now,
      windowMs: 1_000,
    });

    expect(limiter.attempt("first")).toEqual({ kind: "Allowed" });
    now += 100;
    expect(limiter.attempt("second")).toEqual({ kind: "Allowed" });
    expect(limiter.diagnostics()).toEqual({ activeKeys: 2 });

    expect(limiter.attempt("third")).toEqual({
      kind: "Limited",
      reason: "capacity",
      retryAfterMs: 900,
    });
    expect(limiter.diagnostics()).toEqual({ activeKeys: 2 });

    // Repeated capacity and rate rejection cannot append timestamps.
    expect(limiter.attempt("third").kind).toBe("Limited");
    expect(limiter.attempt("first")).toMatchObject({ kind: "Allowed" });
    expect(limiter.attempt("first")).toMatchObject({ kind: "Limited", reason: "rate" });
    expect(limiter.diagnostics()).toEqual({ activeKeys: 2 });
  });

  it("globally reclaims stale unrelated keys before admitting a new key", () => {
    let now = 10_000;
    const limiter = makeAttemptLimiter({
      max: 1,
      maxEntries: 2,
      now: () => now,
      windowMs: 1_000,
    });

    expect(limiter.attempt("oldest")).toEqual({ kind: "Allowed" });
    now += 500;
    expect(limiter.attempt("newer")).toEqual({ kind: "Allowed" });

    now += 500;
    expect(limiter.attempt("replacement")).toEqual({ kind: "Allowed" });
    expect(limiter.diagnostics()).toEqual({ activeKeys: 2 });
    expect(limiter.attempt("oldest")).toEqual({
      kind: "Limited",
      reason: "capacity",
      retryAfterMs: 500,
    });
  });
});
