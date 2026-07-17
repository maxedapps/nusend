import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "effect";

import { MigrationError } from "../errors.ts";

export const migrationsDirectory = fileURLToPath(new URL("./migrations/sql/", import.meta.url));

export type MigrationFile = {
  checksum: string;
  sql: string;
  version: string;
};

// The one place that lists, orders, and parses on-disk forward migrations. The
// migrate CLI and every test layer/fixture use it so behavior cannot drift.
export function readMigrationFiles(): Result.Result<MigrationFile, MigrationError>[] {
  if (!existsSync(migrationsDirectory)) return [];

  return readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) =>
      parseMigrationFile(
        basename(fileName, ".sql"),
        readFileSync(join(migrationsDirectory, fileName), "utf8"),
      ),
    );
}

export function parseMigrationFile(
  version: string,
  content: string,
): Result.Result<MigrationFile, MigrationError> {
  const sql = content.trim();
  if (sql.length === 0) {
    return Result.fail(new MigrationError({ reason: `Migration ${version} is empty.`, version }));
  }

  return Result.succeed({ checksum: checksum(content), sql, version });
}

export function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
