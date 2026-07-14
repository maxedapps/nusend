import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { ApiKeys } from "../api-keys/service.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator } from "../services/ids.ts";
import { makeAttemptLimiter, type AttemptLimiter } from "./attempt-limiter.ts";
import {
  createDeviceAuthorizationRoutes,
  makeDefaultDeviceAuthorizationRouteLimiters,
} from "./routes.ts";
import { DeviceAuthorizations, makeDeviceAuthorizationsService } from "./service.ts";
import { hashDeviceAuthCode, normalizeUserCode } from "./token.ts";
import { makeTestRuntime, withTestApp, type TestRuntime } from "../testing/layers.ts";

// Matches the secret makeTestRuntime uses for realDeviceAuthorizations, so test
// helpers can locate a row by its (hashed) user code — the preview column is
// masked and no longer a lookup key.
const testDeviceAuthSecret = Redacted.make("test-device-auth-secret-32-value");
function userCodeHash(userCode: string): string {
  return hashDeviceAuthCode(normalizeUserCode(userCode), testDeviceAuthSecret);
}

describe("device authorization routes", () => {
  it("starts, polls, slows down, approves, consumes once, and returns a working API key", async () => {
    await withTestApp(
      {
        ids: ["device_1", "key_1"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);

        const startResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations", {
            clientName: "nusend-cli test",
            permissions: { api_keys: ["read"], contacts: ["read"] },
          }),
        );
        expect(startResponse.status).toBe(201);
        const start = (await startResponse.json()) as {
          deviceCode: string;
          userCode: string;
          verificationUri: string;
          verificationUriComplete: string;
          intervalSeconds: number;
        };
        expect(start.deviceCode).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(start.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        expect(start.verificationUri).toBe("http://localhost/cli/activate");
        expect(start.verificationUriComplete).toContain(encodeURIComponent(start.userCode));

        const stored = await readDeviceRows(runtime);
        expect(stored[0]?.device_code_hash).not.toBe(start.deviceCode);
        expect(stored[0]?.user_code_hash).not.toBe(start.userCode);

        const pendingResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        expect(pendingResponse.status).toBe(200);
        await expect(pendingResponse.json()).resolves.toEqual({
          intervalSeconds: 5,
          status: "authorization_pending",
        });
        const firstPoll = await readPollState(runtime, start.userCode);
        expect(firstPoll.pollCount).toBe(1);
        expect(firstPoll.lastPollAt).not.toBeNull();

        const slowDownResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        expect(slowDownResponse.status).toBe(200);
        await expect(slowDownResponse.json()).resolves.toEqual({
          intervalSeconds: 10,
          status: "slow_down",
        });
        expect(await readPollState(runtime, start.userCode)).toEqual(firstPoll);

        await ageLastPoll(runtime);
        const agedPoll = await readPollState(runtime, start.userCode);
        const laterPendingResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        await expect(laterPendingResponse.json()).resolves.toEqual({
          intervalSeconds: 5,
          status: "authorization_pending",
        });
        const laterPoll = await readPollState(runtime, start.userCode);
        expect(laterPoll.pollCount).toBe(agedPoll.pollCount + 1);
        expect(laterPoll.lastPollAt).not.toBe(agedPoll.lastPollAt);

        await approve(runtime, start.userCode, "user_1");
        await expect(approve(runtime, start.userCode, "user_2")).rejects.toThrow();
        expect(await readApprovedUser(runtime)).toBe("user_1");
        await expect(deny(runtime, start.userCode)).rejects.toThrow();

        const approvedResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        expect(approvedResponse.status).toBe(200);
        const approved = (await approvedResponse.json()) as {
          apiKey: { key: string; permissions: Record<string, string[]> };
          status: string;
        };
        expect(approved.status).toBe("approved");
        expect(approved.apiKey.key).toMatch(/^nusend_/);
        expect(approved.apiKey.permissions).toEqual({ api_keys: ["read"], contacts: ["read"] });

        const meResponse = await app.fetch(
          new Request("http://localhost/api/me", { headers: { "x-api-key": approved.apiKey.key } }),
        );
        expect(meResponse.status).toBe(200);

        const secondResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        expect(secondResponse.status).toBe(200);
        await expect(secondResponse.json()).resolves.toEqual({ status: "expired_token" });
      },
    );
  });

  it("keeps early slow_down outside a write transaction", async () => {
    const runtime = makeTestRuntime({
      ids: ["device_1"],
      realApiKeys: true,
      realDeviceAuthorizations: true,
    });
    try {
      const [db, apiKeys, ids] = await runtime.runPromise(
        Effect.all([Database, ApiKeys, IdGenerator] as const),
      );
      let transactionCalls = 0;
      const instrumentedDb: DatabaseService = {
        ...db,
        transaction: (work) => {
          transactionCalls += 1;
          return db.transaction(work);
        },
      };
      const deviceAuthorizations = makeDeviceAuthorizationsService({
        apiKeys,
        db: instrumentedDb,
        hashSecret: testDeviceAuthSecret,
        ids,
      });
      const started = await runtime.runPromise(
        deviceAuthorizations.start({
          baseUrl: "http://localhost",
          clientName: "instrumented",
          permissions: { contacts: ["read"] },
          requesterFingerprint: "198.51.100.10",
        }),
      );

      transactionCalls = 0;
      await expect(
        runtime.runPromise(deviceAuthorizations.token(started.deviceCode)),
      ).resolves.toEqual({
        intervalSeconds: 5,
        status: "authorization_pending",
      });
      expect(transactionCalls).toBe(1);

      transactionCalls = 0;
      await expect(
        runtime.runPromise(deviceAuthorizations.token(started.deviceCode)),
      ).resolves.toEqual({
        intervalSeconds: 10,
        status: "slow_down",
      });
      expect(transactionCalls).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("consumes an approved grant exactly once across concurrent token polls", async () => {
    await withTestApp(
      {
        ids: ["device_1", "key_1", "key_2"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        const started = await startDevice(app, "concurrent-consumption");
        await approve(runtime, started.userCode, "user_1");

        const responses = await Promise.all([
          app.fetch(
            jsonRequest("http://localhost/api/device-authorizations/token", {
              deviceCode: started.deviceCode,
            }),
          ),
          app.fetch(
            jsonRequest("http://localhost/api/device-authorizations/token", {
              deviceCode: started.deviceCode,
            }),
          ),
        ]);
        const outcomes = await Promise.all(
          responses.map((response) => response.json() as Promise<{ status: string }>),
        );
        expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
          "approved",
          "expired_token",
        ]);
        expect(await countApiKeys(runtime)).toBe(1);
      },
    );
  });

  it("allows exactly one winner for concurrent approvals and approve/deny races", async () => {
    await withTestApp(
      {
        ids: ["device_1", "device_2"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        await seedUser(runtime, "user_2", "other@example.com");

        const approvalRace = await startDevice(app, "approval-race");
        const approvals = await Promise.allSettled([
          approve(runtime, approvalRace.userCode, "user_1"),
          approve(runtime, approvalRace.userCode, "user_2"),
        ]);
        expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(approvals.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(["user_1", "user_2"]).toContain(
          (await readAuthorizationState(runtime, approvalRace.userCode)).approvedByUserId,
        );

        const decisionRace = await startDevice(app, "decision-race");
        const decisions = await Promise.allSettled([
          approve(runtime, decisionRace.userCode, "user_1"),
          deny(runtime, decisionRace.userCode),
        ]);
        expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);

        const state = await readAuthorizationState(runtime, decisionRace.userCode);
        expect(Boolean(state.approvedAt) !== Boolean(state.deniedAt)).toBe(true);
      },
    );
  });

  it("rejects unknown permission resources and actions", async () => {
    await withTestApp(
      {
        ids: ["device_1", "device_2"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app) => {
        const unknownResource = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations", {
            clientName: "invalid-resource",
            permissions: { bogus: ["read"] },
          }),
        );
        expect(unknownResource.status).toBe(400);

        const unknownAction = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations", {
            clientName: "invalid-action",
            permissions: { contacts: ["delete"] },
          }),
        );
        expect(unknownAction.status).toBe(400);
      },
    );
  });

  it("enforces durable pending-row limits per fingerprint and globally while cleaning stale rows", async () => {
    await withTestApp(
      {
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await insertStaleAuthorization(runtime);

        await runSequential(0, 5, async (index) => {
          const response = await app.fetch(
            jsonRequest(
              "http://localhost/api/device-authorizations",
              { clientName: `same-${index}`, permissions: { contacts: ["read"] } },
              "198.51.100.1",
            ),
          );
          expect(response.status).toBe(201);
        });

        const sameFingerprint = await app.fetch(
          jsonRequest(
            "http://localhost/api/device-authorizations",
            { clientName: "same-blocked", permissions: { contacts: ["read"] } },
            "203.0.113.9, 198.51.100.1",
          ),
        );
        expect(sameFingerprint.status).toBe(429);
        await expect(sameFingerprint.json()).resolves.toEqual({
          error: {
            code: "rate_limited",
            message: "Too many pending device authorizations.",
          },
        });

        const differentFingerprint = await app.fetch(
          jsonRequest(
            "http://localhost/api/device-authorizations",
            { clientName: "different", permissions: { contacts: ["read"] } },
            "198.51.100.2",
          ),
        );
        expect(differentFingerprint.status).toBe(201);
        expect(await countStaleAuthorizations(runtime)).toBe(0);

        await runSequential(6, 30, async (index) => {
          const response = await app.fetch(
            jsonRequest(
              "http://localhost/api/device-authorizations",
              { clientName: `global-${index}`, permissions: { contacts: ["read"] } },
              `198.51.100.${index + 1}`,
            ),
          );
          expect(response.status).toBe(201);
        });

        await insertStaleAuthorization(runtime);
        const globalLimit = await app.fetch(
          jsonRequest(
            "http://localhost/api/device-authorizations",
            { clientName: "global-blocked", permissions: { contacts: ["read"] } },
            "203.0.113.200",
          ),
        );
        expect(globalLimit.status).toBe(429);
        expect(await countStaleAuthorizations(runtime)).toBe(0);
      },
    );
  });

  it("counts only active, unconsumed, undenied rows at the fingerprint ceiling", async () => {
    await withTestApp(
      {
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        await insertPendingAuthorizations(runtime, {
          count: 5,
          fingerprintFor: () => "198.51.100.40",
          prefix: "fingerprint",
        });
        await setAuthorizationState(runtime, "fingerprint_0", "approved");

        const request = (clientName: string) =>
          app.fetch(
            jsonRequest(
              "http://localhost/api/device-authorizations",
              { clientName, permissions: { contacts: ["read"] } },
              "untrusted, 198.51.100.40",
            ),
          );

        expect((await request("approved-still-counts")).status).toBe(429);
        await setAuthorizationState(runtime, "fingerprint_1", "denied");
        expect((await request("denied-frees-slot")).status).toBe(201);
        await setAuthorizationState(runtime, "fingerprint_2", "consumed");
        expect((await request("consumed-frees-slot")).status).toBe(201);
        await setAuthorizationState(runtime, "fingerprint_3", "expired");
        expect((await request("expired-frees-slot")).status).toBe(201);
      },
    );
  });

  it("counts only active, unconsumed, undenied rows at the global ceiling", async () => {
    await withTestApp(
      {
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        await insertPendingAuthorizations(runtime, {
          count: 30,
          fingerprintFor: (index) => `198.51.100.${index + 1}`,
          prefix: "global",
        });
        await setAuthorizationState(runtime, "global_0", "approved");

        const request = (clientName: string, address: string) =>
          app.fetch(
            jsonRequest(
              "http://localhost/api/device-authorizations",
              { clientName, permissions: { contacts: ["read"] } },
              address,
            ),
          );

        expect((await request("approved-still-counts", "203.0.113.1")).status).toBe(429);
        await setAuthorizationState(runtime, "global_1", "denied");
        expect((await request("denied-frees-slot", "203.0.113.2")).status).toBe(201);
        await setAuthorizationState(runtime, "global_2", "consumed");
        expect((await request("consumed-frees-slot", "203.0.113.3")).status).toBe(201);
        await setAuthorizationState(runtime, "global_3", "expired");
        expect((await request("expired-frees-slot", "203.0.113.4")).status).toBe(201);
      },
    );
  });

  it("stores only a masked user-code preview", async () => {
    await withTestApp(
      { ids: ["device_1"], realApiKeys: true, realDeviceAuthorizations: true },
      async (app, runtime) => {
        const start = await startDevice(app, "cli");
        const preview = await runtime.runPromise(
          Effect.flatMap(Database, (db) =>
            db.get<{ user_code_preview: string }>(
              "test:read-preview",
              "SELECT user_code_preview FROM device_authorizations LIMIT 1;",
            ),
          ),
        );
        expect(preview?.user_code_preview).toContain("•");
        expect(preview?.user_code_preview).not.toBe(start.userCode);
      },
    );
  });

  it("delivers an approved key even when polled faster than the interval", async () => {
    await withTestApp(
      { ids: ["device_1", "key_1"], realApiKeys: true, realDeviceAuthorizations: true },
      async (app, runtime) => {
        await seedUser(runtime);
        const start = await startDevice(app, "cli");

        // First poll records last_poll_at.
        await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        await approve(runtime, start.userCode, "user_1");

        // Immediate second poll is within the interval (too-soon) but the grant is
        // approved — it must be delivered, not masked by slow_down.
        const response = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        await expect(response.json()).resolves.toMatchObject({ status: "approved" });
      },
    );
  });

  it("pins the exact production start and token rate boundaries", () => {
    const limiters = makeDefaultDeviceAuthorizationRouteLimiters(() => 1_000);

    expectAllowedAttempts(limiters.startSource, "source", 10);
    expect(limiters.startSource.attempt("source")).toEqual({
      kind: "Limited",
      reason: "rate",
      retryAfterMs: 15 * 60_000,
    });

    expectAllowedAttempts(limiters.globalStart, "global", 60);
    expect(limiters.globalStart.attempt("global")).toEqual({
      kind: "Limited",
      reason: "rate",
      retryAfterMs: 15 * 60_000,
    });

    expectAllowedAttempts(limiters.tokenSource, "source", 120);
    expect(limiters.tokenSource.attempt("source")).toEqual({
      kind: "Limited",
      reason: "rate",
      retryAfterMs: 60_000,
    });

    expectAllowedAttempts(limiters.globalToken, "global", 600);
    expect(limiters.globalToken.attempt("global")).toEqual({
      kind: "Limited",
      reason: "rate",
      retryAfterMs: 60_000,
    });
  });

  it("pins the exact production start and token source-key capacities", () => {
    const start = makeDefaultDeviceAuthorizationRouteLimiters(() => 1_000).startSource;
    expectDistinctKeysAllowed(start, "start", 128);
    expect(start.diagnostics()).toEqual({ activeKeys: 128 });
    expect(start.attempt("start-over-capacity")).toEqual({
      kind: "Limited",
      reason: "capacity",
      retryAfterMs: 15 * 60_000,
    });

    const token = makeDefaultDeviceAuthorizationRouteLimiters(() => 1_000).tokenSource;
    expectDistinctKeysAllowed(token, "token", 1_024);
    expect(token.diagnostics()).toEqual({ activeKeys: 1_024 });
    expect(token.attempt("token-over-capacity")).toEqual({
      kind: "Limited",
      reason: "capacity",
      retryAfterMs: 60_000,
    });
  });

  it("enforces the per-source route ceiling while another trusted last hop still succeeds", async () => {
    const runtime = makeTestRuntime({
      ids: ["device_a", "device_b", "device_c"],
      realApiKeys: true,
      realDeviceAuthorizations: true,
    });
    try {
      const routes = createDeviceAuthorizationRoutes({
        globalStartRateLimiter: makeAttemptLimiter({
          max: 100,
          maxEntries: 1,
          now: () => 1_000,
          windowMs: 60_000,
        }),
        runtime,
        startRateLimiter: makeAttemptLimiter({
          max: 2,
          maxEntries: 128,
          now: () => 1_000,
          windowMs: 60_000,
        }),
      });
      const make = (forwardedFor: string) =>
        jsonRequest(
          "http://localhost/",
          { clientName: "cli", permissions: { contacts: ["read"] } },
          forwardedFor,
        );

      expect((await routes.fetch(make("untrusted, 1.2.3.4"))).status).toBe(201);
      expect((await routes.fetch(make("rotated, 1.2.3.4"))).status).toBe(201);
      const limited = await routes.fetch(make("untrusted, 1.2.3.4"));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      await expect(limited.json()).resolves.toEqual({
        error: {
          code: "rate_limited",
          message: "Too many device authorization requests. Try again later.",
        },
      });
      expect((await routes.fetch(make("untrusted, 5.6.7.8"))).status).toBe(201);
    } finally {
      await runtime.dispose();
    }
  });

  it("enforces the process-local global route ceiling across distinct sources", async () => {
    const runtime = makeTestRuntime({
      ids: ["device_a", "device_b"],
      realApiKeys: true,
      realDeviceAuthorizations: true,
    });
    try {
      const routes = createDeviceAuthorizationRoutes({
        globalStartRateLimiter: makeAttemptLimiter({
          max: 2,
          maxEntries: 1,
          now: () => 1_000,
          windowMs: 60_000,
        }),
        runtime,
        startRateLimiter: makeAttemptLimiter({
          max: 100,
          maxEntries: 128,
          now: () => 1_000,
          windowMs: 60_000,
        }),
      });
      const make = (address: string) =>
        jsonRequest(
          "http://localhost/",
          { clientName: "cli", permissions: { contacts: ["read"] } },
          address,
        );

      expect((await routes.fetch(make("1.1.1.1"))).status).toBe(201);
      expect((await routes.fetch(make("2.2.2.2"))).status).toBe(201);
      const limited = await routes.fetch(make("3.3.3.3"));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      await expect(limited.json()).resolves.toEqual({
        error: {
          code: "rate_limited",
          message: "Too many device authorization requests. Try again later.",
        },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("enforces token source and global ceilings before database access", async () => {
    const runtime = makeTestRuntime({
      realApiKeys: true,
      realDeviceAuthorizations: true,
    });
    try {
      const routes = createDeviceAuthorizationRoutes({
        globalTokenRateLimiter: makeAttemptLimiter({
          max: 4,
          maxEntries: 1,
          now: () => 1_000,
          windowMs: 60_000,
        }),
        runtime,
        tokenRateLimiter: makeAttemptLimiter({
          max: 2,
          maxEntries: 1_024,
          now: () => 1_000,
          windowMs: 60_000,
        }),
      });
      const make = (forwardedFor: string) =>
        jsonRequest("http://localhost/token", { deviceCode: "unknown" }, forwardedFor);

      expect((await routes.fetch(make("untrusted, 1.2.3.4"))).status).toBe(200);
      expect((await routes.fetch(make("rotated, 1.2.3.4"))).status).toBe(200);

      const sourceLimited = await routes.fetch(make("untrusted, 1.2.3.4"));
      expect(sourceLimited.status).toBe(429);
      expect(sourceLimited.headers.get("retry-after")).toBe("60");
      await expect(sourceLimited.json()).resolves.toEqual({
        error: {
          code: "rate_limited",
          message: "Too many device authorization requests. Try again later.",
        },
      });

      // The source-rejected request consumed global capacity, while an
      // independent second source still had its own source allowance.
      expect((await routes.fetch(make("untrusted, 5.6.7.8"))).status).toBe(200);
      const globalLimited = await routes.fetch(make("untrusted, 9.10.11.12"));
      expect(globalLimited.status).toBe(429);
      expect(globalLimited.headers.get("retry-after")).toBe("60");
      await expect(globalLimited.json()).resolves.toEqual({
        error: {
          code: "rate_limited",
          message: "Too many device authorization requests. Try again later.",
        },
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("does not mutate a token row when source capacity rejects the route", async () => {
    const runtime = makeTestRuntime({
      ids: ["device_1"],
      realApiKeys: true,
      realDeviceAuthorizations: true,
    });
    const globalLimiter = makeAttemptLimiter({
      max: 1,
      maxEntries: 1,
      now: () => 1_000,
      windowMs: 60_000,
    });
    const sourceLimiter = makeAttemptLimiter({
      max: 120,
      maxEntries: 1,
      now: () => 1_000,
      windowMs: 60_000,
    });
    expect(sourceLimiter.attempt("occupied-source")).toEqual({ kind: "Allowed" });

    try {
      const start = await startAuthorization(runtime, "direct");
      const before = await readPollState(runtime, start.userCode);
      const routes = createDeviceAuthorizationRoutes({
        globalTokenRateLimiter: globalLimiter,
        runtime,
        tokenRateLimiter: sourceLimiter,
      });

      const response = await routes.fetch(
        jsonRequest(
          "http://localhost/token",
          { deviceCode: start.deviceCode },
          "untrusted, rejected-source",
        ),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "rate_limited",
          message: "Too many device authorization requests. Try again later.",
        },
      });
      expect(await readPollState(runtime, start.userCode)).toEqual(before);
      expect(globalLimiter.attempt("global")).toMatchObject({
        kind: "Limited",
        reason: "rate",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("uses the configured public origin for verification URLs behind a proxy", async () => {
    const runtime = makeTestRuntime({
      ids: ["device_p"],
      realApiKeys: true,
      realDeviceAuthorizations: true,
    });
    try {
      const routes = createDeviceAuthorizationRoutes({
        publicOrigin: "https://public.example.com",
        runtime,
      });

      const response = await routes.fetch(
        jsonRequest("http://internal.local/", {
          clientName: "cli",
          permissions: { contacts: ["read"] },
        }),
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { verificationUri: string };
      expect(body.verificationUri).toBe("https://public.example.com/cli/activate");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns invalid_grant for unknown codes and preserves expired_token for expired rows", async () => {
    await withTestApp(
      {
        ids: ["expired_device"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        const unknown = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: "unknown",
          }),
        );
        await expect(unknown.json()).resolves.toEqual({ status: "invalid_grant" });

        const expiredStart = await startDevice(app, "expired");
        await expire(runtime, expiredStart.userCode);
        const expiredResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: expiredStart.deviceCode,
          }),
        );
        await expect(expiredResponse.json()).resolves.toEqual({ status: "expired_token" });
      },
    );
  });

  it("returns internal_error when an approved authorization has corrupt stored permissions", async () => {
    await withTestApp(
      {
        ids: ["corrupt_device", "key_1"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        const start = await startDevice(app, "corrupt");
        await approve(runtime, start.userCode, "user_1");
        await corruptStoredPermissions(runtime, start.userCode);

        const response = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: start.deviceCode,
          }),
        );
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "internal_error" },
        });
      },
    );
  });

  it("returns access_denied for denied codes and expired_token for expired codes", async () => {
    await withTestApp(
      {
        ids: ["denied_device", "expired_device"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        const deniedStart = await startDevice(app, "denied");
        await deny(runtime, deniedStart.userCode);
        const deniedResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: deniedStart.deviceCode,
          }),
        );
        await expect(deniedResponse.json()).resolves.toEqual({ status: "access_denied" });

        const expiredStart = await startDevice(app, "expired");
        await expire(runtime, expiredStart.userCode);
        const expiredResponse = await app.fetch(
          jsonRequest("http://localhost/api/device-authorizations/token", {
            deviceCode: expiredStart.deviceCode,
          }),
        );
        await expect(expiredResponse.json()).resolves.toEqual({ status: "expired_token" });
      },
    );
  });
});

function expectAllowedAttempts(limiter: AttemptLimiter, key: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    expect(limiter.attempt(key)).toEqual({ kind: "Allowed" });
  }
}

