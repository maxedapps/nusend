import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("createAuth", () => {
  it("creates and verifies an organization-owned API key with the mapped schema", () => {
    const result = runBunScript(`
      import { Database } from "bun:sqlite";
      import { readFileSync } from "node:fs";
      import { parseMigrationFile } from ${JSON.stringify(`${serviceRoot}src/db/migration-files.ts`)};
      import { createAuth, organizationApiKeyConfigId } from ${JSON.stringify(`${serviceRoot}src/auth/auth.ts`)};
      import { bootstrapOwner } from ${JSON.stringify(`${serviceRoot}src/auth/bootstrap.ts`)};

      const db = new Database(":memory:", { strict: true });
      db.run("PRAGMA foreign_keys = ON;");
      const migration = parseMigrationFile("0002_auth", readFileSync(${JSON.stringify(`${serviceRoot}src/db/migrations/sql/0002_auth.sql`)}, "utf8"));
      db.run(migration.upSql);
      const bootstrap = bootstrapOwner(db, {
        email: "max@example.com",
        name: "Max",
        slug: "nusend",
        workspace: "Nusend",
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
          configId: organizationApiKeyConfigId,
          name: "test-key",
          organizationId: bootstrap.organizationId,
          permissions: { mailings: ["send"] },
          userId: bootstrap.userId,
        },
      });
      const verified = await auth.api.verifyApiKey({
        body: {
          configId: organizationApiKeyConfigId,
          key: created.key,
        },
      });
      console.log(JSON.stringify({
        created: {
          rateLimitEnabled: created.rateLimitEnabled,
          referenceId: created.referenceId,
        },
        valid: verified.valid,
        verified: verified.key && {
          permissions: verified.key.permissions,
          referenceId: verified.key.referenceId,
        },
      }));
      db.close();
    `);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as {
      created: { rateLimitEnabled: boolean; referenceId: string };
      valid: boolean;
      verified: { permissions: Record<string, string[]>; referenceId: string };
    };

    expect(output.valid).toBe(true);
    expect(output.created.rateLimitEnabled).toBe(false);
    expect(output.verified.referenceId).toBe(output.created.referenceId);
    expect(output.verified.permissions).toEqual({ mailings: ["send"] });
  });
});

function runBunScript(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "nusend-auth-integration-test-"));
  temporaryDirectories.push(directory);
  const scriptPath = join(directory, "scenario.ts");
  writeFileSync(scriptPath, script);

  return spawnSync("bun", [scriptPath], {
    cwd: serviceRoot,
    encoding: "utf8",
  });
}
