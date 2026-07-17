import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadLocalState,
  normalizeBaseUrl,
  removeStoredCredential,
  repairLocalStatePermissions,
  writeLoginState,
} from "./local-state.ts";
import { configDirectory, statePath } from "./paths.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local state", () => {
  it("loads missing state as empty", async () => {
    await expect(loadLocalState(testEnv())).resolves.toEqual({});
  });

  it("writes first login atomically with private permissions", async () => {
    const env = testEnv();
    await writeLoginState(loginState("https://mail.example.com", "key-1"), env);

    await expect(loadLocalState(env)).resolves.toEqual(
      loginState("https://mail.example.com", "key-1"),
    );
    if (process.platform !== "win32") {
      expect((await stat(configDirectory(env))).mode & 0o777).toBe(0o700);
      expect((await stat(statePath(env))).mode & 0o777).toBe(0o600);
    }
    expect(await temporaryFiles(env)).toEqual([]);
  });

  it("relogin replaces the one service and credential", async () => {
    const env = testEnv();
    await writeLoginState(loginState("https://one.example.com", "key-1"), env);
    await writeLoginState(loginState("https://two.example.com", "key-2"), env);

    await expect(loadLocalState(env)).resolves.toEqual(
      loginState("https://two.example.com", "key-2"),
    );
  });

  it.each(["{bad json", JSON.stringify({ profiles: {} })])(
    "login replaces readable malformed state: %s",
    async (content) => {
      const env = testEnv();
      await writeExistingState(env, content);

      await writeLoginState(loginState("https://mail.example.com", "new-key"), env);

      await expect(loadLocalState(env)).resolves.toEqual(
        loginState("https://mail.example.com", "new-key"),
      );
    },
  );

  it("ordinary reads reject malformed JSON and schema", async () => {
    const malformedJson = testEnv();
    await writeExistingState(malformedJson, "{bad json");
    await expect(loadLocalState(malformedJson)).rejects.toThrow();

    const malformedSchema = testEnv();
    await writeExistingState(malformedSchema, JSON.stringify({ credential: { apiKey: 42 } }));
    await expect(loadLocalState(malformedSchema)).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "unreadable state fails closed without changing bytes",
    async () => {
      const env = testEnv();
      const bytes = `${JSON.stringify(loginState("https://old.example.com", "old-key"))}\n`;
      await writeExistingState(env, bytes);
      await chmod(statePath(env), 0o000);
      try {
        await expect(
          writeLoginState(loginState("https://new.example.com", "new-key"), env),
        ).rejects.toThrow();
      } finally {
        await chmod(statePath(env), 0o600);
      }
      expect(await readFile(statePath(env), "utf8")).toBe(bytes);
      expect(await temporaryFiles(env)).toEqual([]);
    },
  );

  it("path I/O failures propagate and never replace the path", async () => {
    const env = testEnv();
    await mkdir(statePath(env), { recursive: true });

    await expect(
      writeLoginState(loginState("https://mail.example.com", "new-key"), env),
    ).rejects.toThrow();
    expect((await stat(statePath(env))).isDirectory()).toBe(true);
  });

  it("a pre-rename failure preserves old bytes and cleans the temporary file", async () => {
    const env = testEnv();
    const bytes = `${JSON.stringify(loginState("https://old.example.com", "old-key"))}\n`;
    await writeExistingState(env, bytes);

    await expect(
      writeLoginState(loginState("https://new.example.com", "new-key"), env, {
        beforeRename: async () => {
          throw new Error("before-rename sentinel");
        },
      }),
    ).rejects.toThrow("before-rename sentinel");

    expect(await readFile(statePath(env), "utf8")).toBe(bytes);
    expect(await temporaryFiles(env)).toEqual([]);
  });

  it("logout removal keeps the configured base URL", async () => {
    const env = testEnv();
    await writeLoginState(loginState("https://mail.example.com", "key-1"), env);

    await expect(removeStoredCredential(env)).resolves.toBe(true);
    await expect(loadLocalState(env)).resolves.toEqual({ baseUrl: "https://mail.example.com" });
    await expect(removeStoredCredential(env)).resolves.toBe(false);
  });

  it.runIf(process.platform !== "win32")("repairs directory and file permissions", async () => {
    const env = testEnv();
    await writeExistingState(env, "{}\n");
    await chmod(configDirectory(env), 0o755);
    await chmod(statePath(env), 0o644);

    await expect(repairLocalStatePermissions(env)).resolves.toBe(true);
    expect((await stat(configDirectory(env))).mode & 0o777).toBe(0o700);
    expect((await stat(statePath(env))).mode & 0o777).toBe(0o600);
  });

  it("normalizes domain-root HTTP URLs", () => {
    expect(normalizeBaseUrl("https://mail.example.com///?ignored=yes#ignored")).toBe(
      "https://mail.example.com",
    );
    expect(() => normalizeBaseUrl("ftp://mail.example.com")).toThrow(/http/);
    expect(() => normalizeBaseUrl("https://mail.example.com/subpath")).toThrow(/must not include/);
  });
});

function loginState(baseUrl: string, apiKey: string) {
  return {
    baseUrl,
    credential: { apiKey, apiKeyId: `${apiKey}-id`, preview: `${apiKey}-preview` },
  };
}

function testEnv(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "nusend-cli-state-"));
  temporaryDirectories.push(directory);
  return { XDG_CONFIG_HOME: directory };
}

async function writeExistingState(env: NodeJS.ProcessEnv, content: string): Promise<void> {
  await mkdir(configDirectory(env), { mode: 0o700, recursive: true });
  await chmod(configDirectory(env), 0o700);
  await writeFile(statePath(env), content, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(statePath(env), 0o600);
}

async function temporaryFiles(env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    return (await readdir(configDirectory(env))).filter((name) => name.includes(".tmp-"));
  } catch {
    return [];
  }
}
