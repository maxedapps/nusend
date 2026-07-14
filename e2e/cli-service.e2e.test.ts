import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../apps/cli/src/main.ts";
import { createServiceBridge } from "../apps/cli/src/testing/service-bridge.ts";
import {
  queryTestDatabase,
  runTestSql,
  seedTestUser,
  withTestApp,
} from "../apps/service/src/testing/layers.ts";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI and service", () => {
  it("logs in and exercises authenticated commands against the real app", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["device_1", "login_key", "created_key", "contact_1"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedTestUser(runtime);
        await runTestSql(
          runtime,
          "cliE2e:seedMailing",
          `INSERT INTO mailings (id, purpose, state, name, subject, html, text, created_at, updated_at)
           VALUES ('mailing_1', 'transactional', 'completed', 'E2E', 'E2E subject', '<p>E2E</p>', NULL, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
        );
        const directory = await mkdtemp(join(tmpdir(), "nusend-cli-e2e-"));
        temporaryDirectories.push(directory);
        const env = { XDG_CONFIG_HOME: directory };
        const logs: string[] = [];
        const requestedPaths: string[] = [];
        vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
        globalThis.fetch = createServiceBridge(async (request) => {
          const response = await app.fetch(request);
          const url = new URL(request.url);
          requestedPaths.push(`${request.method} ${url.pathname}${url.search}`);
          if (request.method === "POST" && url.pathname === "/api/device-authorizations") {
            const started = (await response.clone().json()) as { userCode: string };
            await approveThroughActivation(app, started.userCode);
          }
          return response;
        });

        await expect(runCli(["login", "http://localhost"], env, noWaitRuntime())).resolves.toEqual({
          exitCode: 0,
        });
        await expect(runCli(["whoami"], env)).resolves.toEqual({ exitCode: 0 });
        const beforeKeyCreate = Date.now();
        await expect(
          runCli(["api-keys", "create", "--name", "e2e", "--permission", "contacts:read"], env),
        ).resolves.toEqual({ exitCode: 0 });
        const afterKeyCreate = Date.now();
        await expect(runCli(["contacts", "create", "user@example.com"], env)).resolves.toEqual({
          exitCode: 0,
        });
        await expect(runCli(["mailings", "list"], env)).resolves.toEqual({ exitCode: 0 });

        const contacts = await queryTestDatabase<{ email: string; id: string }>(
          runtime,
          "cliE2e:contacts",
          "SELECT id, email FROM contacts WHERE id = 'contact_1';",
        );
        const keys = await queryTestDatabase<{ expires_at: string; id: string }>(
          runtime,
          "cliE2e:keys",
          "SELECT id, expires_at FROM api_keys WHERE id = 'created_key';",
        );
        const createdExpiry = Date.parse(keys[0]?.expires_at ?? "");

        expect(requestedPaths).toContain("GET /api/mailings");
        expect(logs.join("\n")).toContain("api_key user=user_1 key=login_key");
        expect(logs.join("\n")).toContain("mailing_1\tcompleted\ttransactional\tE2E subject");
        expect(contacts).toEqual([{ email: "user@example.com", id: "contact_1" }]);
        expect(keys[0]?.id).toBe("created_key");
        expect(createdExpiry).toBeGreaterThanOrEqual(beforeKeyCreate + 365 * 24 * 60 * 60 * 1000);
        expect(createdExpiry).toBeLessThanOrEqual(afterKeyCreate + 365 * 24 * 60 * 60 * 1000);
      },
    );
  });
  it("logs in with --json and emits the verification line on stderr", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["device_json", "json_key"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedTestUser(runtime);
        const directory = await mkdtemp(join(tmpdir(), "nusend-cli-e2e-json-"));
        temporaryDirectories.push(directory);
        const env = { XDG_CONFIG_HOME: directory };
        const logs: string[] = [];
        const errors: string[] = [];
        vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
        vi.spyOn(console, "error").mockImplementation((value) => errors.push(String(value)));
        globalThis.fetch = createServiceBridge(async (request) => {
          const response = await app.fetch(request);
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname === "/api/device-authorizations") {
            const started = (await response.clone().json()) as { userCode: string };
            await approveThroughActivation(app, started.userCode);
          }
          return response;
        });

        await expect(
          runCli(["--json", "login", "http://localhost"], env, noWaitRuntime()),
        ).resolves.toEqual({
          exitCode: 0,
        });

        // The app's request logging also writes to the console; only the CLI's
        // own output lines are JSON documents.
        const stderrJson = errors.filter((line) => line.startsWith("{"));
        expect(stderrJson).toHaveLength(1);
        const verification = JSON.parse(stderrJson[0] ?? "") as {
          verification: { uri: string; userCode: string };
        };
        expect(verification.verification.uri).toBe("http://localhost/cli/activate");
        expect(verification.verification.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        const stdoutJson = logs.filter((line) => line.startsWith("{"));
        expect(stdoutJson).toHaveLength(1);
        expect(JSON.parse(stdoutJson[0] ?? "")).toMatchObject({
          profile: "default",
          stored: true,
        });
      },
    );
  });
});

function noWaitRuntime() {
  return {
    now: Date.now,
    sleep: async (_milliseconds: number) => undefined,
  };
}

async function approveThroughActivation(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  userCode: string,
): Promise<void> {
  const get = await app.fetch(
    new Request(`http://localhost/cli/activate?code=${encodeURIComponent(userCode)}`),
  );
  const html = await get.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();

  const approved = await app.fetch(
    new Request("http://localhost/cli/activate", {
      body: new URLSearchParams({ action: "approve", code: userCode, csrf: csrf ?? "" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: get.headers.get("set-cookie") ?? "",
        origin: "http://localhost",
      },
      method: "POST",
    }),
  );
  expect(approved.status).toBe(200);
  await expect(approved.text()).resolves.toContain("CLI device approved");
}
