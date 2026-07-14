import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { Database } from "../services/database.ts";
import { DatabaseNodeLive, sequentialIdsLayer } from "../testing/layers.ts";
import { deleteManualSuppression } from "./write.ts";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../testing/suppression-list-race-fixture.ts", import.meta.url),
);

type FixtureResult = { readonly ok: boolean; readonly tag?: string };

describe("file-backed suppression and list write races", () => {
  it.each(["promotion-first", "deletion-first"] as const)(
    "keeps automated suppression protected with %s commit ordering",
    async (ordering) => {
      const scenario = await makeScenario("suppression");
      try {
        const promote = startFixture(scenario, "promote-suppression");
        await waitForFile(promote.readyPath);
        const remove = startFixture(scenario, "delete-suppression");
        await waitForFile(remove.readyPath);

        const [first, second] =
          ordering === "promotion-first" ? [promote, remove] : [remove, promote];
        const [firstResult, secondResult] = await runOverlapping(first, second);

        expect(firstResult).toEqual({ ok: true });
        expect(secondResult).toEqual(
          ordering === "promotion-first" ? { ok: false, tag: "ConflictError" } : { ok: true },
        );

        const runtime = ManagedRuntime.make(
          DatabaseNodeLive(scenario.databasePath, { migrate: false }),
        );
        try {
          const final = await runtime.runPromise(
            Effect.gen(function* () {
              const db = yield* Database;
              const rows = yield* db.all(
                "race:suppression:final",
                `SELECT id, lower(email) AS email, reason, created_at AS createdAt
                 FROM suppressions;`,
              );
              const deleteResult = yield* deleteManualSuppression(
                ordering === "promotion-first" ? "supp_manual" : "supp_automated",
              ).pipe(
                Effect.match({
                  onFailure: (error) => Reflect.get(error, "_tag") as string,
                  onSuccess: () => "deleted",
                }),
              );
              return { deleteResult, rows };
            }),
          );

          expect(final).toEqual({
            deleteResult: "ConflictError",
            rows: [
              {
                createdAt:
                  ordering === "promotion-first"
                    ? "2026-07-01T00:00:00.000Z"
                    : "2026-07-04T00:00:00.000Z",
                email: "race@example.com",
                id: ordering === "promotion-first" ? "supp_manual" : "supp_automated",
                reason: "bounce",
              },
            ],
          });
        } finally {
          await runtime.dispose();
        }
      } finally {
        await scenario.cleanup();
      }
    },
    15_000,
  );

  it.each(["creation-first", "deletion-first"] as const)(
    "keeps list-backed mailing state valid with %s commit ordering",
    async (ordering) => {
      const scenario = await makeScenario("list");
      try {
        const create = startFixture(scenario, "create-mailing");
        await waitForFile(create.readyPath);
        const remove = startFixture(scenario, "delete-list");
        await waitForFile(remove.readyPath);

        const [first, second] = ordering === "creation-first" ? [create, remove] : [remove, create];
        const [firstResult, secondResult] = await runOverlapping(first, second);

        expect(firstResult).toEqual({ ok: true });
        expect(secondResult).toEqual(
          ordering === "creation-first"
            ? { ok: false, tag: "ConflictError" }
            : { ok: false, tag: "ListNotFoundError" },
        );

        const runtime = ManagedRuntime.make(
          DatabaseNodeLive(scenario.databasePath, { migrate: false }),
        );
        try {
          const final = await runtime.runPromise(
            Effect.flatMap(Database, (db) =>
              db.get(
                "race:list:final",
                `SELECT
                   (SELECT count(*) FROM lists WHERE id = 'list_race') AS listCount,
                   (SELECT count(*) FROM mailings) AS mailingCount,
                   (SELECT count(*) FROM deliveries) AS deliveryCount,
                   (SELECT count(*) FROM jobs) AS jobCount,
                   (SELECT count(*) FROM mailings
                    WHERE state <> 'completed' AND list_id IS NULL) AS orphanedActiveCount;`,
              ),
            ),
          );

          expect(final).toEqual(
            ordering === "creation-first"
              ? {
                  deliveryCount: 1,
                  jobCount: 1,
                  listCount: 1,
                  mailingCount: 1,
                  orphanedActiveCount: 0,
                }
              : {
                  deliveryCount: 0,
                  jobCount: 0,
                  listCount: 0,
                  mailingCount: 0,
                  orphanedActiveCount: 0,
                },
          );
        } finally {
          await runtime.dispose();
        }
      } finally {
        await scenario.cleanup();
      }
    },
    15_000,
  );
});

type Scenario = {
  readonly databasePath: string;
  readonly directory: string;
  readonly children: Set<ChildProcessWithoutNullStreams>;
  readonly cleanup: () => Promise<void>;
};

