import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { db, seedApiKey } from "../../test/helpers.ts";
import { findApiKeyIdByToken, hashApiKey } from "./api-keys.ts";

describe("hashApiKey", () => {
  it("produces a stable hex-encoded SHA-256 hash", async () => {
    const hash = await hashApiKey("nusend_example");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashApiKey("nusend_example")).toBe(hash);
    expect(await hashApiKey("nusend_other")).not.toBe(hash);
  });
});

describe("findApiKeyIdByToken", () => {
  it("resolves active keys and rejects unknown, malformed, and revoked keys", async () => {
    const activeKey = await seedApiKey({ id: "key_active" });
    const revokedKey = await seedApiKey({
      id: "key_revoked",
      revokedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(await findApiKeyIdByToken(db, activeKey)).toBe("key_active");
    expect(await findApiKeyIdByToken(db, revokedKey)).toBeNull();
    expect(await findApiKeyIdByToken(db, "nusend_unknown")).toBeNull();
    expect(await findApiKeyIdByToken(db, "not-a-nusend-key")).toBeNull();
  });
});

describe("API auth middleware", () => {
  it("rejects /api requests without a key", async () => {
    const response = await exports.default.fetch(
      new Request("https://nusend.test/api/mailings/some-id"),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "A valid API key is required. Send 'Authorization: Bearer nusend_...'.",
      },
    });
  });

  it("rejects /api requests with an invalid or revoked key", async () => {
    const revokedKey = await seedApiKey({ revokedAt: "2026-07-01T00:00:00.000Z" });

    for (const token of ["nusend_wrong", revokedKey]) {
      const response = await exports.default.fetch(
        new Request("https://nusend.test/api/mailings/some-id", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("accepts a valid key with a case-insensitive scheme", async () => {
    const key = await seedApiKey();

    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const response = await exports.default.fetch(
        new Request("https://nusend.test/api/mailings/missing-mailing", {
          headers: { authorization: `${scheme} ${key}` },
        }),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "Mailing not found." },
      });
    }
  });
});
