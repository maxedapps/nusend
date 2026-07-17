import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { MailingCountsSchema, type MailingCounts } from "./schema.js";

const currentCounts = {
  ambiguous: 0,
  failed: 1,
  queued: 2,
  sending: 3,
  sent: 4,
  suppressed: 5,
};

describe("MailingCountsSchema", () => {
  it("decodes the current six-count payload", async () => {
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(MailingCountsSchema)(currentCounts)),
    ).resolves.toEqual(currentCounts);
    expectTypeOf<MailingCounts["ambiguous"]>().toEqualTypeOf<number>();
  });

  it("rejects a payload without counts.ambiguous", async () => {
    const { ambiguous: _omitted, ...missingAmbiguous } = currentCounts;

    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(MailingCountsSchema)(missingAmbiguous)),
    ).rejects.toThrow(/ambiguous/);
  });
});
