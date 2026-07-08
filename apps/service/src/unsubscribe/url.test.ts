import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { fakeUnsubscribeConfig, runTest } from "../testing/layers.ts";
import { UnsubscribeConfigLive } from "./config.ts";
import { verifyUnsubscribeToken } from "./token.ts";
import { buildUnsubscribeUrl } from "./url.ts";

describe("buildUnsubscribeUrl", () => {
  it("builds an HTTPS path-token URL that verifies to the delivery id", async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const url = yield* buildUnsubscribeUrl("delivery_1");
        const token = new URL(url).pathname.split("/").at(-1) ?? "";
        const config = fakeUnsubscribeConfig({ publicBaseUrl: "https://example.com/base" });
        const verified = verifyUnsubscribeToken(token, [config.currentSecret]);
        return { url, verified };
      }).pipe(
        Effect.provide(
          UnsubscribeConfigLive(
            Option.some(fakeUnsubscribeConfig({ publicBaseUrl: "https://example.com/base" })),
          ),
        ),
      ),
    );

    expect(result.url).toMatch(/^https:\/\/example\.com\/base\/unsubscribe\//);
    expect(result.url).not.toContain("user@example.com");
    expect(result.verified).toEqual({ kind: "Valid", payload: { d: "delivery_1", v: 1 } });
  });

  it("fails when unsubscribe config is absent", async () => {
    await expect(runTest(buildUnsubscribeUrl("delivery_1"))).rejects.toThrow(
      /requires unsubscribe configuration/,
    );
  });
});