function expectDistinctKeysAllowed(limiter: AttemptLimiter, prefix: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    expect(limiter.attempt(`${prefix}-${index}`)).toEqual({ kind: "Allowed" });
  }
}

function runSequential(
  start: number,
  end: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  return start >= end
    ? Promise.resolve()
    : task(start).then(() => runSequential(start + 1, end, task));
}

function jsonRequest(url: string, body: unknown, forwardedFor?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  return new Request(url, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });
}

async function startDevice(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  clientName: string,
) {
  const response = await app.fetch(
    jsonRequest("http://localhost/api/device-authorizations", {
      clientName,
      permissions: { contacts: ["read"] },
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { deviceCode: string; userCode: string };
}

async function startAuthorization(runtime: TestRuntime, requesterFingerprint: string) {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const deviceAuthorizations = yield* DeviceAuthorizations;
      return yield* deviceAuthorizations.start({
        baseUrl: "http://localhost",
        clientName: "cli",
        permissions: { contacts: ["read"] },
        requesterFingerprint,
      });
    }),
  );
}

async function approve(runtime: TestRuntime, userCode: string, userId: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const deviceAuthorizations = yield* DeviceAuthorizations;
      yield* deviceAuthorizations.approve({ userCode, userId });
    }),
  );
}

async function deny(runtime: TestRuntime, userCode: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const deviceAuthorizations = yield* DeviceAuthorizations;
      yield* deviceAuthorizations.deny({ userCode });
    }),
  );
}

