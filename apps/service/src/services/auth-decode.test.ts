import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeApiKeyVerification, decodeSessionData } from "./auth-decode.ts";

describe("auth boundary decoders", () => {
  it("decodes only session fields consumed by Nusend", async () => {
    const decoded = await Effect.runPromise(
      decodeSessionData({ session: { userId: "user_1", token: "ignored" }, user: {} }),
    );

    expect(decoded).toEqual({ session: { userId: "user_1" } });
  });

  it("turns malformed session shapes into AuthError", async () => {
    const result = await Effect.runPromise(
      decodeSessionData({ session: { userId: 1 } }).pipe(
        Effect.map(() => "unexpected success"),
        Effect.catchTag("AuthError", (error) => Effect.succeed(error.operation)),
      ),
    );

    expect(result).toBe("decodeSession");
  });

  it("decodes user-owned API key verification results", async () => {
    const decoded = await Effect.runPromise(
      decodeApiKeyVerification({
        key: {
          id: "key_1",
          permissions: { mailings: ["create"] },
          referenceId: "user_1",
          ignored: true,
        },
        valid: true,
      }),
    );

    expect(decoded).toEqual({
      key: {
        id: "key_1",
        permissions: { mailings: ["create"] },
        referenceId: "user_1",
      },
      valid: true,
    });
  });

  it("turns malformed API-key verification shapes into AuthError", async () => {
    const result = await Effect.runPromise(
      decodeApiKeyVerification({ key: { id: "key_1", referenceId: 1 }, valid: true }).pipe(
        Effect.map(() => "unexpected success"),
        Effect.catchTag("AuthError", (error) => Effect.succeed(error.operation)),
      ),
    );

    expect(result).toBe("decodeApiKeyVerification");
  });
});
