import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLocalState, writeLoginState } from "../config/local-state.js";
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

describe("logout command", () => {
  it("removes only the stored credential without network or timeout parsing", async () => {
    const env = await storedEnv();
    env.NUSEND_HTTP_TIMEOUT_MS = "invalid";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout"], env)).resolves.toEqual({ exitCode: 0 });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadLocalState(env)).resolves.toEqual({ baseUrl: "https://mail.example.com" });
  });

  it("revokes remotely before removing the stored credential", async () => {
    const env = await storedEnv();
    globalThis.fetch = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      expect(request.url).toBe("https://mail.example.com/api/api-keys/key-id");
      expect(request.method).toBe("DELETE");
      expect(request.headers.get("x-api-key")).toBe("stored-key");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });
    await expect(loadLocalState(env)).resolves.toEqual({ baseUrl: "https://mail.example.com" });
  });

  it("removes the local credential when remote revoke fails", async () => {
    const env = await storedEnv();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network sentinel");
    }) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });

    expect(error.mock.calls.flat().join("\n")).toContain("remote key revocation failed");
    await expect(loadLocalState(env)).resolves.toEqual({ baseUrl: "https://mail.example.com" });
  });

  it("environment auth preserves stored state and bypasses corrupt disk", async () => {
    const env = await tempEnv();
    await mkdir(configDirectory(env), { mode: 0o700, recursive: true });
    await writeFile(statePath(env), "corrupt-state\n", { mode: 0o600 });
    env.NUSEND_API_KEY = "environment-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout"], env)).resolves.toEqual({ exitCode: 0 });
    expect(await readFile(statePath(env), "utf8")).toBe("corrupt-state\n");
  });

  it("keeps logout revoke timeout validation asymmetric", async () => {
    const env = await tempEnv();
    env.NUSEND_API_KEY = "environment-key";
    env.NUSEND_HTTP_TIMEOUT_MS = "invalid";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runMain(["logout"], env)).resolves.toEqual({ exitCode: 0 });
    await expect(runMain(["logout", "--revoke"], env)).resolves.toEqual({ exitCode: 2 });
    expect(error.mock.calls.flat().join("\n")).toContain("NUSEND_HTTP_TIMEOUT_MS");
  });

  it("reports an empty state without writing", async () => {
    const env = await tempEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout"], env)).resolves.toEqual({ exitCode: 0 });

    expect(log).toHaveBeenCalledWith("No credential stored.");
    await expect(loadLocalState(env)).resolves.toEqual({});
  });
});

async function storedEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await tempEnv();
  await writeLoginState(
    {
      baseUrl: "https://mail.example.com",
      credential: { apiKey: "stored-key", apiKeyId: "key-id", preview: "stored…key" },
    },
    env,
  );
  return env;
}

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "nusend-cli-logout-"));
  temporaryDirectories.push(directory);
  return { XDG_CONFIG_HOME: directory };
}
