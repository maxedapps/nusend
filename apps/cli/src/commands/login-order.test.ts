import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileCredentialStore } from "../credentials/file-store.js";
import { runCli } from "../main.js";

const events = vi.hoisted(() => [] as string[]);

vi.mock("../config/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/profiles.js")>();
  return {
    ...actual,
    saveConfig: vi.fn(async (...args: Parameters<typeof actual.saveConfig>) => {
      events.push("saveConfig");
      return actual.saveConfig(...args);
    }),
  };
});

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  events.splice(0);
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("login write ordering", () => {
  it("stores the credential strictly before writing config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nusend-cli-login-order-"));
    temporaryDirectories.push(directory);
    const env = { XDG_CONFIG_HOME: directory };
    const originalWrite = FileCredentialStore.prototype.write;
    vi.spyOn(FileCredentialStore.prototype, "write").mockImplementation(async function (
      this: FileCredentialStore,
      ...args
    ) {
      events.push("credentialWrite");
      return originalWrite.apply(this, args);
    });
    const responses = [
      {
        deviceCode: "device",
        expiresAt: "2099-01-01T00:00:00.000Z",
        intervalSeconds: 0,
        userCode: "ABCD-2345",
        verificationUri: "https://mail.example.com/cli/activate",
      },
      {
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
      },
    ];
    globalThis.fetch = vi.fn(async () =>
      Response.json(responses.shift()),
    ) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["login", "https://mail.example.com"], env)).resolves.toEqual({
      exitCode: 0,
    });

    expect(events).toEqual(["credentialWrite", "saveConfig"]);
  });
});
