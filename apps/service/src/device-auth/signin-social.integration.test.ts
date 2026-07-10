import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("CLI activation social sign-in", () => {
  it("starts Google sign-in through Better Auth's JSON social endpoint", () => {
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

      const social = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/social", {
        body: JSON.stringify({ provider: "google", callbackURL: "/cli/activate?code=ABCD-2345" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }));
      const socialBody = await social.json();
      const obsolete = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/google"));
      console.log(JSON.stringify({ socialBody, socialStatus: social.status, obsoleteStatus: obsolete.status }));
      db.close();
    `,
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as {
      obsoleteStatus: number;
      socialBody: { url?: string };
      socialStatus: number;
    };

    expect(output.socialStatus).toBe(200);
    expect(output.socialBody.url).toContain("accounts.google.com");
    expect(output.socialBody.url).toContain(
      encodeURIComponent("http://localhost:3000/api/auth/callback/google"),
    );
    expect(output.obsoleteStatus).toBe(404);
  });
});
