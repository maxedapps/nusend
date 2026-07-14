import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { updateCredentials, updateLoginState } from "../config/local-state.js";
import { credentialsPath } from "../config/paths.js";
import { updateConfig } from "../config/profiles.js";
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
      message: "Unknown option: --version",
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

  it("preserves an unrelated credential written while logout waits for the shared lock", async () => {
    const env = await tempEnv();
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_default", apiKeyId: "key_1" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let signalAcquired!: () => void;
    let releaseWriter!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writer = updateCredentials(
      (current) => ({
        credentials: {
          ...(current.credentials ?? {}),
          unrelated: { apiKey: "nusend_unrelated" },
        },
      }),
      env,
      {
        afterLockAcquired: async () => {
          signalAcquired();
          await release;
        },
      },
    );
    await acquired;
    let signalSnapshotContended!: () => void;
    const snapshotContended = new Promise<void>((resolve) => {
      signalSnapshotContended = resolve;
    });
    const logout = runCli(["logout"], env, {
      afterLocalStateContention: async () => signalSnapshotContended(),
      now: Date.now,
      sleep: async () => undefined,
    });
    await snapshotContended;
    releaseWriter();

    await Promise.all([writer, logout]);

    await expect(store.read("default")).resolves.toBeNull();
    await expect(store.read("unrelated")).resolves.toMatchObject({
      apiKey: "nusend_unrelated",
    });
  });

  it("revokes remotely before deleting locally", async () => {
    const env = await tempEnv();
    await updateConfig(
      () => ({
        activeProfile: "default",
        profiles: { default: { baseUrl: "https://mail.example.com" } },
      }),
      env,
    );
    const store = new FileCredentialStore(env);
    await store.write("default", { apiKey: "nusend_test", apiKeyId: "key_1" });
    const events: string[] = [];
    const fetchMock = vi.fn(async (_input: Request | URL | string, _init?: RequestInit) => {
      events.push("remote-revoke");
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const originalDelete = FileCredentialStore.prototype.delete;
    vi.spyOn(FileCredentialStore.prototype, "delete").mockImplementation(
      async function (this: FileCredentialStore, profile) {
        events.push("local-delete");
        return originalDelete.call(this, profile);
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["logout", "--revoke"], env)).resolves.toEqual({ exitCode: 0 });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input instanceof URL ? input.toString() : String(input)).toBe(
      "https://mail.example.com/api/api-keys/key_1",
    );
    expect(init?.method).toBe("DELETE");
    expect(events).toEqual(["remote-revoke", "local-delete"]);
    await expect(store.read("default")).resolves.toBeNull();
  });

  it("waits for a coherent snapshot before revoke network work", async () => {
    const env = await tempEnv();
    let releaseLogin!: () => void;
    const loginGate = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    let signalCredentialRenamed!: () => void;
    const credentialRenamed = new Promise<void>((resolve) => {
      signalCredentialRenamed = resolve;
    });
    let signalSnapshotContended!: () => void;
    const snapshotContended = new Promise<void>((resolve) => {
      signalSnapshotContended = resolve;
    });
    let mutation: Promise<void> | undefined;
    try {
      await updateLoginState(
        {
          baseUrl: "https://old.example.com",
          credential: { apiKey: "nusend_old", apiKeyId: "old_key" },
          profile: "default",
        },
        env,
      );
      mutation = updateLoginState(
        {
          baseUrl: "https://new.example.com",
          credential: { apiKey: "nusend_new", apiKeyId: "new_key" },
          profile: "default",
        },
        env,
        {
          afterRename: async (destination) => {
            if (destination !== credentialsPath(env)) return;
            signalCredentialRenamed();
            await loginGate;
          },
        },
      );
      await credentialRenamed;
      const fetchMock = vi.fn(
        async (_input: Request | URL | string, _init?: RequestInit) =>
          new Response(null, { status: 204 }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const command = runCli(["logout", "--revoke"], env, {
        afterLocalStateContention: async () => signalSnapshotContended(),
        now: Date.now,
        sleep: async () => undefined,
      });

      await snapshotContended;
      const requestsBeforeLoginRelease = fetchMock.mock.calls.length;
      releaseLogin();
      await mutation;
      await expect(command).resolves.toEqual({ exitCode: 0 });

      expect(requestsBeforeLoginRelease).toBe(0);
      const [input, init] = fetchMock.mock.calls[0] ?? [];
      expect(input instanceof URL ? input.toString() : String(input)).toBe(
        "https://new.example.com/api/api-keys/new_key",
      );
      expect(new Headers(init?.headers).get("x-api-key")).toBe("nusend_new");
      await expect(new FileCredentialStore(env).read("default")).resolves.toBeNull();
    } finally {
      releaseLogin();
      await mutation?.catch(() => undefined);
    }
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
    await updateConfig(
      () => ({
        activeProfile: "default",
        profiles: { default: { baseUrl: "https://mail.example.com" } },
      }),
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
    await updateConfig(
      () => ({
        activeProfile: "default",
        profiles: { default: { baseUrl: "https://mail.example.com" } },
      }),
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
