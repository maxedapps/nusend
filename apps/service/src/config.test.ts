import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig({});

    expect(config.auth).toBeNull();
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

  it("loads auth config", () => {
    const config = loadConfig({
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000/",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      NUSEND_AUTH_TRUSTED_ORIGINS: "http://localhost:3000, https://admin.example.com/path",
    });

    expect(config.auth).toEqual({
      baseUrl: "http://localhost:3000",
      googleClientId: "google-client-id",
      googleClientSecret: "google-client-secret",
      secret: "x".repeat(32),
      trustedOrigins: ["http://localhost:3000", "https://admin.example.com"],
    });
  });

  it("rejects incomplete auth config", () => {
    expect(() => loadConfig({ BETTER_AUTH_SECRET: "x".repeat(32) })).toThrow(/BETTER_AUTH_URL/);
  });

  it("requires HTTPS auth URLs in production", () => {
    expect(() =>
      loadConfig({
        BETTER_AUTH_SECRET: "x".repeat(32),
        BETTER_AUTH_URL: "http://example.com",
        GOOGLE_CLIENT_ID: "google-client-id",
        GOOGLE_CLIENT_SECRET: "google-client-secret",
        NODE_ENV: "production",
      }),
    ).toThrow(/HTTPS/);
  });
});
