import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("createAuth", () => {
  it("creates and verifies a user-owned API key with the mapped schema", () => {
    const result = runBunScenario(
      `
      import { createAuth } from ${JSON.stringify(`${serviceRoot}src/auth/auth.ts`)};
      import { createMigratedBunDatabase, seedUser } from ${JSON.stringify(`${serviceRoot}src/testing/bun-fixtures.ts`)};

      const db = createMigratedBunDatabase();
      const bootstrap = seedUser(db, {
        email: "max@example.com",
        name: "Max",
      });
      const auth = createAuth({
        baseUrl: "http://localhost:3000",
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        secret: "abcdefghijklmnopqrstuvwxyz123456",
        trustedOrigins: ["http://localhost:3000"],
      }, db);
      const created = await auth.api.createApiKey({
        body: {
          name: "test-key",
          permissions: { mailings: ["create"] },
          userId: bootstrap.userId,
        },
      });
      const verified = await auth.api.verifyApiKey({
        body: {
          key: created.key,
        },
      });
      console.log(JSON.stringify({
        created: {
          rateLimitEnabled: created.rateLimitEnabled,
          referenceId: created.referenceId,
        },
        userId: bootstrap.userId,
        valid: verified.valid,
        verified: verified.key && {
          permissions: verified.key.permissions,
          referenceId: verified.key.referenceId,
        },
      }));
      db.close();
    `,
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as {
      created: { rateLimitEnabled: boolean; referenceId: string };
      userId: string;
      valid: boolean;
      verified: { permissions: Record<string, string[]>; referenceId: string };
    };

    expect(output.valid).toBe(true);
    expect(output.created.rateLimitEnabled).toBe(false);
    expect(output.created.referenceId).toBe(output.userId);
    expect(output.verified.referenceId).toBe(output.userId);
    expect(output.verified.permissions).toEqual({ mailings: ["create"] });
  });
});
