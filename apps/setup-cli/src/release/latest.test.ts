import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { SetupCommandError } from "../errors.ts";
import { LATEST_RELEASE_API_URL, resolveLatestReleaseTag, type FetchLike } from "./latest.ts";

function jsonResponse(
  status: number,
  body: unknown,
): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("resolveLatestReleaseTag", () => {
  it("returns and validates the latest release tag_name", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      expect(url).toBe(LATEST_RELEASE_API_URL);
      expect(init?.headers?.Accept).toContain("application/vnd.github+json");
      expect(init?.headers?.["User-Agent"]).toBe("nusend-setup-cli");
      expect(init?.headers?.Authorization).toBeUndefined();
      return jsonResponse(200, { tag_name: "v0.1.1", draft: false, prerelease: false });
    };

    const tag = await Effect.runPromise(resolveLatestReleaseTag({ fetchImpl, env: {} }));
    expect(tag).toBe("v0.1.1");
  });

  it("sends Bearer auth when GH_TOKEN is set", async () => {
    let sawAuth = false;
    const fetchImpl: FetchLike = async (_url, init) => {
      sawAuth = init?.headers?.Authorization === "Bearer ghp_test_token";
      return jsonResponse(200, { tag_name: "v1.2.3" });
    };

    const tag = await Effect.runPromise(
      resolveLatestReleaseTag({
        fetchImpl,
        env: { GH_TOKEN: "ghp_test_token" },
      }),
    );
    expect(tag).toBe("v1.2.3");
    expect(sawAuth).toBe(true);
  });

  it("rejects invalid tag shapes from the API", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { tag_name: "v0.1" });
    const exit = await Effect.runPromiseExit(resolveLatestReleaseTag({ fetchImpl, env: {} }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toMatch(/invalid|v1\.2\.3|release tag/i);
    }
  });

  it("maps 404 to a publish-a-release message", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(404, { message: "Not Found" });
    const exit = await Effect.runPromiseExit(resolveLatestReleaseTag({ fetchImpl, env: {} }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toMatch(/No published GitHub Release/i);
    }
  });

  it("maps rate limits clearly", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(403, { message: "API rate limit exceeded" });
    await expect(
      Effect.runPromise(resolveLatestReleaseTag({ fetchImpl, env: {} })),
    ).rejects.toBeInstanceOf(SetupCommandError);
    await expect(
      Effect.runPromise(resolveLatestReleaseTag({ fetchImpl, env: {} })),
    ).rejects.toThrow(/rate-limited|GH_TOKEN/i);
  });

  it("rejects draft/prerelease payloads fail-closed", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, { tag_name: "v9.9.9", draft: false, prerelease: true });
    await expect(
      Effect.runPromise(resolveLatestReleaseTag({ fetchImpl, env: {} })),
    ).rejects.toThrow(/prerelease|full published release/i);
  });
});
