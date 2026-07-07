import { isAbsolute } from "node:path";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { sendingConfig, serviceConfig, type SendingConfig, type ServiceConfig } from "./config.ts";

function load(fixture: Record<string, string>): Promise<ServiceConfig> {
  return Effect.runPromise(
    serviceConfig.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(fixture)),
    ),
  );
}

function loadSending(fixture: Record<string, string>): Promise<SendingConfig> {
  return Effect.runPromise(
    sendingConfig.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(fixture)),
    ),
  );
}

const validAuthFixture = {
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000/",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  NUSEND_AUTH_TRUSTED_ORIGINS: "http://localhost:3000, https://admin.example.com/path",
};

describe("serviceConfig", () => {
  it("loads defaults", async () => {
    const config = await load({});

    expect(Option.isNone(config.auth)).toBe(true);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.databasePath).toMatch(/\.data\/nusend\.sqlite$/);
    expect(isAbsolute(config.databasePath)).toBe(true);
  });

  it("treats empty and whitespace-only values as missing", async () => {
    const config = await load({
      BETTER_AUTH_SECRET: "   ",
      BETTER_AUTH_URL: "",
      NUSEND_DB_PATH: "  ",
      NUSEND_HOST: "",
      NUSEND_PORT: "   ",
    });

    expect(Option.isNone(config.auth)).toBe(true);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.databasePath).toMatch(/\.data\/nusend\.sqlite$/);
  });

  it("resolves relative database paths from the repo root", async () => {
    const config = await load({ NUSEND_DB_PATH: ".data/custom.sqlite" });

    expect(config.databasePath).toMatch(/\.data\/custom\.sqlite$/);
    expect(isAbsolute(config.databasePath)).toBe(true);
  });

  it("keeps memory databases unchanged", async () => {
    const config = await load({ NUSEND_DB_PATH: ":memory:" });

    expect(config.databasePath).toBe(":memory:");
  });

  it("falls back to PORT only when NUSEND_PORT is absent", async () => {
    const config = await load({ NUSEND_PORT: "  ", PORT: "4100" });

    expect(config.port).toBe(4100);
  });

  it("rejects invalid ports", async () => {
    await expect(load({ NUSEND_PORT: "70000" })).rejects.toThrow(/NUSEND_PORT/);
    await expect(load({ NUSEND_PORT: "abc" })).rejects.toThrow(/NUSEND_PORT/);
    await expect(load({ NUSEND_PORT: "3.5" })).rejects.toThrow(/NUSEND_PORT/);
  });

  it("does not fall through to PORT when NUSEND_PORT is invalid", async () => {
    await expect(load({ NUSEND_PORT: "abc", PORT: "4100" })).rejects.toThrow(/NUSEND_PORT/);
  });

  it("loads auth config", async () => {
    const config = await load(validAuthFixture);
    const auth = Option.getOrThrow(config.auth);

    expect(auth.baseUrl).toBe("http://localhost:3000");
    expect(auth.googleClientId).toBe("google-client-id");
    expect(Redacted.value(auth.googleClientSecret)).toBe("google-client-secret");
    expect(Redacted.value(auth.secret)).toBe("x".repeat(32));
    expect(auth.trustedOrigins).toEqual(["http://localhost:3000", "https://admin.example.com"]);
  });

  it("redacts secrets when rendered", async () => {
    const config = await load(validAuthFixture);
    const auth = Option.getOrThrow(config.auth);

    expect(String(auth.secret)).not.toContain("x".repeat(32));
    expect(String(auth.googleClientSecret)).not.toContain("google-client-secret");
  });

  it("falls back trusted origins to the base URL origin", async () => {
    const config = await load({
      ...validAuthFixture,
      NUSEND_AUTH_TRUSTED_ORIGINS: " , ",
    });

    expect(Option.getOrThrow(config.auth).trustedOrigins).toEqual(["http://localhost:3000"]);

    const withoutVariable = await load({
      BETTER_AUTH_SECRET: validAuthFixture.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: validAuthFixture.BETTER_AUTH_URL,
      GOOGLE_CLIENT_ID: validAuthFixture.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: validAuthFixture.GOOGLE_CLIENT_SECRET,
    });

    expect(Option.getOrThrow(withoutVariable.auth).trustedOrigins).toEqual([
      "http://localhost:3000",
    ]);
  });

  it("rejects invalid trusted origins", async () => {
    await expect(
      load({ ...validAuthFixture, NUSEND_AUTH_TRUSTED_ORIGINS: "not-a-url" }),
    ).rejects.toThrow(/NUSEND_AUTH_TRUSTED_ORIGINS/);
  });

  it("rejects incomplete auth config", async () => {
    await expect(load({ BETTER_AUTH_SECRET: "x".repeat(32) })).rejects.toThrow(/BETTER_AUTH_URL/);
  });

  it("rejects auth config where only the optional variable is set", async () => {
    await expect(load({ NUSEND_AUTH_TRUSTED_ORIGINS: "http://localhost:3000" })).rejects.toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("rejects short secrets", async () => {
    await expect(load({ ...validAuthFixture, BETTER_AUTH_SECRET: "short" })).rejects.toThrow(
      /at least 32 characters/,
    );
  });

  it("rejects non-http(s) base URLs", async () => {
    await expect(
      load({ ...validAuthFixture, BETTER_AUTH_URL: "ftp://example.com" }),
    ).rejects.toThrow(/absolute http\(s\) URL/);
  });

  it("requires HTTPS trusted origins in production", async () => {
    await expect(
      load({
        ...validAuthFixture,
        BETTER_AUTH_URL: "https://example.com",
        NODE_ENV: "production",
        NUSEND_AUTH_TRUSTED_ORIGINS: "https://admin.example.com, http://localhost:3000",
      }),
    ).rejects.toThrow(/NUSEND_AUTH_TRUSTED_ORIGINS must use HTTPS/);
  });

  it("requires HTTPS auth URLs in production", async () => {
    await expect(
      load({
        BETTER_AUTH_SECRET: "x".repeat(32),
        BETTER_AUTH_URL: "http://example.com",
        GOOGLE_CLIENT_ID: "google-client-id",
        GOOGLE_CLIENT_SECRET: "google-client-secret",
        NODE_ENV: "production",
      }),
    ).rejects.toThrow(/HTTPS/);
  });
});

