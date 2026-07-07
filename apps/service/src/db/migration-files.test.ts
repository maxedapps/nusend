import { Result } from "effect";
import { describe, expect, it } from "vitest";

import type { MigrationError } from "../errors.ts";
import { parseMigrationFile, type MigrationFile } from "./migration-files.ts";

function failureReason(result: Result.Result<MigrationFile, MigrationError>): string {
  return Result.isFailure(result) ? result.failure.reason : "unexpected success";
}

describe("parseMigrationFile", () => {
  it("parses up and down sections", () => {
    const migration = Result.getOrThrow(
      parseMigrationFile(
        "0001_test",
        `-- migrate:up
CREATE TABLE test (id TEXT PRIMARY KEY);

-- migrate:down
DROP TABLE test;`,
      ),
    );

    expect(migration.version).toBe("0001_test");
    expect(migration.upSql).toBe("CREATE TABLE test (id TEXT PRIMARY KEY);");
    expect(migration.downSql).toBe("DROP TABLE test;");
    expect(migration.checksum).toHaveLength(64);
  });

  it("rejects missing up marker", () => {
    const result = parseMigrationFile(
      "0001_test",
      `CREATE TABLE test (id TEXT PRIMARY KEY);

-- migrate:down
DROP TABLE test;`,
    );

    expect(failureReason(result)).toMatch(/exactly one -- migrate:up/);
  });

  it("rejects duplicate down markers", () => {
    const result = parseMigrationFile(
      "0001_test",
      `-- migrate:up
CREATE TABLE test (id TEXT PRIMARY KEY);

-- migrate:down
DROP TABLE test;

-- migrate:down
DROP TABLE other_test;`,
    );

    expect(failureReason(result)).toMatch(/exactly one -- migrate:down/);
  });

  it("rejects empty sections", () => {
    const result = parseMigrationFile(
      "0001_test",
      `-- migrate:up

-- migrate:down
DROP TABLE test;`,
    );

    expect(failureReason(result)).toMatch(/empty up section/);
  });

  it("rejects down before up", () => {
    const result = parseMigrationFile(
      "0001_test",
      `-- migrate:down
DROP TABLE test;

-- migrate:up
CREATE TABLE test (id TEXT PRIMARY KEY);`,
    );

    expect(failureReason(result)).toMatch(/up before -- migrate:down/);
  });

  it("carries the version on failures", () => {
    const result = parseMigrationFile("0042_broken", "no markers at all");

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.version).toBe("0042_broken");
    }
  });
});