async function readAuthorizationState(
  runtime: TestRuntime,
  userCode: string,
): Promise<{
  approvedAt: string | null;
  approvedByUserId: string | null;
  deniedAt: string | null;
}> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{
        approved_at: string | null;
        approved_by_user_id: string | null;
        denied_at: string | null;
      }>(
        "deviceAuthTest:readAuthorizationState",
        `SELECT approved_at, approved_by_user_id, denied_at
         FROM device_authorizations
         WHERE user_code_hash = $userCodeHash;`,
        { userCodeHash: userCodeHash(userCode) },
      );
      return {
        approvedAt: row?.approved_at ?? null,
        approvedByUserId: row?.approved_by_user_id ?? null,
        deniedAt: row?.denied_at ?? null,
      };
    }),
  );
}

async function readPollState(
  runtime: TestRuntime,
  userCode: string,
): Promise<{ lastPollAt: string | null; pollCount: number }> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{ last_poll_at: string | null; poll_count: number }>(
        "deviceAuthTest:readPollState",
        `SELECT last_poll_at, poll_count
         FROM device_authorizations
         WHERE user_code_hash = $userCodeHash;`,
        { userCodeHash: userCodeHash(userCode) },
      );
      return {
        lastPollAt: row?.last_poll_at ?? null,
        pollCount: row?.poll_count ?? 0,
      };
    }),
  );
}

