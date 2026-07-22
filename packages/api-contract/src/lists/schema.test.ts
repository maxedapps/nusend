import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ImportListContactsRequestSchema,
  ImportListContactsResponseSchema,
  ListContactsResponseSchema,
  ListResponseSchema,
  ListsListResponseSchema,
  type ImportListContactsResponse,
} from "./schema.js";

const list = {
  counts: { subscribed: 2, unsubscribed: 1 },
  createdAt: "2026-07-03T12:00:00.000Z",
  id: "list_1",
  name: "Customers",
};

const pagination = { limit: 50, nextOffset: null, offset: 0 };

describe("list wire schemas", () => {
  it("decodes list and membership responses with current field names", () => {
    expect(Schema.decodeUnknownSync(ListResponseSchema)({ list })).toEqual({ list });
    expect(
      Schema.decodeUnknownSync(ListsListResponseSchema)({ items: [list], pagination }),
    ).toEqual({ items: [list], pagination });

    const member = {
      contact: {
        createdAt: "2026-07-03T12:00:00.000Z",
        email: "user@example.com",
        id: "contact_1",
        updatedAt: "2026-07-03T12:01:00.000Z",
      },
      status: "unsubscribed",
      subscribedAt: "2026-07-03T12:00:00.000Z",
      unsubscribedAt: "2026-07-04T12:00:00.000Z",
    };
    expect(
      Schema.decodeUnknownSync(ListContactsResponseSchema)({ items: [member], pagination }),
    ).toEqual({ items: [member], pagination });
  });

  it("decodes import requests and complete result counts", () => {
    const request = { contacts: [{ email: "user@example.com" }] };
    expect(Schema.decodeUnknownSync(ImportListContactsRequestSchema)(request)).toEqual(request);

    const response = {
      counts: {
        accepted: 1,
        alreadySubscribed: 0,
        contactsCreated: 1,
        membershipsCreated: 1,
        resubscribed: 0,
        submitted: 1,
      },
      items: [
        {
          action: "created",
          contactId: "contact_1",
          email: "user@example.com",
          status: "subscribed",
        },
      ],
    };
    expect(Schema.decodeUnknownSync(ImportListContactsResponseSchema)(response)).toEqual(response);
    expectTypeOf<ImportListContactsResponse["counts"]["submitted"]>().toEqualTypeOf<number>();
  });

  it("rejects nullable membership timestamps where the wire requires strings", () => {
    expect(() =>
      Schema.decodeUnknownSync(ListContactsResponseSchema)({
        items: [
          {
            contact: {
              createdAt: "2026-07-03T12:00:00.000Z",
              email: "user@example.com",
              id: "contact_1",
              updatedAt: "2026-07-03T12:00:00.000Z",
            },
            status: "subscribed",
            subscribedAt: null,
            unsubscribedAt: null,
          },
        ],
        pagination,
      }),
    ).toThrow(/subscribedAt/);
  });
});
