import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.ts";
import { FakeSesAdminLive } from "./aws/ses-admin.ts";
import { FakeSnsAdminLive } from "./aws/sns-admin.ts";
import { Database, type DatabaseService } from "./services/database.ts";
import { FakeSnsSubscriptionConfirmerLive } from "./ses/sns-confirmer.ts";
import { FakeSnsMessageVerifierLive } from "./ses/sns-verifier.ts";
import {
  FakeApiKeysLive,
  FakeAuthLive,
  FakeDeviceAuthorizationsLive,
  fakeSesOperationsConfigLayer,
  sequentialIdsLayer,
  withTestApp,
} from "./testing/layers.ts";
import { UnsubscribeConfigLive } from "./unsubscribe/config.ts";

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
      Layer.mergeAll(
        unavailableDatabaseLayer(),
        sequentialIdsLayer("id"),
        FakeAuthLive(),
        FakeApiKeysLive(),
        FakeDeviceAuthorizationsLive(),
        fakeSesOperationsConfigLayer(),
        FakeSnsMessageVerifierLive(() => Effect.die(new Error("unused"))),
        FakeSnsSubscriptionConfirmerLive([]),
        FakeSesAdminLive({
          getAccount: () => Effect.die(new Error("unused")),
          getConfigurationSet: () => Effect.die(new Error("unused")),
          getConfigurationSetEventDestinations: () => Effect.die(new Error("unused")),
          getEmailIdentity: () => Effect.die(new Error("unused")),
        }),
        FakeSnsAdminLive({
          getTopicAttributes: () => Effect.die(new Error("unused")),
          listSubscriptionsByTopic: () => Effect.die(new Error("unused")),
        }),
        UnsubscribeConfigLive(Option.none()),
      ),
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

  it("mounts standard auth route methods before not found", async () => {
    await withTestApp({}, async (app) => {
      const results = await Promise.all(
        ["DELETE", "GET", "PATCH", "POST", "PUT"].map(async (method) => {
          const response = await app.fetch(
            new Request("http://localhost/api/auth/sign-in/google", { method }),
          );

          return { body: await response.json(), status: response.status };
        }),
      );

      expect(results).toEqual([
        { body: { handled: true }, status: 200 },
        { body: { handled: true }, status: 200 },
        { body: { handled: true }, status: 200 },
        { body: { handled: true }, status: 200 },
        { body: { handled: true }, status: 200 },
      ]);
    });
  });

  it("rejects a non-form POST /cli/activate with a 400 instead of a 500", async () => {
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app) => {
      const response = await app.fetch(
        new Request("http://localhost/cli/activate", {
          body: JSON.stringify({ code: "abc" }),
          headers: { "content-type": "application/json", origin: "http://localhost" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(400);
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
