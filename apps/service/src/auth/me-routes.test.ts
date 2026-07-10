import { describe, expect, it } from "vitest";

import { withTestApp } from "../testing/layers.ts";

describe("me routes", () => {
  it("returns the owner session principal", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app) => {
      const response = await app.fetch(new Request("http://localhost/api/me"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        principal: { kind: "session", permissions: "owner", userId: "user_1" },
      });
    });
  });

  it("returns 401 without credentials", async () => {
    await withTestApp({ auth: { session: null } }, async (app) => {
      const response = await app.fetch(new Request("http://localhost/api/me"));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: { code: "unauthenticated", message: "Authentication required." },
      });
    });
  });
});
