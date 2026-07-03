import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig({});

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.databasePath).toMatch(/\.data\/nusend\.sqlite$/);
    expect(isAbsolute(config.databasePath)).toBe(true);
  });

  it("resolves relative database paths from the repo root", () => {
    const config = loadConfig({ NUSEND_DB_PATH: ".data/custom.sqlite" });

    expect(config.databasePath).toMatch(/\.data\/custom\.sqlite$/);
    expect(isAbsolute(config.databasePath)).toBe(true);
  });

  it("keeps memory databases unchanged", () => {
    const config = loadConfig({ NUSEND_DB_PATH: ":memory:" });

    expect(config.databasePath).toBe(":memory:");
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ NUSEND_PORT: "70000" })).toThrow(/NUSEND_PORT/);
  });
});