async function countApiKeys(runtime: TestRuntime): Promise<number> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{ count: number }>(
        "deviceAuthTest:countApiKeys",
        "SELECT COUNT(*) AS count FROM api_keys;",
      );
      return row?.count ?? 0;
    }),
  );
}

async function readApprovedUser(runtime: TestRuntime): Promise<string | null> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{ approved_by_user_id: string | null }>(
        "deviceAuthTest:readApprovedUser",
        "SELECT approved_by_user_id FROM device_authorizations LIMIT 1;",
      );
      return row?.approved_by_user_id ?? null;
    }),
  );
}

async function insertPendingAuthorizations(
  runtime: TestRuntime,
  input: {
    readonly count: number;
    readonly fingerprintFor: (index: number) => string;
    readonly prefix: string;
  },
): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      for (let index = 0; index < input.count; index += 1) {
        const id = `${input.prefix}_${index}`;
        yield* db.run(
          "deviceAuthTest:insertPending",
          `INSERT INTO device_authorizations (
            id, device_code_hash, user_code_hash, user_code_preview,
            requested_permissions_json, client_name, expires_at,
            requester_fingerprint_hash, created_at
          ) VALUES (
            $id, $deviceCodeHash, $userCodeHash, 'AB••-••YZ',
            '{"contacts":["read"]}', 'fixture', '2999-01-01T00:00:00.000Z',
            $requesterFingerprintHash, '2026-07-13T00:00:00.000Z'
          );`,
          {
            deviceCodeHash: `device-${id}`,
            id,
            requesterFingerprintHash: hashDeviceAuthCode(
              input.fingerprintFor(index),
              testDeviceAuthSecret,
            ),
            userCodeHash: `user-${id}`,
          },
        );
      }
    }),
  );
}

