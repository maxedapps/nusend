import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("createAuth", () => {
  it("keeps Better Auth focused on browser sessions instead of API-key plugin endpoints", () => {
    const result = runBunScenario(
      `
      import { createAuth } from ${JSON.stringify(`${serviceRoot}src/auth/auth.ts`)};
      import { createMigratedBunDatabase } from ${JSON.stringify(`${serviceRoot}src/testing/bun-fixtures.ts`)};

      const db = createMigratedBunDatabase();
      const auth = createAuth({
        baseUrl: "http://localhost:3000",
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
        secret: "abcdefghijklmnopqrstuvwxyz123456",
        trustedOrigins: ["http://localhost:3000"],
      }, db);
      console.log(JSON.stringify({
        hasCreateApiKey: typeof auth.api.createApiKey,
        hasVerifyApiKey: typeof auth.api.verifyApiKey,
        hasGetSession: typeof auth.api.getSession,
      }));
      db.close();
    `,
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as {
      hasCreateApiKey: string;
      hasGetSession: string;
      hasVerifyApiKey: string;
    };

    expect(output.hasCreateApiKey).toBe("undefined");
    expect(output.hasVerifyApiKey).toBe("undefined");
    expect(output.hasGetSession).toBe("function");
  });
});
