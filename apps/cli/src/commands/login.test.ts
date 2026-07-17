import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLocalState } from "../config/local-state.js";
import { configDirectory, statePath } from "../config/paths.js";
import { runCli, runMain } from "../main.js";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("login command", () => {
  it("polls pending and slow_down, then stores one service credential", async () => {
    const env = await tempEnv();
    const responses = [
      startResponse(0.001),
      { intervalSeconds: 0.002, status: "authorization_pending" },
      { intervalSeconds: 0.003, status: "slow_down" },
      approvedResponse(),
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let stderrLinesAtFirstPoll = -1;
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/token") && stderrLinesAtFirstPoll < 0) {
        stderrLinesAtFirstPoll = error.mock.calls.length;
      }
      return Response.json(responses.shift());
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];

    await expect(
      runCli(["--json", "login", "https://mail.example.com"], env, {
        now: () => 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
    ).resolves.toEqual({ exitCode: 0 });

    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      apiKey: { id: "key_1" },
      stored: true,
    });
    expect(stderrLinesAtFirstPoll).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      verification: {
        expiresAt: "2099-01-01T00:00:00.000Z",
        uri: "https://mail.example.com/cli/activate",
        uriComplete: null,
        userCode: "ABCD-2345",
      },
    });
    await expect(loadLocalState(env)).resolves.toMatchObject({
      baseUrl: "https://mail.example.com",
      credential: { apiKey: "nusend_raw_secret" },
    });
  });

  it("reaches login and rewrites corrupt state.json via the CLI entry path", async () => {
    const env = await tempEnv();
    await mkdir(configDirectory(env), { mode: 0o700, recursive: true });
    await writeFile(statePath(env), "not-valid-json\n", { mode: 0o600 });
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      return Response.json(url.endsWith("/token") ? approvedResponse() : startResponse(0));
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["--json", "login", "https://mail.example.com"], env, {
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 0 });

    await expect(loadLocalState(env)).resolves.toMatchObject({
      baseUrl: "https://mail.example.com",
      credential: { apiKey: "nusend_raw_secret" },
    });
  });

  it.each(["access_denied", "invalid_grant"] as const)(
    "maps %s to an authentication exit error",
    async (status) => {
      const env = await tempEnv();
      const responses = [startResponse(0), { status }];
      globalThis.fetch = vi.fn(async () =>
        Response.json(responses.shift()),
      ) as unknown as typeof fetch;

      await expect(
        runCli(["login", "https://mail.example.com"], env, noWaitRuntime()),
      ).rejects.toMatchObject({
        exitCode: 3,
      });
    },
  );

  it("rejects an invalid protocol expiry before polling without exposing its value", async () => {
    const env = await tempEnv();
    let tokenRequests = 0;
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/token")) tokenRequests += 1;
      return Response.json(
        url.endsWith("/token") ? approvedResponse() : startResponse(0, "not-a-timestamp-secret"),
      );
    }) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runMain(["--json", "login", "https://mail.example.com"], env, {
        now: () => 0,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 1 });

    expect(tokenRequests).toBe(0);
    const diagnostic = error.mock.calls.flat().join("\n");
    expect(diagnostic).toContain('"code":"internal_error"');
    expect(diagnostic).toContain(
      "Device authorization response contained an invalid expiration timestamp.",
    );
    expect(diagnostic).not.toContain("not-a-timestamp-secret");
  });

  it("expires locally before the first poll without a token request", async () => {
    const env = await tempEnv();
    let tokenRequests = 0;
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/token")) tokenRequests += 1;
      return Response.json(
        url.endsWith("/token") ? approvedResponse() : startResponse(5, "1970-01-01T00:00:01.000Z"),
      );
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["login", "https://mail.example.com"], env, {
        now: () => 1000,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(tokenRequests).toBe(0);
  });

  it("expires during a bounded sleep without a post-expiry token request", async () => {
    const env = await tempEnv();
    let now = 0;
    let tokenRequests = 0;
    const sleeps: number[] = [];
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/token")) tokenRequests += 1;
      return Response.json(
        url.endsWith("/token") ? approvedResponse() : startResponse(5, "1970-01-01T00:00:01.500Z"),
      );
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["login", "https://mail.example.com"], env, {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
        },
      }),
    ).rejects.toMatchObject({ exitCode: 3 });

    expect(sleeps).toEqual([1500]);
    expect(tokenRequests).toBe(0);
  });

  it("accepts approval from a token request that began before local expiry", async () => {
    const env = await tempEnv();
    let now = 0;
    let tokenRequests = 0;
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/token")) {
        return Response.json(startResponse(0, "1970-01-01T00:00:01.500Z"));
      }
      tokenRequests += 1;
      now = 2000;
      return Response.json(approvedResponse());
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["login", "https://mail.example.com"], env, {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).resolves.toEqual({ exitCode: 0 });

    expect(tokenRequests).toBe(1);
  });

  it("does not print the raw approved key in human output", async () => {
    const env = await tempEnv();
    const responses = [startResponse(0), approvedResponse()];
    globalThis.fetch = vi.fn(async () =>
      Response.json(responses.shift()),
    ) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["login", "https://mail.example.com"], env, noWaitRuntime());

    const output = log.mock.calls.flat().join("\n");
    expect(output).not.toContain("nusend_raw_secret");
    expect(output).toContain("https://mail.example.com/cli/activate");
    expect(output).toContain("Code: ABCD-2345");
  });

  it("rejects path-carrying base URLs", async () => {
    const env = await tempEnv();

    await expect(runCli(["login", "https://mail.example.com/nusend"], env)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("must not include a path"),
    });
  });

  it.each([
    ["without trailing slash", "https://mail.example.com"],
    ["with trailing slash", "https://mail.example.com/"],
  ] as const)("accepts a root base URL %s", async (_label, url) => {
    const env = await tempEnv();
    const responses = [startResponse(0), approvedResponse()];
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      const requested = input instanceof Request ? input.url : String(input);
      expect(requested).toContain("https://mail.example.com/api/device-authorizations");
      return Response.json(responses.shift());
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["login", url], env, noWaitRuntime())).resolves.toEqual({
      exitCode: 0,
    });
    expect(fetchMock).toHaveBeenCalled();
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "nusend-cli-login-"));
  temporaryDirectories.push(directory);
  return { XDG_CONFIG_HOME: directory };
}

function startResponse(intervalSeconds: number, expiresAt = "2099-01-01T00:00:00.000Z") {
  return {
    deviceCode: "device",
    expiresAt,
    intervalSeconds,
    userCode: "ABCD-2345",
    verificationUri: "https://mail.example.com/cli/activate",
  };
}

function noWaitRuntime() {
  return {
    now: () => 0,
    sleep: async (_milliseconds: number) => undefined,
  };
}

function approvedResponse() {
  return {
    apiKey: {
      createdAt: "2026-07-09T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      id: "key_1",
      key: "nusend_raw_secret",
      lastUsedAt: null,
      name: "CLI",
      permissions: { contacts: ["read"] },
      preview: "nusend…cret",
      revokedAt: null,
    },
    status: "approved",
  };
}
