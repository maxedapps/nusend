import { describe, expect, it } from "vitest";

import { calculateBackoffSeconds } from "./backoff.ts";

describe("calculateBackoffSeconds", () => {
  it("uses deterministic capped exponential backoff", () => {
    expect(calculateBackoffSeconds(1)).toBe(60);
    expect(calculateBackoffSeconds(2)).toBe(120);
    expect(calculateBackoffSeconds(3)).toBe(240);
    expect(calculateBackoffSeconds(7)).toBe(3600);
    expect(calculateBackoffSeconds(20)).toBe(3600);
  });

  it("rejects invalid attempts predictably", () => {
    expect(() => calculateBackoffSeconds(0)).toThrow("positive integer");
    expect(() => calculateBackoffSeconds(1.5)).toThrow("positive integer");
  });
});
