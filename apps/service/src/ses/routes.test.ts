import { describe, expect, it } from "vitest";

import { withTestApp, type FakeAuthBehavior } from "../testing/layers.ts";

const endpoints = [
  "/summary",
  "/events",
  "/readiness?includeAws=false",
  "/setup-guide?includeAws=false",
  "/simulator-runs",
] as const;

const baseUrl = "http://localhost/api/operations/ses";

describe("SES operations routes", () => {
  it.each(endpoints)("enforces operations:read auth for %s", async (endpoint) => {
    const noAuth = await getSesOperations(endpoint, { session: null });
    expect(noAuth.status).toBe(401);

    const missingPermission = await getSesOperations(
      endpoint,
      { apiKeyPermissions: { mailings: ["create"] } },
      { "x-api-key": "valid" },
    );
    expect(missingPermission.status).toBe(403);

    const sessionOwner = await getSesOperations(endpoint, { session: { userId: "user_1" } });
    expect(sessionOwner.status).toBe(200);

    const apiKeyWithOperationsRead = await getSesOperations(
      endpoint,
      { apiKeyPermissions: { operations: ["read"] } },
      { "x-api-key": "valid" },
    );
    expect(apiKeyWithOperationsRead.status).toBe(200);
  });
});

function getSesOperations(
  path: string,
  auth: FakeAuthBehavior,
  headers?: Record<string, string>,
): Promise<Response> {
  return withTestApp({ auth }, async (app) =>
    app.fetch(new Request(`${baseUrl}${path}`, { headers })),
  );
}
