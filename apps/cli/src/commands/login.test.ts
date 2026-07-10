import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configDirectory, configPath } from "../config/paths.js";
import { loadConfig } from "../config/profiles.js";
import { FileCredentialStore } from "../credentials/file-store.js";
import { runCli } from "../main.js";

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
  it("polls pending and slow_down, stores first, and preserves active profile", async () => {
    const env = await tempEnv();
    await mkdir(configDirectory(env), { mode: 0o700, recursive: true });
    await writeFile(
      configPath(env),
      `${JSON.stringify({ activeProfile: "existing", profiles: { existing: { baseUrl: "https://old.example.com" } } })}\n`,
      { mode: 0o600 },
    );
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
    const timeout = vi.spyOn(globalThis, "setTimeout");

    await expect(
      runCli(["--json", "--profile", "new", "login", "https://mail.example.com"], env),
    ).resolves.toEqual({ exitCode: 0 });

    expect(timeout.mock.calls.slice(0, 3).map((call) => call[1])).toEqual([1, 2, 3]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      apiKey: { id: "key_1" },
      profile: "new",
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
    await expect(new FileCredentialStore(env).read("new")).resolves.toMatchObject({
      apiKey: "nusend_raw_secret",
    });
    await expect(loadConfig(env)).resolves.toMatchObject({
      activeProfile: "existing",
      profiles: { new: { baseUrl: "https://mail.example.com" } },
    });
  });

  it("maps denied and invalid_grant to authentication exit errors", async () => {
    await runSequential(["access_denied", "invalid_grant"] as const, async (status) => {
      const env = await tempEnv();
      const responses = [startResponse(0), { status }];
      globalThis.fetch = vi.fn(async () =>
        Response.json(responses.shift()),
      ) as unknown as typeof fetch;
      await expect(runCli(["login", "https://mail.example.com"], env)).rejects.toMatchObject({
        exitCode: 3,
      });
    });
  });

  it("does not print the raw approved key in human output", async () => {
    const env = await tempEnv();
    const responses = [startResponse(0), approvedResponse()];
    globalThis.fetch = vi.fn(async () =>
      Response.json(responses.shift()),
    ) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["login", "https://mail.example.com"], env);

    const output = log.mock.calls.flat().join("\n");
    expect(output).not.toContain("nusend_raw_secret");
    expect(output).toContain("https://mail.example.com/cli/activate");
    expect(output).toContain("Code: ABCD-2345");
  });

  it("rejects path-carrying base URLs and accepts root URLs", async () => {
    const env = await tempEnv();

    await expect(runCli(["login", "https://mail.example.com/nusend"], env)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("must not include a path"),
    });

    await runSequential(["https://mail.example.com", "https://mail.example.com/"], async (url) => {
      const responses = [startResponse(0), approvedResponse()];
      const fetchMock = vi.fn(async (input: Request | URL | string) => {
        const requested = input instanceof Request ? input.url : String(input);
        expect(requested).toContain("https://mail.example.com/api/device-authorizations");
        return Response.json(responses.shift());
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await expect(runCli(["login", url], env)).resolves.toEqual({ exitCode: 0 });
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});

function runSequential<T>(values: readonly T[], task: (value: T) => Promise<void>): Promise<void> {
  const [head, ...tail] = values;
  return head === undefined ? Promise.resolve() : task(head).then(() => runSequential(tail, task));
}

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "nusend-cli-login-"));
  temporaryDirectories.push(directory);
  return { XDG_CONFIG_HOME: directory };
}

function startResponse(intervalSeconds: number) {
  return {
    deviceCode: "device",
    expiresAt: "2099-01-01T00:00:00.000Z",
    intervalSeconds,
    userCode: "ABCD-2345",
    verificationUri: "https://mail.example.com/cli/activate",
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
