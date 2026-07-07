import { Effect } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { makeTestRuntime, type FakeAuthBehavior, type TestRuntime } from "../testing/layers.ts";
import { requirePrincipal } from "./middleware.ts";

type ScenarioOptions = {
  auth?: FakeAuthBehavior;
  headers?: Record<string, string>;
  memberRole?: string;
  insertMember?: boolean;
};

async function runMiddlewareScenario(options: ScenarioOptions): Promise<Response> {
  const runtime = makeTestRuntime({ auth: options.auth });

  try {
    if (options.insertMember) {
      await seedMember(runtime, options.memberRole ?? "member");
    }

    const app = new Hono();
    app.get(
      "/protected",
      requirePrincipal({ permissions: { mailings: ["send"] }, runtime }),
      (context) => context.json({ ok: true }),
    );

    return await app.fetch(
      new Request("http://localhost/protected", { headers: options.headers ?? {} }),
    );
  } finally {
    await runtime.dispose();
  }
}

function seedMember(runtime: TestRuntime, role: string): Promise<void> {
  const now = "2026-07-03T12:00:00.000Z";

  return runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "seed:user",
        `INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at)
         VALUES ('user_1', 'User', 'user@example.com', 1, NULL, $now, $now);`,
        { now },
      );
      yield* db.run(
        "seed:organization",
        `INSERT INTO organizations (id, name, slug, logo, created_at, metadata)
         VALUES ('org_1', 'Nusend', 'nusend', NULL, $now, NULL);`,
        { now },
      );
      yield* db.run(
        "seed:member",
        `INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
         VALUES ('member_1', 'org_1', 'user_1', $role, $now);`,
        { now, role },
      );
    }),
  );
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
      auth: { apiKeyPermissions: { mailings: ["send"] } },
      headers: { "x-api-key": "valid" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("allows sessions and resolves the single organization when active org is missing", async () => {
    const response = await runMiddlewareScenario({
      auth: { session: { activeOrganizationId: null, userId: "user_1" } },
      insertMember: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("denies sessions without an organization", async () => {
    const response = await runMiddlewareScenario({
      auth: { session: { activeOrganizationId: null, userId: "user_1" } },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "No active organization found for this session." },
    });
  });

  it("denies sessions whose active organization has no membership", async () => {
    const response = await runMiddlewareScenario({
      auth: { session: { activeOrganizationId: "org_1", userId: "user_1" } },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "Session is not a member of the active organization." },
    });
  });

  it("denies sessions with unknown roles", async () => {
    const response = await runMiddlewareScenario({
      auth: { session: { activeOrganizationId: null, userId: "user_1" } },
      insertMember: true,
      memberRole: "unexpected",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "forbidden", message: "Session does not have the required permissions." },
    });
  });
});
