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
});
