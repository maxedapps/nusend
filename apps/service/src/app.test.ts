import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.ts";
import { Database, type DatabaseService } from "./services/database.ts";
import { FakeAuthLive, sequentialIdsLayer, withTestApp } from "./testing/layers.ts";

describe("createApp", () => {
  it("returns basic health status", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(new Request("http://localhost/health"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        service: "nusend",
      });
    });
  });

  it("returns database health status", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(new Request("http://localhost/health/db"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    });
  });

  it("returns unavailable database health status", async () => {
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(unavailableDatabaseLayer(), sequentialIdsLayer("id"), FakeAuthLive()),
    );

    try {
      const app = createApp({ runtime });
      const response = await app.fetch(new Request("http://localhost/health/db"));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false });
    } finally {
      await runtime.dispose();
    }
  });

  it("mounts auth routes before not found", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(new Request("http://localhost/api/auth/sign-in/google"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ handled: true });
    });
  });

  it("returns JSON not found for unknown routes", async () => {
    await withTestApp({}, async (app) => {
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
});

function unavailableDatabaseLayer(): Layer.Layer<DatabaseService> {
  const dead = Effect.die(new Error("database unavailable"));

  return Layer.succeed(Database)({
    all: () => dead,
    exec: () => dead,
    get: () => dead,
    ping: Effect.succeed(false),
    run: () => dead,
    transaction: () => dead,
  });
}
