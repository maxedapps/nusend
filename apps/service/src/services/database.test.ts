import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupBunScenarios, runBunScenario } from "../testing/bun-scenario.ts";
import { assertDisposeClosesDatabase, runDatabaseContract } from "../testing/database-contract.ts";
import { DatabaseNodeLive, runTest } from "../testing/layers.ts";
import { Database } from "./database.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));

afterEach(() => cleanupBunScenarios());

describe("database service", () => {
  it("node:sqlite layer satisfies the driver contract", async () => {
    await runDatabaseContract(DatabaseNodeLive(":memory:"));
  });

  it("node:sqlite layer applies the real migration files", async () => {
    const tables = await runTest(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.all<{ name: string }>(
          "list-tables",
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('mailings', 'deliveries', 'jobs', 'users', 'api_keys')
           ORDER BY name ASC;`,
        );
      }),
    );

    expect(tables.map((table) => table.name)).toEqual([
      "api_keys",
      "deliveries",
      "jobs",
      "mailings",
      "users",
    ]);
  });

  it("ManagedRuntime.dispose closes the node:sqlite connection", async () => {
    await assertDisposeClosesDatabase(DatabaseNodeLive(":memory:"));
  });

  it("bun:sqlite layer satisfies the driver contract and dispose lifecycle", () => {
    const result = runBunScenario(
      `
        import { DatabaseBunLive } from ${JSON.stringify(`${serviceRoot}src/services/database-bun.ts`)};
        import {
          assertDisposeClosesDatabase,
          runDatabaseContract,
        } from ${JSON.stringify(`${serviceRoot}src/testing/database-contract.ts`)};

        await runDatabaseContract(DatabaseBunLive(":memory:"));
        await assertDisposeClosesDatabase(DatabaseBunLive(":memory:"));
        console.log("OK");
      `,
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("bun:sqlite gives Better Auth a dedicated connection with matching pragmas", () => {
    // The dedicated auth connection (SqliteHandle) only exists for file-path
    // databases; assert it carries the same FK/WAL/busy_timeout pragmas as the
    // app connection so FK enforcement and locking behavior cannot drift.
    const result = runBunScenario(
      `
        import { join } from "node:path";
        import { readAuthConnectionPragmas } from ${JSON.stringify(`${serviceRoot}src/testing/bun-fixtures.ts`)};

        const path = join(import.meta.dir, "pragma-parity.sqlite");
        console.log(JSON.stringify(await readAuthConnectionPragmas(path)));
      `,
      serviceRoot,
    );

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      appAlive: boolean;
      foreignKeys: number;
      journalMode: string;
      busyTimeout: number;
      appSeesAuthTempTable: boolean;
    };
    expect(parsed.appAlive).toBe(true);
    expect(parsed.foreignKeys).toBe(1);
    expect(parsed.journalMode).toBe("wal");
    expect(parsed.busyTimeout).toBe(5000);
    // A TEMP table on the auth connection must be invisible to the app
    // connection — proves they are genuinely separate handles.
    expect(parsed.appSeesAuthTempTable).toBe(false);
  });
});
