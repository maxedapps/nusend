import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { makeTestRuntime, type FakeAuthBehavior } from "../testing/layers.ts";
import { requirePrincipal } from "./middleware.ts";

type ScenarioOptions = {
  auth?: FakeAuthBehavior;
  headers?: Record<string, string>;
};

async function runMiddlewareScenario(options: ScenarioOptions): Promise<Response> {
  const runtime = makeTestRuntime({ auth: options.auth });

  try {
    const app = new Hono();
    app.get(
      "/protected",
      requirePrincipal({ permissions: { mailings: ["write"] }, runtime }),
      (context) => context.json({ ok: true }),
    );

    return await app.fetch(
      new Request("http://localhost/protected", { headers: options.headers ?? {} }),
    );
  } finally {
    await runtime.dispose();
  }
}

describe("requirePrincipal", () => {
  it("returns 401 without auth", async () => {
    const response = await runMiddlewareScenario({ auth: { session: null } });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: "Authentication required." },
    });
  });

  it("returns 401 for invalid API keys", async () => {
    const response = await runMiddlewareScenario({
      auth: { apiKeyValid: false },
      headers: { "x-api-key": "invalid" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: "Invalid API key." },
    });
  });

  it("returns 403 for API keys missing permissions", async () => {
    const response = await runMiddlewareScenario({
      auth: { apiKeyPermissions: { mailings: ["read"] } },
      headers: { "x-api-key": "valid" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "API key does not have the required permissions." },
    });
  });

  it("allows API keys with required permissions", async () => {
    const response = await runMiddlewareScenario({
      auth: { apiKeyPermissions: { mailings: ["write"] } },
      headers: { "x-api-key": "valid" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("allows valid sessions as the single-user owner", async () => {
    const response = await runMiddlewareScenario({
      auth: { session: { userId: "user_1" } },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
