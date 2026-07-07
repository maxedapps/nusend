// Successor of validation.test.ts: same normalization assertions (values are
// frozen contract), rejection assertions by outcome rather than exact prose
// (messages are Schema-derived and allowed to change).
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import type { RequestValidationError } from "../errors.ts";
import {
  decodeCreateMailingRequest,
  maxListIdLength,
  maxMailingHtmlLength,
  maxMailingNameLength,
  maxMailingSubjectLength,
  maxMailingTextLength,
  maxRecipientEmailLength,
  maxRecipientVarsJsonBytes,
  type CreateMailingInput,
} from "./schema.ts";

const validRequest = {
  html: "<p>Hello</p>",
  purpose: "transactional",
  recipients: [{ email: "USER@example.com", vars: { firstName: "Max" } }],
  subject: " Hello ",
};

function failureMessage(result: Result.Result<CreateMailingInput, RequestValidationError>): string {
  return Result.isFailure(result) ? result.failure.message : "unexpected success";
}

describe("decodeCreateMailingRequest", () => {
  it("normalizes a valid explicit recipient request", () => {
    const result = decodeCreateMailingRequest({
      ...validRequest,
      name: " ",
      scheduledAt: "2026-07-03T12:00:00Z",
      text: " Hello ",
    });

    expect(Result.getOrThrow(result)).toEqual({
      html: "<p>Hello</p>",
      listId: null,
      name: null,
      purpose: "transactional",
      recipients: [{ email: "user@example.com", varsJson: '{"firstName":"Max"}' }],
      scheduledAt: "2026-07-03T12:00:00.000Z",
      subject: "Hello",
      text: "Hello",
    });
  });

  it("accepts marketing list requests", () => {
    const result = decodeCreateMailingRequest({
      html: "<p>Hello</p>",
      listId: "list_1",
      purpose: "marketing",
      subject: "Hello",
    });

    expect(Result.getOrThrow(result)).toEqual({
      html: "<p>Hello</p>",
      listId: "list_1",
      name: null,
      purpose: "marketing",
      recipients: null,
      scheduledAt: null,
      subject: "Hello",
      text: null,
    });
  });

  it.each([
    [null],
    [{ ...validRequest, purpose: "other" }],
    [{ ...validRequest, subject: " " }],
    [{ ...validRequest, html: "" }],
    [{ ...validRequest, recipients: [] }],
    [{ ...validRequest, scheduledAt: "not a date" }],
    [{ ...validRequest, recipients: [{ email: "a@example.com", vars: [] }] }],
    [{ ...validRequest, recipients: [{ email: "not-an-email" }] }],
    [{ ...validRequest, recipients: [{ email: "two@@example.com" }] }],
  ])("rejects invalid request %#", (request) => {
    expect(Result.isFailure(decodeCreateMailingRequest(request))).toBe(true);
  });

  it("keeps the exact presence-rule messages", () => {
    expect(failureMessage(decodeCreateMailingRequest({ ...validRequest, listId: "list_1" }))).toBe(
      "Provide exactly one recipient source: recipients or listId.",
    );
    expect(
      failureMessage(
        decodeCreateMailingRequest({
          html: "<p>Hello</p>",
          purpose: "marketing",
          subject: "Hello",
        }),
      ),
    ).toBe("Provide exactly one recipient source: recipients or listId.");
    expect(
      failureMessage(
        decodeCreateMailingRequest({ ...validRequest, listId: "list_1", recipients: undefined }),
      ),
    ).toBe("Transactional mailings must use recipients and cannot use listId.");
  });

  // The Object.hasOwn presence semantics — a null-valued key counts as present.
  it("applies presence semantics on the raw input", () => {
    // recipients: null + listId → both sources "present" → 400
    expect(
      failureMessage(
        decodeCreateMailingRequest({ ...validRequest, recipients: null, listId: "x" }),
      ),
    ).toBe("Provide exactly one recipient source: recipients or listId.");

    // recipients: undefined → source absent → exactly-one violated
    const withoutRecipients = { html: "<p>x</p>", purpose: "marketing", subject: "s" };
    expect(
      failureMessage(decodeCreateMailingRequest({ ...withoutRecipients, recipients: undefined })),
    ).toBe("Provide exactly one recipient source: recipients or listId.");

    // recipients: null alone → source present but not an array → schema rejection
    const nullRecipients = decodeCreateMailingRequest({
      html: "<p>x</p>",
      purpose: "transactional",
      recipients: null,
      subject: "s",
    });
    expect(Result.isFailure(nullRecipients)).toBe(true);

    // listId: null alone → source present but not a string → schema rejection
    const nullListId = decodeCreateMailingRequest({
      html: "<p>x</p>",
      listId: null,
      purpose: "marketing",
      subject: "s",
    });
    expect(Result.isFailure(nullListId)).toBe(true);
  });

  it("detects duplicates on normalized emails", () => {
    const result = decodeCreateMailingRequest({
      ...validRequest,
      recipients: [{ email: "a@example.com" }, { email: " A@example.com " }],
    });

    expect(failureMessage(result)).toContain("Duplicate recipient email: a@example.com.");
  });

  it("enforces field and serialized vars limits", () => {
    const cases = [
      { ...validRequest, subject: "x".repeat(maxMailingSubjectLength + 1) },
      { ...validRequest, html: "x".repeat(maxMailingHtmlLength + 1) },
      { ...validRequest, name: "x".repeat(maxMailingNameLength + 1) },
      { ...validRequest, text: "x".repeat(maxMailingTextLength + 1) },
      { ...validRequest, recipients: [{ email: `${"x".repeat(maxRecipientEmailLength)}@x` }] },
      {
        html: "<p>Hello</p>",
        listId: "x".repeat(maxListIdLength + 1),
        purpose: "marketing",
        subject: "Hello",
      },
      {
        ...validRequest,
        recipients: [
          { email: "user@example.com", vars: { value: "x".repeat(maxRecipientVarsJsonBytes) } },
        ],
      },
    ];

    for (const request of cases) {
      expect(Result.isFailure(decodeCreateMailingRequest(request))).toBe(true);
    }
  });

  it("enforces the recipient cap", () => {
    const recipients = Array.from({ length: 1001 }, (_, index) => ({
      email: `user${index}@example.com`,
    }));

    const result = decodeCreateMailingRequest({ ...validRequest, recipients });

    expect(failureMessage(result)).toContain("at most 1000 recipients");
  });

  it("aggregates multiple field issues into one message", () => {
    const result = decodeCreateMailingRequest({
      ...validRequest,
      purpose: "other",
      subject: " ",
    });

    const message = failureMessage(result);
    expect(message).toContain('["purpose"]');
    expect(message).toContain('["subject"]');
  });
});
