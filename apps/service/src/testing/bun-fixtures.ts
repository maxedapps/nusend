// Helpers imported by bun-scenario scripts (they run under Bun, so bun:sqlite is
// available). Not used by in-process vitest tests.
import { Database as BunDatabase } from "bun:sqlite";
import { Effect, ManagedRuntime, Result } from "effect";

import { readMigrationFiles } from "../db/migration-files.ts";
import { Database } from "../services/database.ts";
import { DatabaseBunLive, SqliteHandle } from "../services/database-bun.ts";

// Reads FK/WAL/busy_timeout off the dedicated Better Auth connection
// (SqliteHandle) of a file-path bun database, plus app-connection health and
// synchronous mode from both real handles.
// Lives here so a bun-scenario script can call it without importing `effect`
// itself (a direct bare `effect` import from the out-of-tree scenario file
// resolves to a different effect copy than the in-tree project files).
export async function readAuthConnectionPragmas(databasePath: string): Promise<{
  appAlive: boolean;
  appSynchronous: number;
  authSynchronous: number;
  foreignKeys: number;
  journalMode: string;
  busyTimeout: number;
  appSeesAuthTempTable: boolean;
}> {
  const runtime = ManagedRuntime.make(DatabaseBunLive(databasePath));
  try {
    const handle = await runtime.runPromise(SqliteHandle);
    const appAlive = await runtime.runPromise(Effect.flatMap(Database, (db) => db.ping));
    const appSynchronousRow = await runtime.runPromise(
      Effect.flatMap(Database, (db) =>
        db.get<{ synchronous: number }>("test:app-synchronous", "PRAGMA synchronous;"),
      ),
    );
    if (appSynchronousRow === null) throw new Error("app synchronous pragma returned no row");
    const read = <T>(name: string) => handle.query(`PRAGMA ${name};`).get() as T;

    // Prove the app and auth handles are genuinely separate connections (not the
    // same handle handed out twice): TEMP tables are connection-private in
    // SQLite, so a temp table created on the auth handle must be invisible to the
    // app connection when they are distinct.
    handle.run("CREATE TEMP TABLE nusend_auth_only_probe (x);");
    const appSeesAuthTempTable = await runtime.runPromise(
      Effect.flatMap(Database, (db) =>
        db.get<{ name: string }>(
          "test:temp-visibility",
          "SELECT name FROM sqlite_temp_master WHERE name = 'nusend_auth_only_probe';",
        ),
      ).pipe(Effect.map((row) => row !== null)),
    );

    return {
      appAlive,
      appSeesAuthTempTable,
      appSynchronous: appSynchronousRow.synchronous,
      authSynchronous: read<{ synchronous: number }>("synchronous").synchronous,
      busyTimeout: read<{ timeout: number }>("busy_timeout").timeout,
      foreignKeys: read<{ foreign_keys: number }>("foreign_keys").foreign_keys,
      journalMode: read<{ journal_mode: string }>("journal_mode").journal_mode,
    };
  } finally {
    await runtime.dispose();
  }
}

export function createMigratedBunDatabase(): BunDatabase {
  const db = new BunDatabase(":memory:", { create: true, strict: true });
  db.run("PRAGMA foreign_keys = ON;");

  for (const parsed of readMigrationFiles()) {
    db.run(Result.getOrThrow(parsed).sql);
  }

  return db;
}

// Seeds the owner user that `bootstrapOwner` would create, for scenarios that
// need an existing owner without running the bootstrap program.
export function seedUser(
  db: BunDatabase,
  input: { email: string; name: string },
): { userId: string } {
  const now = "2026-07-03T12:00:00.000Z";
  const userId = crypto.randomUUID();

  db.query(
    `INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at)
     VALUES ($id, $name, $email, 1, NULL, $now, $now);`,
  ).run({ email: input.email.trim().toLowerCase(), id: userId, name: input.name, now });

  return { userId };
}
