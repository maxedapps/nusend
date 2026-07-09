import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeSnsAdmin, type SnsAdminSender } from "./sns-admin.ts";

describe("makeSnsAdmin", () => {
  it("passes abort signals and paginates ListSubscriptionsByTopic", async () => {
    const calls: Array<{ command: unknown; hasAbortSignal: boolean }> = [];
    const sender: SnsAdminSender = {
      send: async (command, options) => {
        calls.push({ command, hasAbortSignal: options?.abortSignal instanceof AbortSignal });
        const input = command as { input?: { NextToken?: string } };
        if (input.input?.NextToken === "page-2") {
          return {
            Subscriptions: [
              {
                Endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
                Protocol: "https",
                SubscriptionArn: "arn:subscription",
              },
            ],
          };
        }
        return {
          NextToken: "page-2",
          Subscriptions: [{ Endpoint: "https://other.example.com", Protocol: "https" }],
        };
      },
    };

    const result = await Effect.runPromise(
      makeSnsAdmin(sender, 1234).listSubscriptionsByTopic(
        "arn:aws:sns:us-east-1:123456789012:nusend-test",
      ),
    );

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.hasAbortSignal)).toBe(true);
    expect(result.map((subscription) => subscription.endpoint)).toEqual([
      "https://other.example.com",
      "https://mail.example.com/api/webhooks/aws/sns/ses",
    ]);
  });
});
