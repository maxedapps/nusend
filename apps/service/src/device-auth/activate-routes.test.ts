import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { withTestApp, type TestRuntime } from "../testing/layers.ts";

describe("CLI activation page", () => {
  it("renders unauthenticated sign-in page with no-store headers", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(new Request("http://localhost/cli/activate?code=ABCD-2345"));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(body).toContain("Sign in with Google");
      expect(body).toContain('fetch("/api/auth/sign-in/social"');
      expect(body).toContain('callbackURL: "/cli/activate?code=ABCD-2345"');
      expect(body).not.toContain("/api/auth/sign-in/google");

      const maliciousCode = 'ABCD-2345";</script><script>alert(1)</script>';
      const maliciousResponse = await app.fetch(
        new Request(`http://localhost/cli/activate?code=${encodeURIComponent(maliciousCode)}`),
      );
      const maliciousBody = await maliciousResponse.text();
      expect(maliciousBody).toContain('callbackURL: "/cli/activate"');
      expect(maliciousBody).not.toContain(maliciousCode);
      expect(maliciousBody).not.toContain("alert(1)");
    });
  });

  it("renders approval form, protects POST with CSRF/origin checks, and approves", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["device_1", "key_1"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedUser(runtime);
        const started = await startDevice(app);

        const getResponse = await app.fetch(
          new Request(`http://localhost/cli/activate?code=${encodeURIComponent(started.userCode)}`),
        );
        const html = await getResponse.text();
        const cookie = getResponse.headers.get("set-cookie") ?? "";
        const csrf = extractCsrf(html);

        expect(getResponse.status).toBe(200);
        expect(html).toContain("Approve Nusend CLI");
        expect(html).toContain("nusend-cli browser test");
        expect(html).toContain("contacts:read");
        expect(html).not.toContain(started.deviceCode);

        const noCsrf = await postActivation(app, started.userCode, "", cookie);
        expect(noCsrf.status).toBe(403);

        const noOriginOrReferer = await app.fetch(
          new Request("http://localhost/cli/activate", {
            body: formBody({ action: "approve", code: started.userCode, csrf }),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie,
            },
            method: "POST",
          }),
        );
        expect(noOriginOrReferer.status).toBe(403);

        const badOrigin = await postActivation(
          app,
          started.userCode,
          csrf,
          cookie,
          "https://evil.example",
        );
        expect(badOrigin.status).toBe(403);

        const malformedReferer = await app.fetch(
          new Request("http://localhost/cli/activate", {
            body: formBody({ action: "approve", code: started.userCode, csrf }),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie,
              origin: "http://localhost",
              referer: "not a url",
            },
            method: "POST",
          }),
        );
        expect(malformedReferer.status).toBe(403);

        const approved = await app.fetch(
          new Request("http://localhost/cli/activate", {
            body: formBody({ action: "approve", code: started.userCode, csrf }),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie,
              origin: "http://localhost",
              referer: `http://localhost/cli/activate?code=${encodeURIComponent(started.userCode)}`,
            },
            method: "POST",
          }),
        );
        expect(approved.status).toBe(200);
        await expect(approved.text()).resolves.toContain("CLI device approved");

        const approvedAt = await readApprovedAt(runtime);
        expect(approvedAt).not.toBeNull();
      },
    );
  });

  it("sets Secure cookies for HTTPS requests", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(
        new Request("http://localhost/cli/activate", {
          headers: { "x-forwarded-proto": "https" },
        }),
      );

      expect(response.headers.get("set-cookie")).toContain("; Secure");
    });
  });

  it("locks a user out after ten invalid codes, including from a valid code", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app) => {
        await runSequential(0, 10, async (index) => {
          const response = await app.fetch(
            new Request(`http://localhost/cli/activate?code=BAD${index}-CODE`),
          );
          expect(response.status).toBe(200);
          if (index === 0) {
            await expect(response.text()).resolves.toContain(
              "Device authorization code is invalid or expired.",
            );
          }
        });

        const started = await startDevice(app);
        const locked = await app.fetch(
          new Request(`http://localhost/cli/activate?code=${encodeURIComponent(started.userCode)}`),
        );

        expect(locked.status).toBe(403);
        await expect(locked.text()).resolves.toContain("Too many attempts. Try again later.");
      },
    );
  });

  it("rejects unknown activation actions with 400 without recording lockout failures", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app) => {
        const started = await startDevice(app);
        const getResponse = await app.fetch(
          new Request(`http://localhost/cli/activate?code=${encodeURIComponent(started.userCode)}`),
        );
        const html = await getResponse.text();
        const cookie = getResponse.headers.get("set-cookie") ?? "";
        const csrf = extractCsrf(html);

        await runSequential(0, 10, async () => {
          const response = await app.fetch(
            new Request("http://localhost/cli/activate", {
              body: formBody({ action: "frobnicate", code: started.userCode, csrf }),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie,
                origin: "http://localhost",
              },
              method: "POST",
            }),
          );
          expect(response.status).toBe(400);
          await expect(response.text()).resolves.toContain("Unknown activation action.");
        });

        const stillNotLocked = await app.fetch(
          new Request(`http://localhost/cli/activate?code=${encodeURIComponent(started.userCode)}`),
        );
        expect(stillNotLocked.status).toBe(200);
        await expect(stillNotLocked.text()).resolves.toContain("Approve Nusend CLI");
      },
    );
  });

  it("treats expired codes as invalid on the activation page and records lockout failures", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        const started = await startDevice(app);
        await expireAuthorization(runtime, started.userCode);

        await runSequential(0, 10, async () => {
          const response = await app.fetch(
            new Request(
              `http://localhost/cli/activate?code=${encodeURIComponent(started.userCode)}`,
            ),
          );
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toContain(
            "Device authorization code is invalid or expired.",
          );
        });

        const fresh = await startDevice(app);
        const locked = await app.fetch(
          new Request(`http://localhost/cli/activate?code=${encodeURIComponent(fresh.userCode)}`),
        );
        expect(locked.status).toBe(403);
        await expect(locked.text()).resolves.toContain("Too many attempts. Try again later.");
      },
    );
  });

  it("denies a device authorization through the activation POST", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        const started = await startDevice(app);
        const getResponse = await app.fetch(
          new Request(`http://localhost/cli/activate?code=${encodeURIComponent(started.userCode)}`),
        );
        const html = await getResponse.text();
        const denied = await app.fetch(
          new Request("http://localhost/cli/activate", {
            body: formBody({
              action: "deny",
              code: started.userCode,
              csrf: extractCsrf(html),
            }),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: getResponse.headers.get("set-cookie") ?? "",
              origin: "http://localhost",
            },
            method: "POST",
          }),
        );

        expect(denied.status).toBe(200);
        await expect(denied.text()).resolves.toContain("CLI device denied");
        expect(await readDeniedAt(runtime)).not.toBeNull();
      },
    );
  });
});

