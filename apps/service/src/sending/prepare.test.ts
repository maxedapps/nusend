import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fakeSendingConfigLayer } from "../testing/email-transport.ts";
import { runTest } from "../testing/layers.ts";
import { prepareEmail } from "./prepare.ts";
import type { DeliveryContext, RenderedEmail } from "./schema.ts";

function context(purpose: "marketing" | "transactional"): DeliveryContext {
  return {
    delivery: {
      contactId: null,
      email: "user@example.com",
      id: "delivery_1",
      mailingId: "mailing_1",
      status: "queued",
      varsJson: null,
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
      html: "<p>Hello</p>",
      id: "mailing_1",
      listId: null,
      purpose,
      subject: "Hello",
      text: null,
    },
  };
}

function rendered(overrides: Partial<RenderedEmail> = {}): RenderedEmail {
  return {
    html: '<a href="https://example.com/unsubscribe/token">Unsubscribe</a>',
    subject: "Hello",
    text: null,
    unsubscribeUrl: "https://example.com/unsubscribe/token",
    ...overrides,
  };
}

describe("prepareEmail", () => {
  it("adds RFC 8058 headers for marketing email", async () => {
    const prepared = await runTest(
      prepareEmail(context("marketing"), rendered()).pipe(
        Effect.provide(fakeSendingConfigLayer({ marketingConfigurationSet: "marketing-set" })),
      ),
    );

    expect(prepared.headers).toEqual({
      "List-Unsubscribe": "<https://example.com/unsubscribe/token>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("uses the transactional configuration set for successful transactional preparation", async () => {
    const prepared = await runTest(
      prepareEmail(context("transactional"), rendered({ unsubscribeUrl: null })).pipe(
        Effect.provide(fakeSendingConfigLayer({ transactionalConfigurationSet: "txn-config" })),
      ),
    );

    expect(prepared.configurationSetName).toBe("txn-config");
    expect(prepared.headers).toEqual({});
  });

  it("uses the marketing configuration set for successful marketing preparation", async () => {
    const prepared = await runTest(
      prepareEmail(context("marketing"), rendered()).pipe(
        Effect.provide(
          fakeSendingConfigLayer({
            marketingConfigurationSet: "marketing-set",
            transactionalConfigurationSet: "txn-config",
          }),
        ),
      ),
    );

    expect(prepared.configurationSetName).toBe("marketing-set");
  });

  it("does not add unsubscribe headers for transactional email", async () => {
    const prepared = await runTest(
      prepareEmail(context("transactional"), rendered({ unsubscribeUrl: null })).pipe(
        Effect.provide(fakeSendingConfigLayer()),
      ),
    );

    expect(prepared.headers).toEqual({});
  });

  it("fails marketing email when the unsubscribe URL is missing", async () => {
    await expect(
      runTest(
        prepareEmail(context("marketing"), rendered({ unsubscribeUrl: null })).pipe(
          Effect.provide(fakeSendingConfigLayer()),
        ),
      ),
    ).rejects.toThrow(/requires an unsubscribe URL/);
  });

  it("fails marketing email when rendered HTML omits the unsubscribe URL", async () => {
    await expect(
      runTest(
        prepareEmail(context("marketing"), rendered({ html: "<p>No unsubscribe link</p>" })).pipe(
          Effect.provide(fakeSendingConfigLayer()),
        ),
      ),
    ).rejects.toThrow(/must include the rendered unsubscribe URL/);
  });
});
