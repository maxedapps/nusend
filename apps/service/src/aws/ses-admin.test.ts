import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { classifyAwsAdminError } from "./errors.ts";
import { makeSesAdmin, type SesAdminSender } from "./ses-admin.ts";

describe("makeSesAdmin", () => {
  it("passes abort signals and extracts configuration-set tracking and suppression options", async () => {
    const calls: boolean[] = [];
    const sender: SesAdminSender = {
      send: async (_command, options) => {
        calls.push(options?.abortSignal instanceof AbortSignal);
        return {
          ConfigurationSetName: "marketing-set",
          SendingOptions: { SendingEnabled: true },
          SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
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
      suppressedReasons: ["BOUNCE", "COMPLAINT"],
      trackingCustomRedirectDomain: "tracking.example.com",
    });
  });

  it("defaults missing configuration-set suppression options to an empty list", async () => {
    const sender: SesAdminSender = {
      send: async () => ({
        ConfigurationSetName: "transactional-set",
        SendingOptions: { SendingEnabled: true },
      }),
    };

    const result = await Effect.runPromise(
      makeSesAdmin(sender).getConfigurationSet("transactional-set"),
    );

    expect(result).toEqual({
      name: "transactional-set",
      sendingEnabled: true,
      suppressedReasons: [],
      trackingCustomRedirectDomain: null,
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
