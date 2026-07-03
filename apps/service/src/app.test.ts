import { describe, expect, it } from "vitest";

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
});