async function setAuthorizationState(
  runtime: TestRuntime,
  id: string,
  state: "approved" | "consumed" | "denied" | "expired",
): Promise<void> {
  const assignment = {
    approved: "approved_at = '2026-07-13T00:00:00.000Z', approved_by_user_id = 'user_1'",
    consumed:
      "approved_at = '2026-07-13T00:00:00.000Z', approved_by_user_id = 'user_1', consumed_at = '2026-07-13T00:00:00.000Z'",
    denied: "denied_at = '2026-07-13T00:00:00.000Z'",
    expired: "expires_at = '2000-01-01T00:00:00.000Z'",
  }[state];
  await runtime.runPromise(
    Effect.flatMap(Database, (db) =>
      db.run(
        "deviceAuthTest:setAuthorizationState",
        `UPDATE device_authorizations SET ${assignment} WHERE id = $id;`,
        { id },
      ),
    ),
  );
}

async function insertStaleAuthorization(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "deviceAuthTest:insertStale",
        `INSERT INTO device_authorizations (
          id, device_code_hash, user_code_hash, user_code_preview,
          requested_permissions_json, client_name, expires_at, created_at
        ) VALUES (
          'stale', 'stale-device', 'stale-user', 'AAAA-BBBB',
          '{"contacts":["read"]}', 'stale', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'
        );`,
      );
    }),
  );
}