async function startDevice(app: { fetch: (request: Request) => Response | Promise<Response> }) {
  const response = await app.fetch(
    new Request("http://localhost/api/device-authorizations", {
      body: JSON.stringify({
        clientName: "nusend-cli browser test",
        permissions: { contacts: ["read"] },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { deviceCode: string; userCode: string };
}

function postActivation(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  code: string,
  csrf: string,
  cookie: string,
  origin = "http://localhost",
) {
  return app.fetch(
    new Request("http://localhost/cli/activate", {
      body: formBody({ action: "approve", code, csrf }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        origin,
        referer: `http://localhost/cli/activate?code=${encodeURIComponent(code)}`,
      },
      method: "POST",
    }),
  );
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

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function extractCsrf(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  expect(match?.[1]).toBeTruthy();
  return match?.[1] ?? "";
}

async function expireAuthorization(runtime: TestRuntime, userCode: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "activationTest:expire",
        "UPDATE device_authorizations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_code_preview = $userCode;",
        { userCode },
      );
    }),
  );
}

async function readDeniedAt(runtime: TestRuntime): Promise<string | null> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{ denied_at: string | null }>(
        "activationTest:readDeniedAt",
        "SELECT denied_at FROM device_authorizations LIMIT 1;",
      );
      return row?.denied_at ?? null;
    }),
  );
}

async function readApprovedAt(runtime: TestRuntime): Promise<string | null> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{ approved_at: string | null }>(
        "activationTest:readApprovedAt",
        "SELECT approved_at FROM device_authorizations LIMIT 1;",
      );
      return row?.approved_at ?? null;
    }),
  );
}

async function seedUser(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "activationTest:seedUser",
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ('user_1', 'Max', 'max@example.com', 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
      );
    }),
  );
}
