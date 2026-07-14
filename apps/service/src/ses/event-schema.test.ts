import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeSesEvent } from "./event-schema.ts";

describe("decodeSesEvent", () => {
  it("decodes first-class Open and Click payloads", async () => {
    const open = await Effect.runPromise(
      decodeSesEvent(
        JSON.stringify({
          eventType: "Open",
          mail: { destination: ["user@example.com"], messageId: "ses_1" },
          open: { ipAddress: "192.0.2.1", timestamp: "2026-07-03T12:00:00Z", userAgent: "UA" },
        }),
      ),
    );
    const click = await Effect.runPromise(
      decodeSesEvent(
        JSON.stringify({
          click: { link: "https://example.com", linkTags: { tag: ["value"] } },
          eventType: "Click",
          mail: { destination: ["user@example.com"], messageId: "ses_2" },
        }),
      ),
    );

    expect(open.eventType).toBe("Open");
    expect(open.open?.userAgent).toBe("UA");
    expect(click.eventType).toBe("Click");
    expect(click.click?.linkTags?.tag).toEqual(["value"]);
  });

  it("maps authentic unknown event names to Unknown", async () => {
    const event = await Effect.runPromise(
      decodeSesEvent(
        JSON.stringify({
          eventType: "UnexpectedFutureEvent",
          mail: { destination: [], messageId: "ses_1" },
        }),
      ),
    );

    expect(event.eventType).toBe("Unknown");
  });

  it.each([
    ["Bounce without bounce", { eventType: "Bounce" }],
    ["Bounce with complaint", { complaint: complaintBlock(), eventType: "Bounce" }],
    ["Bounce with no bounced recipients", { bounce: bounceBlock([]), eventType: "Bounce" }],
    ["Complaint without complaint", { eventType: "Complaint" }],
    ["Complaint with bounce", { bounce: bounceBlock(), eventType: "Complaint" }],
    [
      "Complaint with no complained recipients",
      { complaint: complaintBlock([]), eventType: "Complaint" },
    ],
  ])("rejects %s as a retryable reputation payload error", async (_label, event) => {
    const failure = await Effect.runPromise(
      decodeSesEvent(JSON.stringify({ ...event, mail: mailBlock() })).pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
      ),
    );

    expect(failure).toMatchObject({ _tag: "SesOperationsRetryablePayloadError" });
    expect(failure).not.toMatchObject({ _tag: "SesOperationsMalformedError" });
  });

  it("keeps structurally malformed SES JSON distinct from retryable reputation mismatches", async () => {
    const failure = await Effect.runPromise(
      decodeSesEvent("{}").pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
      ),
    );

    expect(failure).toMatchObject({ _tag: "SesOperationsMalformedError" });
    expect(failure).not.toMatchObject({ _tag: "SesOperationsRetryablePayloadError" });
  });
});

function mailBlock() {
  return { destination: ["user@example.com"], messageId: "ses_1" };
}

function bounceBlock(
  bouncedRecipients: readonly { readonly emailAddress: string }[] = [
    { emailAddress: "user@example.com" },
  ],
) {
  return { bounceType: "Permanent", bouncedRecipients };
}

function complaintBlock(
  complainedRecipients: readonly { readonly emailAddress: string }[] = [
    { emailAddress: "user@example.com" },
  ],
) {
  return { complainedRecipients };
}
