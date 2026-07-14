import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { MailingCountsSchema, type MailingCounts } from "./schema.js";

describe("MailingCountsSchema", () => {
  it("decodes old five-count wire payloads with a required ambiguous zero", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(MailingCountsSchema)({
        failed: 1,
        queued: 2,
        sending: 3,
        sent: 4,
        suppressed: 5,
      }),
    );

    expect(decoded).toEqual({
      ambiguous: 0,
      failed: 1,
      queued: 2,
      sending: 3,
      sent: 4,
      suppressed: 5,
    });
    expectTypeOf<MailingCounts["ambiguous"]>().toEqualTypeOf<number>();
  });
});
