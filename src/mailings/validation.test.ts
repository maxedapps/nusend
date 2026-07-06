import { describe, expect, it } from "vitest";

import { validateCreateMailingRequest } from "./validation.ts";

const validRequest = {
  html: "<p>Hello</p>",
  purpose: "transactional",
  recipients: [{ email: "USER@example.com", vars: { firstName: "Max" } }],
  subject: " Hello ",
};

describe("validateCreateMailingRequest", () => {
  it("normalizes a valid explicit recipient request", () => {
    const result = validateCreateMailingRequest({
      ...validRequest,
      name: " ",
      scheduledAt: "2026-07-03T12:00:00Z",
      text: " Hello ",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        html: "<p>Hello</p>",
        listId: null,
        name: null,
        purpose: "transactional",
        recipients: [{ email: "user@example.com", varsJson: '{"firstName":"Max"}' }],
        scheduledAt: "2026-07-03T12:00:00.000Z",
        subject: "Hello",
        text: "Hello",
      },
    });
  });

  it.each([
    [null, "Request body must be a JSON object."],
    [
      { ...validRequest, purpose: "other" },
      "purpose must be either 'transactional' or 'marketing'.",
    ],
    [{ ...validRequest, subject: " " }, "subject must not be empty."],
    [{ ...validRequest, html: "" }, "html must not be empty."],
    [
      { ...validRequest, listId: "list_1", recipients: undefined },
      "Transactional mailings must use recipients and cannot use listId.",
    ],
    [
      { ...validRequest, listId: "list_1" },
      "Provide exactly one recipient source: recipients or listId.",
    ],
    [
      { html: "<p>Hello</p>", purpose: "marketing", subject: "Hello" },
      "Provide exactly one recipient source: recipients or listId.",
    ],
    [{ ...validRequest, recipients: [] }, "recipients must contain at least one recipient."],
    [{ ...validRequest, scheduledAt: "not a date" }, "scheduledAt must be a valid date."],
    [
      { ...validRequest, recipients: [{ email: "a@example.com", vars: [] }] },
      "recipients[0].vars must be an object.",
    ],
    [
      { ...validRequest, recipients: [{ email: "a@example.com" }, { email: " A@example.com " }] },
      "Duplicate recipient email: a@example.com.",
    ],
  ])("rejects invalid request %#", (request, message) => {
    const result = validateCreateMailingRequest(request);

    expect(result).toEqual({ code: "invalid_request", message, ok: false });
  });

  it("accepts marketing list requests", () => {
    const result = validateCreateMailingRequest({
      html: "<p>Hello</p>",
      listId: "list_1",
      purpose: "marketing",
      subject: "Hello",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        html: "<p>Hello</p>",
        listId: "list_1",
        name: null,
        purpose: "marketing",
        recipients: null,
        scheduledAt: null,
        subject: "Hello",
        text: null,
      },
    });
  });
});
