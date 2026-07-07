import { describe, expect, it } from "vitest";

import type { AuthInstance } from "./auth/auth.ts";
import { createApp } from "./app.ts";

describe("createApp", () => {
  it("returns basic health status", async () => {
    const app = createApp();

    const response = await app.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "nusend",
    });
  });

  it("returns database health status", async () => {
    const app = createApp({ pingDatabase: () => true });

    const response = await app.fetch(new Request("http://localhost/health/db"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("returns unavailable database health status", async () => {
    const app = createApp({ pingDatabase: () => false });

    const response = await app.fetch(new Request("http://localhost/health/db"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("mounts auth routes before not found", async () => {
    const app = createApp({
      auth: {
        handler: async () => Response.json({ handled: true }),
      } as unknown as AuthInstance,
    });

    const response = await app.fetch(new Request("http://localhost/api/auth/sign-in/google"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ handled: true });
  });

  it("returns JSON not found for unknown routes", async () => {
    const app = createApp();

    const response = await app.fetch(new Request("http://localhost/unknown"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Not found.",
      },
    });
  });
});
