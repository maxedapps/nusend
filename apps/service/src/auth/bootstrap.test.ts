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

describe("bootstrapOwner", () => {
  it("creates the first owner, workspace, and membership", () => {
    const result = runBootstrapScenario(`
      const result = bootstrapOwner(db, {
        email: "Max@Example.com",
        name: "Max",
        slug: "nusend",
        workspace: "Nusend",
      });
      const user = db.query("SELECT * FROM users WHERE id = $id;").get({ id: result.userId });
      const organization = db.query("SELECT * FROM organizations WHERE id = $id;").get({ id: result.organizationId });
      const member = db.query("SELECT * FROM organization_members WHERE user_id = $userId;").get({ userId: result.userId });
      const accounts = db.query("SELECT COUNT(*) AS count FROM accounts;").get();
      console.log(JSON.stringify({ accounts, member, organization, user }));
    `);

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      accounts: { count: number };
      member: { organization_id: string; role: string };
      organization: { name: string; slug: string };
      user: { email: string; email_verified: number; name: string };
    };

    expect(output.user).toMatchObject({
      email: "max@example.com",
      email_verified: 1,
      name: "Max",
    });
    expect(output.organization).toMatchObject({ name: "Nusend", slug: "nusend" });
    expect(output.member.role).toBe("owner");
    expect(output.accounts.count).toBe(0);
  });

  it("refuses a second owner without force", () => {
    const result = runBootstrapScenario(`
      bootstrapOwner(db, { email: "max@example.com", name: "Max", slug: "nusend", workspace: "Nusend" });
      try {
        bootstrapOwner(db, { email: "team@example.com", name: "Team", slug: "nusend", workspace: "Nusend" });
      } catch (error) {
        console.log(String(error));
      }
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("owner already exists");
  });

  it("requires migrated auth schema", () => {
    const result = runBunScript(`
      import { Database } from "bun:sqlite";
      import { bootstrapOwner } from ${JSON.stringify(`${serviceRoot}src/auth/bootstrap.ts`)};
      const db = new Database(":memory:", { strict: true });
      try {
        bootstrapOwner(db, { email: "max@example.com", name: "Max", slug: "nusend", workspace: "Nusend" });
      } catch (error) {
        console.log(String(error));
      } finally {
        db.close();
      }
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("not migrated");
  });
});

function runBootstrapScenario(body: string) {
  return runBunScript(`
    import { Database } from "bun:sqlite";
    import { readFileSync } from "node:fs";
    import { parseMigrationFile } from ${JSON.stringify(`${serviceRoot}src/db/migration-files.ts`)};
    import { bootstrapOwner } from ${JSON.stringify(`${serviceRoot}src/auth/bootstrap.ts`)};
    const db = new Database(":memory:", { strict: true });
    db.run("PRAGMA foreign_keys = ON;");
    const migration = parseMigrationFile("0002_auth", readFileSync(${JSON.stringify(`${serviceRoot}src/db/migrations/sql/0002_auth.sql`)}, "utf8"));
    db.run(migration.upSql);
    try {
      ${body}
    } finally {
      db.close();
    }
  `);
}

function runBunScript(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "nusend-bootstrap-test-"));
  temporaryDirectories.push(directory);
  const scriptPath = join(directory, "scenario.ts");
  writeFileSync(scriptPath, script);

  return spawnSync("bun", [scriptPath], {
    cwd: serviceRoot,
    encoding: "utf8",
  });
}