async function countStaleAuthorizations(runtime: TestRuntime): Promise<number> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{ count: number }>(
        "deviceAuthTest:countStale",
        "SELECT COUNT(*) AS count FROM device_authorizations WHERE id = 'stale';",
      );
      return row?.count ?? 0;
    }),
  );
}

async function ageLastPoll(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "deviceAuthTest:ageLastPoll",
        "UPDATE device_authorizations SET last_poll_at = '2000-01-01T00:00:00.000Z';",
      );
    }),
  );
}

async function corruptStoredPermissions(runtime: TestRuntime, userCode: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "deviceAuthTest:corruptPermissions",
        "UPDATE device_authorizations SET requested_permissions_json = 'not-json' WHERE user_code_hash = $userCodeHash;",
        { userCodeHash: userCodeHash(userCode) },
      );
    }),
  );
}

async function expire(runtime: TestRuntime, userCode: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "deviceAuthTest:expire",
        "UPDATE device_authorizations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_code_hash = $userCodeHash;",
        { userCodeHash: userCodeHash(userCode) },
      );
    }),
  );
}

async function readDeviceRows(
  runtime: TestRuntime,
): Promise<readonly { device_code_hash: string; user_code_hash: string }[]> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.all<{ device_code_hash: string; user_code_hash: string }>(
        "deviceAuthTest:readRows",
        "SELECT device_code_hash, user_code_hash FROM device_authorizations;",
      );
    }),
  );
}

async function seedUser(
  runtime: TestRuntime,
  id = "user_1",
  email = "max@example.com",
): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "deviceAuthTest:seedUser",
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ($id, 'Max', $email, 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
        { email, id },
      );
    }),
  );
}
