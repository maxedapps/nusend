import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeSessionData } from "./auth-decode.ts";

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
});
