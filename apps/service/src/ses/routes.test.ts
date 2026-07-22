import { SesReadinessResponseSchema, SesSetupGuideResponseSchema } from "@nusend/api-contract";
import { Schema } from "effect";
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
      { apiKeyPermissions: { mailings: ["write"] } },
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

  it("returns readiness and setup-guide responses matching the shared wire schemas", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app) => {
      const readiness = await app.fetch(new Request(`${baseUrl}/readiness?includeAws=false`));
      expect(readiness.status).toBe(200);
      const readinessBody = await readiness.json();
      expect(() =>
        Schema.decodeUnknownSync(SesReadinessResponseSchema)(readinessBody),
      ).not.toThrow();

      const setupGuide = await app.fetch(new Request(`${baseUrl}/setup-guide?includeAws=false`));
      expect(setupGuide.status).toBe(200);
      const setupGuideBody = await setupGuide.json();
      expect(() =>
        Schema.decodeUnknownSync(SesSetupGuideResponseSchema)(setupGuideBody),
      ).not.toThrow();
    });
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
