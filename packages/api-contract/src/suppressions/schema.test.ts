import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CreateSuppressionRequestSchema,
  CreateSuppressionResponseSchema,
  SuppressionsListResponseSchema,
  type Suppression,
} from "./schema.js";

const suppression = {
  createdAt: "2026-07-03T12:00:00.000Z",
  email: "user@example.com",
  id: "suppression_1",
  listId: null,
  reason: "manual",
  scope: "marketing",
};

describe("suppression wire schemas", () => {
  it("decodes create requests and responses", () => {
    const request = { email: "user@example.com", listId: null, scope: "marketing" };
    expect(Schema.decodeUnknownSync(CreateSuppressionRequestSchema)(request)).toEqual(request);
    expect(
      Schema.decodeUnknownSync(CreateSuppressionResponseSchema)({ created: true, suppression }),
    ).toEqual({ created: true, suppression });
    expectTypeOf<Suppression["listId"]>().toEqualTypeOf<string | null>();
  });

  it("decodes paginated lists and rejects unknown reason values", () => {
    const response = {
      items: [suppression],
      pagination: { limit: 50, nextOffset: null, offset: 0 },
    };
    expect(Schema.decodeUnknownSync(SuppressionsListResponseSchema)(response)).toEqual(response);
    expect(() =>
      Schema.decodeUnknownSync(SuppressionsListResponseSchema)({
        ...response,
        items: [{ ...suppression, reason: "other" }],
      }),
    ).toThrow(/reason/);
  });
});
