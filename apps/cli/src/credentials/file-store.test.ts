import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { credentialsPath } from "../config/paths.js";
import { FileCredentialStore } from "./file-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("FileCredentialStore", () => {
  it("writes, reads, deletes, and hardens credential permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nusend-cli-credentials-"));
    tempDirs.push(directory);
    const env = { XDG_CONFIG_HOME: directory };
    const store = new FileCredentialStore(env);

    await store.write("prod", {
      apiKey: "nusend_secret",
      apiKeyId: "key_1",
      preview: "nusend…cret",
    });
    await expect(store.read("prod")).resolves.toEqual({
      apiKey: "nusend_secret",
      apiKeyId: "key_1",
      preview: "nusend…cret",
    });

    if (process.platform !== "win32") {
      expect((await stat(credentialsPath(env))).mode & 0o777).toBe(0o600);
    }

    await store.delete("prod");
    await expect(store.read("prod")).resolves.toBeNull();
  });

  it("refuses broad credential directory permissions", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "nusend-cli-credentials-"));
    tempDirs.push(directory);
    const env = { XDG_CONFIG_HOME: directory };
    const store = new FileCredentialStore(env);

    await store.write("prod", { apiKey: "nusend_secret" });
    await chmod(join(directory, "nusend"), 0o755);

    await expect(store.read("prod")).rejects.toThrow(/Credential directory permissions/);
  });

  it("prefers NUSEND_API_KEY from the environment", async () => {
    const store = new FileCredentialStore({ NUSEND_API_KEY: "nusend_env" });

    await expect(store.read("any")).resolves.toEqual({ apiKey: "nusend_env" });
  });
});