describe("sendingConfig", () => {
  it("loads required sender settings and optional configuration sets", async () => {
    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SES_FROM_EMAIL: " sender@example.com ",
        NUSEND_SES_MARKETING_CONFIGURATION_SET: "marketing-set",
        NUSEND_SES_REQUEST_TIMEOUT_MS: "12000",
        NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "transactional-set",
      }),
    ).resolves.toEqual({
      fromEmail: "sender@example.com",
      marketingConfigurationSet: "marketing-set",
      region: "us-east-1",
      requestTimeoutMs: 12000,
      transactionalConfigurationSet: "transactional-set",
      workerBatchSize: 1,
      workerLeaseSeconds: 300,
    });
  });

  it("defaults optional sending settings", async () => {
    await expect(
      loadSending({ AWS_REGION: "us-east-1", NUSEND_SES_FROM_EMAIL: "sender@example.com" }),
    ).resolves.toEqual({
      fromEmail: "sender@example.com",
      marketingConfigurationSet: null,
      region: "us-east-1",
      requestTimeoutMs: 30000,
      transactionalConfigurationSet: null,
      workerBatchSize: 1,
      workerLeaseSeconds: 300,
    });
  });

  it("loads custom valid worker lease and batch size", async () => {
    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SEND_WORKER_BATCH_SIZE: "5",
        NUSEND_SEND_WORKER_LEASE_SECONDS: "200",
        NUSEND_SES_FROM_EMAIL: "sender@example.com",
        NUSEND_SES_REQUEST_TIMEOUT_MS: "30000",
      }),
    ).resolves.toMatchObject({
      requestTimeoutMs: 30000,
      workerBatchSize: 5,
      workerLeaseSeconds: 200,
    });
  });

  it("requires sender email and AWS region", async () => {
    await expect(loadSending({ AWS_REGION: "us-east-1" })).rejects.toThrow(/NUSEND_SES_FROM_EMAIL/);
    await expect(loadSending({ NUSEND_SES_FROM_EMAIL: "sender@example.com" })).rejects.toThrow(
      /AWS_REGION/,
    );
  });

  it("rejects invalid request timeouts", async () => {
    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SES_FROM_EMAIL: "sender@example.com",
        NUSEND_SES_REQUEST_TIMEOUT_MS: "0",
      }),
    ).rejects.toThrow(/NUSEND_SES_REQUEST_TIMEOUT_MS/);
  });

  it("rejects invalid worker lease and batch size", async () => {
    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SEND_WORKER_LEASE_SECONDS: "0",
        NUSEND_SES_FROM_EMAIL: "sender@example.com",
      }),
    ).rejects.toThrow(/NUSEND_SEND_WORKER_LEASE_SECONDS/);

    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SEND_WORKER_BATCH_SIZE: "0",
        NUSEND_SES_FROM_EMAIL: "sender@example.com",
      }),
    ).rejects.toThrow(/NUSEND_SEND_WORKER_BATCH_SIZE/);

    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SEND_WORKER_BATCH_SIZE: "51",
        NUSEND_SES_FROM_EMAIL: "sender@example.com",
      }),
    ).rejects.toThrow(/NUSEND_SEND_WORKER_BATCH_SIZE/);
  });

  it("rejects timeout settings that are too close to the worker lease", async () => {
    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SEND_WORKER_LEASE_SECONDS: "40",
        NUSEND_SES_FROM_EMAIL: "sender@example.com",
        NUSEND_SES_REQUEST_TIMEOUT_MS: "30000",
      }),
    ).rejects.toThrow(/NUSEND_SEND_WORKER_LEASE_SECONDS/);
  });

  it("rejects batch-adjusted timeout settings that are too close to the worker lease", async () => {
    await expect(
      loadSending({
        AWS_REGION: "us-east-1",
        NUSEND_SEND_WORKER_BATCH_SIZE: "10",
        NUSEND_SEND_WORKER_LEASE_SECONDS: "300",
        NUSEND_SES_FROM_EMAIL: "sender@example.com",
        NUSEND_SES_REQUEST_TIMEOUT_MS: "30000",
      }),
    ).rejects.toThrow(/NUSEND_SEND_WORKER_LEASE_SECONDS/);
  });
});
