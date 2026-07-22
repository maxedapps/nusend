import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CreateMailingRequestSchema,
  CreateMailingResponseSchema,
  MailingCountsSchema,
  type CreateMailingRequest,
  type MailingCounts,
} from "./schema.js";

const currentCounts = {
  ambiguous: 0,
  failed: 1,
  queued: 2,
  sending: 3,
  sent: 4,
  suppressed: 5,
};

describe("mailing create wire schemas", () => {
  it("decodes explicit-recipient and list-source request structures without normalizing", async () => {
    const explicit = {
      html: "<p>Hello</p>",
      name: null,
      purpose: "transactional",
      recipients: [{ email: "USER@example.com", vars: { firstName: "Max" } }],
      scheduledAt: null,
      subject: " Hello ",
      text: null,
    };
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(CreateMailingRequestSchema)(explicit)),
    ).resolves.toEqual(explicit);

    const list = {
      html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
      listId: "list_1",
      purpose: "marketing",
      subject: "News",
    };
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(CreateMailingRequestSchema)(list)),
    ).resolves.toEqual(list);
    expectTypeOf<CreateMailingRequest["scheduledAt"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("decodes the create response envelope", async () => {
    const response = {
      counts: { deliveries: 2, queued: 1, suppressed: 1 },
      mailing: {
        id: "mailing_1",
        purpose: "marketing",
        scheduledAt: "2026-07-03T12:00:00.000Z",
        state: "scheduled",
      },
    };
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(CreateMailingResponseSchema)(response)),
    ).resolves.toEqual(response);
  });

  it("rejects null recipient sources that are not nullable on the wire", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(CreateMailingRequestSchema)({
          html: "<p>Hello</p>",
          purpose: "transactional",
          recipients: null,
          subject: "Hello",
        }),
      ),
    ).rejects.toThrow(/recipients/);
  });
});

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
