import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { DeviceAuthorizations } from "./service.ts";
import { withTestApp, type TestRuntime } from "../testing/layers.ts";

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

        await approve(runtime, start.userCode, "user_1");
        await expect(approve(runtime, start.userCode, "user_2")).rejects.toThrow();
        expect(await readApprovedUser(runtime)).toBe("user_1");
        await expect(deny(runtime, start.userCode)).rejects.toThrow();
        await ageLastPoll(runtime);

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

  it("rate-limits starts globally and per requester fingerprint and cleans stale rows", async () => {
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
         WHERE user_code_preview = $userCode;`,
        { userCode },
      );
      return {
        approvedAt: row?.approved_at ?? null,
        approvedByUserId: row?.approved_by_user_id ?? null,
        deniedAt: row?.denied_at ?? null,
      };
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
        "UPDATE device_authorizations SET requested_permissions_json = 'not-json' WHERE user_code_preview = $userCode;",
        { userCode },
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
        "UPDATE device_authorizations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_code_preview = $userCode;",
        { userCode },
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
