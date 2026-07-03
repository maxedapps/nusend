import { describe, expect, it } from "vitest";

import { parseMigrationFile } from "./migration-files.ts";

describe("parseMigrationFile", () => {
  it("parses up and down sections", () => {
    const migration = parseMigrationFile(
      "0001_test",
      `-- migrate:up
CREATE TABLE test (id TEXT PRIMARY KEY);

-- migrate:down
DROP TABLE test;`,
    );

    expect(migration.version).toBe("0001_test");
    expect(migration.upSql).toBe("CREATE TABLE test (id TEXT PRIMARY KEY);");
    expect(migration.downSql).toBe("DROP TABLE test;");
    expect(migration.checksum).toHaveLength(64);
  });

  it("rejects missing up marker", () => {
    expect(() =>
      parseMigrationFile(
        "0001_test",
        `CREATE TABLE test (id TEXT PRIMARY KEY);

-- migrate:down
DROP TABLE test;`,
      ),
    ).toThrow(/exactly one -- migrate:up/);
  });

  it("rejects duplicate down markers", () => {
    expect(() =>
      parseMigrationFile(
        "0001_test",
        `-- migrate:up
CREATE TABLE test (id TEXT PRIMARY KEY);

-- migrate:down
DROP TABLE test;

-- migrate:down
DROP TABLE other_test;`,
      ),
    ).toThrow(/exactly one -- migrate:down/);
  });

  it("rejects empty sections", () => {
    expect(() =>
      parseMigrationFile(
        "0001_test",
        `-- migrate:up

-- migrate:down
DROP TABLE test;`,
      ),
    ).toThrow(/empty up section/);
  });

  it("rejects down before up", () => {
    expect(() =>
      parseMigrationFile(
        "0001_test",
        `-- migrate:down
DROP TABLE test;

-- migrate:up
CREATE TABLE test (id TEXT PRIMARY KEY);`,
      ),
    ).toThrow(/up before -- migrate:down/);
  });
});
