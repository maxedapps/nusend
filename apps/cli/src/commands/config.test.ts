import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLocalState } from "../config/local-state.js";
import { configDirectory, statePath } from "../config/paths.js";
import { runCli } from "../main.js";
import { runConfigCommand } from "./config.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
  vi.restoreAllMocks();
});

describe("config repair-permissions", () => {
  it.runIf(process.platform !== "win32")("repairs directory and file modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "nusend-cli-config-"));
    tempDirectories.push(root);
    const env = { XDG_CONFIG_HOME: root };
    await mkdir(configDirectory(env), { mode: 0o755, recursive: true });
    await writeFile(
      statePath(env),
      JSON.stringify({
        baseUrl: "https://mail.example.com",
        credential: { apiKey: "nusend_test" },
      }) + "\n",
      { mode: 0o644 },
    );
    await chmod(configDirectory(env), 0o755);
    await chmod(statePath(env), 0o644);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runCli(["config", "repair-permissions"], env)).resolves.toEqual({ exitCode: 0 });

    expect((await stat(configDirectory(env))).mode & 0o777).toBe(0o700);
    expect((await stat(statePath(env))).mode & 0o777).toBe(0o600);
    await expect(loadLocalState(env)).resolves.toMatchObject({
      credential: { apiKey: "nusend_test" },
    });
  });

  it.runIf(process.platform !== "win32")(
    "reports non-applicability on Windows without touching files",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "nusend-cli-config-win32-"));
      tempDirectories.push(root);
      const env = { XDG_CONFIG_HOME: root };
      await mkdir(configDirectory(env), { mode: 0o755, recursive: true });
      await writeFile(statePath(env), '{"profiles":{}}\n', { mode: 0o644 });
      await chmod(configDirectory(env), 0o755);
      await chmod(statePath(env), 0o644);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await runConfigCommand(
        {
          env,
          json: false,
          runtime: { now: Date.now, sleep: async () => undefined },
        },
        "win32",
      );

      expect(log).toHaveBeenCalledWith("Permission repair is not applicable on Windows.");
      expect((await stat(configDirectory(env))).mode & 0o777).toBe(0o755);
      expect((await stat(statePath(env))).mode & 0o777).toBe(0o644);
    },
  );
});
