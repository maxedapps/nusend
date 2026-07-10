import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { credentialsPath } from "../config/paths.js";
import { saveConfig } from "../config/profiles.js";
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

describe("logout command", () => {
  it("is idempotent without a credential", async () => {
    const env = await tempEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout"], env)).resolves.toEqual({ exitCode: 0 });
    expect(log).toHaveBeenCalledWith("No credential stored for profile default.");
  });

  it("does not claim an environment credential was removed", async () => {
    const env = { ...(await tempEnv()), NUSEND_API_KEY: "nusend_environment" };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout"], env)).resolves.toEqual({ exitCode: 0 });

    expect(log).toHaveBeenCalledWith(
      "NUSEND_API_KEY remains active for profile default; unset it to log out.",
    );
  });

  it("keeps the stored credential when logging out with an environment credential", async () => {
    const baseEnv = await tempEnv();
    const store = new FileCredentialStore(baseEnv);
    await store.write("default", { apiKey: "nusend_stored", apiKeyId: "key_1" });
    const env = { ...baseEnv, NUSEND_API_KEY: "nusend_environment" };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout"], env)).resolves.toEqual({ exitCode: 0 });

    expect(log).toHaveBeenCalledWith("Stored credential for profile default was kept.");
    await expect(new FileCredentialStore(baseEnv).read("default")).resolves.toMatchObject({
      apiKey: "nusend_stored",
    });

    log.mockClear();
    await expect(runCli(["--json", "logout"], env)).resolves.toEqual({ exitCode: 0 });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      loggedOut: false,
      profile: "default",
      reason: "environment_credential",
      storedCredentialKept: true,
    });
  });

  it("emits the env-credential revoke warning as JSON in --json mode", async () => {
    const env = { ...(await tempEnv()), NUSEND_API_KEY: "nusend_environment" };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["--json", "logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });

    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      warning: { code: "revoke_unsupported" },
    });
  });

  it("creates no credentials file when logging out without one", async () => {
    const baseEnv = await tempEnv();
    const env = { ...baseEnv, NUSEND_API_KEY: "nusend_environment" };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["--json", "logout"], env)).resolves.toEqual({ exitCode: 0 });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      loggedOut: false,
      profile: "default",
      reason: "environment_credential",
      storedCredentialKept: false,
    });
    await expect(stat(credentialsPath(baseEnv))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unknown logout options without touching the credential", async () => {
    const env = await tempEnv();
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_test", apiKeyId: "key_1" });

    await expect(runCli(["logout", "--version"], env)).rejects.toMatchObject({
      exitCode: 2,
      message: "Unknown logout option: --version",
    });

    await expect(store.read("default")).resolves.toMatchObject({ apiKey: "nusend_test" });
  });

  it("deletes a stored credential", async () => {
    const env = await tempEnv();
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_test", apiKeyId: "key_1" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["logout"], env);

    await expect(store.read("default")).resolves.toBeNull();
  });

  it("revokes remotely before deleting locally", async () => {
    const env = await tempEnv();
    await saveConfig(
      { activeProfile: "default", profiles: { default: { baseUrl: "https://mail.example.com" } } },
      env,
    );
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_test", apiKeyId: "key_1" });
    const fetchMock = vi.fn(
      async (_input: Request | URL | string, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input instanceof URL ? input.toString() : String(input)).toBe(
      "https://mail.example.com/api/api-keys/key_1",
    );
    expect(init?.method).toBe("DELETE");
    await expect(store.read("default")).resolves.toBeNull();
  });

  it("deletes locally when revoke setup lacks a base URL", async () => {
    const env = await tempEnv();
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_test", apiKeyId: "key_1" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });

    await expect(store.read("default")).resolves.toBeNull();
    expect(error.mock.calls.flat().join("\n")).toContain("local credential was removed");
  });

  it("deletes locally and warns when remote revocation fails", async () => {
    const env = await tempEnv();
    await saveConfig(
      { activeProfile: "default", profiles: { default: { baseUrl: "https://mail.example.com" } } },
      env,
    );
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_test", apiKeyId: "key_1" });
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        { error: { code: "internal_error", message: "Remote failure." } },
        { status: 500 },
      ),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });

    await expect(store.read("default")).resolves.toBeNull();
    expect(error.mock.calls.flat().join("\n")).toContain("local credential was removed");
  });

  it("emits a JSON warning envelope when revocation fails in --json mode", async () => {
    const env = await tempEnv();
    await saveConfig(
      { activeProfile: "default", profiles: { default: { baseUrl: "https://mail.example.com" } } },
      env,
    );
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_test", apiKeyId: "key_1" });
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        { error: { code: "internal_error", message: "Remote failure." } },
        { status: 500 },
      ),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["--json", "logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });

    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      warning: { code: "revoke_failed", message: expect.stringContaining("Remote failure.") },
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      loggedOut: true,
      profile: "default",
    });
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "nusend-cli-logout-"));
  temporaryDirectories.push(directory);
  return { XDG_CONFIG_HOME: directory };
}
