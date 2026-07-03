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

describe("requirePrincipal", () => {
  it("returns 401 without auth", () => {
    const result = runMiddlewareScenario({ sessionLiteral: "null" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("STATUS:401");
  });

  it("returns 401 for invalid API keys", () => {
    const result = runMiddlewareScenario({ apiKeyValid: false, requestApiKey: "invalid" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("STATUS:401");
  });

  it("returns 403 for API keys missing permissions", () => {
    const result = runMiddlewareScenario({
      apiKeyPermissionsLiteral: '{ mailings: ["read"] }',
      requestApiKey: "valid",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("STATUS:403");
  });

  it("allows API keys with required permissions", () => {
    const result = runMiddlewareScenario({
      apiKeyPermissionsLiteral: '{ mailings: ["send"] }',
      requestApiKey: "valid",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("STATUS:200");
    expect(result.stdout).toContain('{"ok":true}');
  });

  it("allows sessions and resolves the single organization when active org is missing", () => {
    const result = runMiddlewareScenario({
      insertMember: true,
      sessionLiteral: '{ activeOrganizationId: null, userId: "user_1" }',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("STATUS:200");
    expect(result.stdout).toContain('{"ok":true}');
  });

  it("denies sessions with unknown roles", () => {
    const result = runMiddlewareScenario({
      insertMember: true,
      memberRole: "unexpected",
      sessionLiteral: '{ activeOrganizationId: null, userId: "user_1" }',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("STATUS:403");
  });
});

function runMiddlewareScenario(options: {
  apiKeyPermissionsLiteral?: string;
  apiKeyValid?: boolean;
  insertMember?: boolean;
  memberRole?: string;
  requestApiKey?: string;
  sessionLiteral?: string;
}) {
  const headers = options.requestApiKey ? `{ "x-api-key": "${options.requestApiKey}" }` : "{}";
  const script = `
    import { Database } from "bun:sqlite";
    import { readFileSync } from "node:fs";
    import { Hono } from "hono";
    import { parseMigrationFile } from ${JSON.stringify(`${serviceRoot}src/db/migration-files.ts`)};
    import { requirePrincipal } from ${JSON.stringify(`${serviceRoot}src/auth/middleware.ts`)};

    const db = new Database(":memory:", { strict: true });
    db.run("PRAGMA foreign_keys = ON;");
    const migration = parseMigrationFile("0002_auth", readFileSync(${JSON.stringify(`${serviceRoot}src/db/migrations/sql/0002_auth.sql`)}, "utf8"));
    db.run(migration.upSql);

    if (${Boolean(options.insertMember)}) {
      const now = new Date().toISOString();
      db.query(
        \`INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at)
          VALUES ('user_1', 'User', 'user@example.com', 1, NULL, $now, $now);\`,
      ).run({ now });
      db.query(
        \`INSERT INTO organizations (id, name, slug, logo, created_at, metadata)
          VALUES ('org_1', 'Nusend', 'nusend', NULL, $now, NULL);\`,
      ).run({ now });
      db.query(
        \`INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
          VALUES ('member_1', 'org_1', 'user_1', $role, $now);\`,
      ).run({ now, role: ${JSON.stringify(options.memberRole ?? "member")} });
    }

    const auth = {
      api: {
        getSession: async () => {
          const session = ${options.sessionLiteral ?? "undefined"};
          return session ? { session, user: { id: session.userId } } : null;
        },
        verifyApiKey: async () =>
          ${options.apiKeyValid === false}
            ? { error: { code: "INVALID_API_KEY", message: "Invalid API key." }, key: null, valid: false }
            : {
                error: null,
                key: {
                  id: "key_1",
                  permissions: ${options.apiKeyPermissionsLiteral ?? "{}"},
                  referenceId: "org_1",
                },
                valid: true,
              },
      },
    };

    const app = new Hono();
    app.get(
      "/protected",
      requirePrincipal({ auth, db, permissions: { mailings: ["send"] } }),
      (context) => context.json({ ok: true }),
    );
    const response = await app.fetch(new Request("http://localhost/protected", { headers: ${headers} }));
    console.log("STATUS:" + response.status);
    console.log(await response.text());
    db.close();
  `;

  return runBunScript(script);
}

function runBunScript(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "nusend-middleware-test-"));
  temporaryDirectories.push(directory);
  const scriptPath = join(directory, "scenario.ts");
  writeFileSync(scriptPath, script);

  return spawnSync("bun", [scriptPath], {
    cwd: serviceRoot,
    encoding: "utf8",
  });
}
