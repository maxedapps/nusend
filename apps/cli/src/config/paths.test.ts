import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { configDirectory, statePath } from "./paths.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("CLI path resolution", () => {
  it("uses XDG_CONFIG_HOME when set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nusend-cli-paths-"));
    tempDirs.push(directory);
    const env = { XDG_CONFIG_HOME: directory };

    expect(configDirectory(env)).toBe(join(directory, "nusend"));
    expect(statePath(env)).toBe(join(directory, "nusend", "state.json"));
  });

  it("uses the Unix HOME fallback without XDG_CONFIG_HOME", () => {
    expect(configDirectory({ HOME: "/home/test" }, "linux")).toBe(
      join("/home/test", ".config", "nusend"),
    );
    expect(configDirectory({ HOME: "/Users/test" }, "darwin")).toBe(
      join("/Users/test", ".config", "nusend"),
    );
  });

  it("uses APPDATA then LOCALAPPDATA on Windows", () => {
    expect(configDirectory({ APPDATA: "C:\\Users\\test\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\test\\Roaming", "Nusend"),
    );
    expect(configDirectory({ LOCALAPPDATA: "C:\\Users\\test\\Local" }, "win32")).toBe(
      join("C:\\Users\\test\\Local", "Nusend"),
    );
  });
});
