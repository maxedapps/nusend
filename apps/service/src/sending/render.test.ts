import { describe, expect, it } from "vitest";

import { runTest } from "../testing/layers.ts";
import { renderDeliveryEmail } from "./render.ts";
import type { DeliveryContext } from "./schema.ts";

function context(overrides: Partial<DeliveryContext["mailing"]> = {}): DeliveryContext {
  return {
    delivery: {
      contactId: null,
      email: "user@example.com",
      id: "delivery_1",
      mailingId: "mailing_1",
      status: "queued",
      varsJson: '{"firstName":"Max"}',
    },
    job: {
      attempts: 0,
      createdAt: "2026-07-03T12:00:00.000Z",
      deliveryId: "delivery_1",
      id: "job_1",
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
      maxAttempts: 10,
      runAt: "2026-07-03T12:00:00.000Z",
      state: "queued",
      updatedAt: "2026-07-03T12:00:00.000Z",
    },
    mailing: {
      html: '<a href="{{ unsubscribe.url }}">Unsubscribe {{ vars.firstName }}</a>',
      id: "mailing_1",
      listId: null,
      purpose: "marketing",
      subject: "Hello {{ user.email }}",
      text: "Unsubscribe: {{ unsubscribe.url }}",
      ...overrides,
    },
  };
}

describe("renderDeliveryEmail", () => {
  it("renders unsubscribe.url for marketing templates", async () => {
    const rendered = await runTest(
      renderDeliveryEmail(context(), { unsubscribeUrl: "https://example.com/unsubscribe/token" }),
    );

    expect(rendered).toEqual({
      html: '<a href="https://example.com/unsubscribe/token">Unsubscribe Max</a>',
      subject: "Hello user@example.com",
      text: "Unsubscribe: https://example.com/unsubscribe/token",
      unsubscribeUrl: "https://example.com/unsubscribe/token",
    });
  });

  it("fails transactional templates that use unsubscribe.url", async () => {
    await expect(
      runTest(renderDeliveryEmail(context({ purpose: "transactional" }))),
    ).rejects.toThrow(/Unsupported placeholder: unsubscribe.url/);
  });
});
