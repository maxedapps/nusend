import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { configPath } from "./paths.js";
import { loadConfig, normalizeBaseUrl, updateConfig } from "./profiles.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI profiles", () => {
  it("round-trips config files", async () => {
    const env = await tempEnv();
    const config = {
      activeProfile: "production",
      profiles: { production: { baseUrl: "https://mail.example.com" } },
    };

    await updateConfig(() => config, env);

    await expect(loadConfig(env)).resolves.toEqual(config);
  });

  it("reports malformed config clearly", async () => {
    const env = await tempEnv();
    await mkdir(dirname(configPath(env)), { recursive: true });
    await writeFile(configPath(env), '{"profiles":"wrong"}\n');

    await expect(loadConfig(env)).rejects.toThrow(/profiles|Expected|Record/i);
  });

  it("normalizes root base URLs and rejects path-carrying ones", () => {
    expect(normalizeBaseUrl("https://mail.example.com")).toBe("https://mail.example.com");
    expect(normalizeBaseUrl("https://mail.example.com/")).toBe("https://mail.example.com");
    expect(normalizeBaseUrl("https://mail.example.com//")).toBe("https://mail.example.com");
    expect(normalizeBaseUrl("https://mail.example.com/?q=1#top")).toBe("https://mail.example.com");

    expect(() => normalizeBaseUrl("https://mail.example.com/nusend")).toThrow(
      /must not include a path \(got \/nusend\)/,
    );
    expect(() => normalizeBaseUrl("ftp://mail.example.com")).toThrow(/must be http\(s\)/);
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "nusend-cli-profiles-"));
  temporaryDirectories.push(directory);
  return { XDG_CONFIG_HOME: directory };
}
