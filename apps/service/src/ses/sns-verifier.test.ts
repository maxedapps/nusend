import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { SnsMessageVerifier } from "./sns-verifier.ts";
import { SnsMessageVerifierLive } from "./sns-verifier.ts";

// These tests intentionally avoid fetching a real signing certificate. They pin
// the Bun import/callback wrapper and pre-certificate structural rejection paths;
// package source inspection confirmed SignatureVersion 2 uses RSA-SHA256 and
// certificates are cached in memory by URL.
describe("SnsMessageVerifier", () => {
  it("loads the callback-based sns-validator package under Bun/Vitest", async () => {
    const result = await Effect.runPromiseExit(
      Effect.flatMap(SnsMessageVerifier, (verifier) => verifier.verify("{}")).pipe(
        Effect.provide(SnsMessageVerifierLive),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  it("rejects malformed required SNS fields", async () => {
    await expect(
      Effect.runPromise(
        Effect.flatMap(SnsMessageVerifier, (verifier) =>
          verifier.verify(JSON.stringify({ Type: "Notification", SignatureVersion: "2" })),
        ).pipe(Effect.provide(SnsMessageVerifierLive)),
      ),
    ).rejects.toMatchObject({ _tag: "SnsVerificationError" });
  });
});
