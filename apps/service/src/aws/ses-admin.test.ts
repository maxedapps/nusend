import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { classifyAwsAdminError } from "./errors.ts";
import { makeSesAdmin, type SesAdminSender } from "./ses-admin.ts";

describe("makeSesAdmin", () => {
  it("passes abort signals and extracts configuration-set tracking options", async () => {
    const calls: boolean[] = [];
    const sender: SesAdminSender = {
      send: async (_command, options) => {
        calls.push(options?.abortSignal instanceof AbortSignal);
        return {
          ConfigurationSetName: "marketing-set",
          SendingOptions: { SendingEnabled: true },
          TrackingOptions: { CustomRedirectDomain: "tracking.example.com" },
        };
      },
    };

    const result = await Effect.runPromise(
      makeSesAdmin(sender, 1234).getConfigurationSet("marketing-set"),
    );

    expect(calls).toEqual([true]);
    expect(result).toEqual({
      name: "marketing-set",
      sendingEnabled: true,
      trackingCustomRedirectDomain: "tracking.example.com",
    });
  });
});

describe("classifyAwsAdminError", () => {
  it("classifies timeout-shaped errors", () => {
    expect(classifyAwsAdminError("op", { name: "AbortError" })).toMatchObject({
      kind: "timeout",
      operation: "op",
    });
  });
});