async function makeScenario(kind: "list" | "suppression"): Promise<Scenario> {
  const directory = mkdtempSync(join(tmpdir(), "nusend-suppression-list-race-"));
  const databasePath = join(directory, "race.sqlite");
  const children = new Set<ChildProcessWithoutNullStreams>();
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DatabaseNodeLive(databasePath), sequentialIdsLayer("seed")),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* Database;
        if (kind === "suppression") {
          yield* db.run(
            "race:seed:suppression",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ('supp_manual', 'Race@Example.com', 'all', NULL, 'manual', '2026-07-01T00:00:00.000Z');`,
          );
          return;
        }

        yield* db.run(
          "race:seed:list",
          "INSERT INTO lists (id, name, created_at) VALUES ('list_race', 'Race', '2026-07-01T00:00:00.000Z');",
        );
        yield* db.run(
          "race:seed:contact",
          `INSERT INTO contacts (id, email, created_at, updated_at)
           VALUES ('contact_race', 'race@example.com', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');`,
        );
        yield* db.run(
          "race:seed:membership",
          `INSERT INTO list_memberships (list_id, contact_id, subscribed_at, unsubscribed_at)
           VALUES ('list_race', 'contact_race', '2026-07-01T00:00:00.000Z', NULL);`,
        );
      }),
    );
  } finally {
    await runtime.dispose();
  }

  return {
    children,
    databasePath,
    directory,
    cleanup: async () => {
      await Promise.all([...children].map(terminateChild));
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

function startFixture(scenario: Scenario, operation: string) {
  const prefix = join(scenario.directory, operation);
  const readyPath = `${prefix}.ready`;
  const startPath = `${prefix}.start`;
  const attemptedPath = `${prefix}.attempted`;
  const acquiredPath = `${prefix}.acquired`;
  const releasePath = `${prefix}.release`;
  const resultPath = `${prefix}.result.json`;
  const child = spawn(
    "bun",
    [
      fixturePath,
      scenario.databasePath,
      readyPath,
      startPath,
      attemptedPath,
      acquiredPath,
      releasePath,
      resultPath,
      operation,
    ],
    { cwd: serviceRoot, stdio: "pipe" },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  const exit = new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Race fixture timed out. ${output}`));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  scenario.children.add(child);
  return {
    acquiredPath,
    attemptedPath,
    child,
    exit,
    getOutput: () => output,
    readyPath,
    releasePath,
    resultPath,
    startPath,
  };
}

async function runOverlapping(
  first: ReturnType<typeof startFixture>,
  second: ReturnType<typeof startFixture>,
): Promise<readonly [FixtureResult, FixtureResult]> {
  writeFileSync(first.startPath, "start");
  await waitForFile(first.attemptedPath);
  await waitForFile(first.acquiredPath);
  expect(first.child.exitCode).toBeNull();
  expect(existsSync(first.resultPath)).toBe(false);

  writeFileSync(second.startPath, "start");
  await waitForFile(second.attemptedPath);
  expect(existsSync(first.acquiredPath)).toBe(true);
  expect(second.child.exitCode).toBeNull();
  expect(existsSync(second.acquiredPath)).toBe(false);
  expect(existsSync(second.resultPath)).toBe(false);

  // BEGIN IMMEDIATE is synchronous in bun:sqlite. This tiny bounded observation
  // proves the second child remains blocked, rather than merely losing a marker
  // visibility race, while the first child's explicit release barrier is absent.
  expect(await fileAppearsWithin(second.acquiredPath, 75)).toBe(false);
  expect(existsSync(second.resultPath)).toBe(false);
  expect(second.child.exitCode).toBeNull();

  const firstResult = await releaseTransactionAndRead(first);
  await waitForFile(second.acquiredPath);
  expect(existsSync(second.resultPath)).toBe(false);
  const secondResult = await releaseTransactionAndRead(second);

  expect(first.child.exitCode).toBe(0);
  expect(second.child.exitCode).toBe(0);
  return [firstResult, secondResult];
}

async function releaseTransactionAndRead(
  fixture: ReturnType<typeof startFixture>,
): Promise<FixtureResult> {
  writeFileSync(fixture.releasePath, "release");
  await waitForFile(fixture.resultPath);
  const exitCode = await fixture.exit;
  expect(exitCode, fixture.getOutput()).toBe(0);
  return JSON.parse(readFileSync(fixture.resultPath, "utf8")) as FixtureResult;
}

async function fileAppearsWithin(path: string, milliseconds: number): Promise<boolean> {
  const attempts = Math.ceil(milliseconds / 5);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(path)) return true;
    // oxlint-disable-next-line no-await-in-loop -- this is a bounded negative observation, not transaction ordering.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return existsSync(path);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(path)) return;
    // oxlint-disable-next-line no-await-in-loop -- bounded polling observes a cross-process file barrier sequentially.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out terminating child ${child.pid ?? "unknown"}.`)),
      2_000,
    );
    const finish = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("close", finish);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("close", finish);
      finish();
      return;
    }
    child.kill("SIGKILL");
  });
}
