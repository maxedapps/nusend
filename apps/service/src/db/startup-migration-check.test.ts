import { Cause, Effect, Exit, Result } from "effect";
import { describe, expect, it } from "vitest";

import { DatabaseError } from "../errors.ts";
import { Database } from "../services/database.ts";
import { DatabaseNodeLive } from "../testing/layers.ts";
import { assertMigrationsUpToDate, describeStartupMigrationFailure } from "./migration-check.ts";
import { readMigrationFiles } from "./migration-files.ts";

describe("assertMigrationsUpToDate", () => {
  it("passes when every migration is recorded in schema_migrations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        yield* db.exec(
          "test:create-schema-migrations",
          `CREATE TABLE schema_migrations (
             version TEXT PRIMARY KEY,
             checksum TEXT NOT NULL,
             applied_at TEXT NOT NULL DEFAULT 't'
           );`,
        );
        for (const parsed of readMigrationFiles()) {
          const migration = Result.getOrThrow(parsed);
          yield* db.run(
            "test:record-migration",
            "INSERT INTO schema_migrations (version, checksum) VALUES ($version, $checksum);",
            { checksum: migration.checksum, version: migration.version },
          );
        }
        yield* assertMigrationsUpToDate();
      }).pipe(Effect.provide(DatabaseNodeLive(":memory:", { migrate: false }))),
    );
  });

  it("sanitizes non-migration startup failures", () => {
    const message = describeStartupMigrationFailure(
      Cause.fail(
        new DatabaseError({
          cause: new Error("database-path-and-driver-sentinel"),
          operation: "migrations:read",
        }),
      ),
    );

    expect(message).toBe("database migration validation failed");
    expect(message).not.toContain("sentinel");
  });

  it("fails with a run-db:migrate message on an empty/unmigrated database", async () => {
    const exit = await Effect.runPromiseExit(
      assertMigrationsUpToDate().pipe(
        Effect.provide(DatabaseNodeLive(":memory:", { migrate: false })),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const message = describeStartupMigrationFailure(exit.cause);
      expect(message).toMatch(/pending migration/);
      expect(message).toMatch(/db:migrate/);
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).toBe("Some");
    }
  });
});
