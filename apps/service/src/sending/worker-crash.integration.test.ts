import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serviceRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = fileURLToPath(new URL("../testing/worker-crash-fixture.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("file-backed send crash and reconciliation boundaries", () => {
  it("kills after dispatch, reclaims without redispatch, and accepts late exact proof", async () => {
    const directory = temporaryDirectory("nusend-worker-crash-");
    const databasePath = join(directory, "crash.sqlite");
    migrate(databasePath);
    execSql(
      databasePath,
      `INSERT INTO mailings (id, purpose, state, subject, html, created_at, updated_at)
       VALUES ('mailing_crash', 'transactional', 'scheduled', 'Crash', '<p>Crash</p>', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO deliveries (id, mailing_id, email, status, created_at, updated_at)
       VALUES ('delivery_crash', 'mailing_crash', 'crash@example.com', 'queued', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO jobs (id, state, run_at, attempts, max_attempts, delivery_id, created_at, updated_at)
       VALUES ('job_crash', 'queued', '2026-01-01T00:00:00.000Z', 0, 1, 'delivery_crash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`,
    );

    const dispatchMarker = join(directory, "dispatch.marker");
    const worker = startFixture("worker-block", databasePath, {
      NUSEND_DISPATCH_MARKER: dispatchMarker,
    });
    await waitForFile(dispatchMarker);
    expect(
      queryRows(
        databasePath,
        "SELECT d.status AS deliveryStatus, j.state AS jobState, a.status AS attemptStatus FROM deliveries d JOIN jobs j ON j.delivery_id = d.id JOIN send_attempts a ON a.delivery_id = d.id;",
      ),
    ).toEqual([{ attemptStatus: "started", deliveryStatus: "sending", jobState: "leased" }]);

    worker.kill("SIGKILL");
    await waitForExit(worker, true);
    execSql(
      databasePath,
      "UPDATE jobs SET locked_until = '2026-01-01T00:00:00.000Z' WHERE id = 'job_crash';",
    );

    const secondDispatch = join(directory, "second-dispatch.marker");
    const restartResult = join(directory, "restart-result.json");
    runFixture("worker-once", databasePath, {
      NUSEND_DISPATCH_MARKER: secondDispatch,
      NUSEND_RESULT_PATH: restartResult,
    });

    expect(existsSync(secondDispatch)).toBe(false);
    expect(JSON.parse(readFileSync(restartResult, "utf8"))).toMatchObject({
      claimed: 0,
      dead: 1,
      released: 1,
    });
    expect(
      queryRows(
        databasePath,
        "SELECT d.status AS deliveryStatus, j.state AS jobState, a.status AS attemptStatus, m.state AS mailingState FROM deliveries d JOIN jobs j ON j.delivery_id = d.id JOIN send_attempts a ON a.delivery_id = d.id JOIN mailings m ON m.id = d.mailing_id;",
      ),
    ).toEqual([
      {
        attemptStatus: "ambiguous",
        deliveryStatus: "ambiguous",
        jobState: "dead",
        mailingState: "completed",
      },
    ]);

    const lateResult = join(directory, "late-result.json");
    runFixture("late-success", databasePath, {
      NUSEND_ATTEMPT_ID: "attempt_crash",
      NUSEND_DELIVERY_ID: "delivery_crash",
      NUSEND_MESSAGE_ID: "late-crash-message",
      NUSEND_RESULT_PATH: lateResult,
    });
    expect(JSON.parse(readFileSync(lateResult, "utf8"))).toBe("Reconciled");
    expect(
      queryRows(
        databasePath,
        "SELECT d.status AS deliveryStatus, d.ses_message_id AS deliveryMessageId, j.state AS jobState, a.status AS attemptStatus, a.ses_message_id AS attemptMessageId FROM deliveries d JOIN jobs j ON j.delivery_id = d.id JOIN send_attempts a ON a.delivery_id = d.id;",
      ),
    ).toEqual([
      {
        attemptMessageId: "late-crash-message",
        attemptStatus: "succeeded",
        deliveryMessageId: "late-crash-message",
        deliveryStatus: "sent",
        jobState: "dead",
      },
    ]);
  }, 20_000);

  it.each([
    {
      first: "race-success" as const,
      firstResult: "Recorded",
      second: "race-stale" as const,
      secondResult: "SupersededTerminal",
    },
    {
      first: "race-stale" as const,
      firstResult: "Recorded",
      second: "race-success" as const,
      secondResult: "Reconciled",
    },
  ])(
    "overlaps independent transactions with $first acquiring first",
    async ({ first, firstResult, second, secondResult }) => {
      const directory = temporaryDirectory(`nusend-${first}-`);
      const databasePath = join(directory, "race.sqlite");
      migrate(databasePath);
      execSql(
        databasePath,
        `INSERT INTO mailings (id, purpose, state, subject, html, created_at, updated_at)
       VALUES ('mailing_race', 'transactional', 'sending', 'Race', '<p>Race</p>', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO deliveries (id, mailing_id, email, status, created_at, updated_at)
       VALUES ('delivery_race', 'mailing_race', 'race@example.com', 'sending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO jobs (id, state, run_at, attempts, max_attempts, delivery_id, created_at, updated_at)
       VALUES ('job_race', 'dead', '2026-01-01T00:00:00.000Z', 1, 1, 'delivery_race', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
       INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, started_at)
       VALUES ('attempt_race', 'delivery_race', 'job_race', 1, 'started', '2026-01-01T00:00:00.000Z');`,
      );

      const firstPaths = barrierPaths(directory, "first");
      const secondPaths = barrierPaths(directory, "second");
      const firstChild = startFixture(first, databasePath, {
        NUSEND_RACE_ACQUIRED: firstPaths.acquired,
        NUSEND_RACE_ATTEMPTED: firstPaths.attempted,
        NUSEND_RACE_HOLD: "1",
        NUSEND_RACE_RELEASE: firstPaths.release,
        NUSEND_RESULT_PATH: firstPaths.result,
      });
      await waitForFile(firstPaths.acquired);

      const secondChild = startFixture(second, databasePath, {
        NUSEND_RACE_ACQUIRED: secondPaths.acquired,
        NUSEND_RACE_ATTEMPTED: secondPaths.attempted,
        NUSEND_RACE_RELEASE: secondPaths.release,
        NUSEND_RESULT_PATH: secondPaths.result,
      });
      await waitForFile(secondPaths.attempted);
      await boundedDelay();
      expect(existsSync(secondPaths.acquired)).toBe(false);

      writeFileSync(firstPaths.release, "release\n", { flag: "wx" });
      await Promise.all([waitForExit(firstChild), waitForExit(secondChild)]);
      expect(existsSync(secondPaths.acquired)).toBe(true);
      expect(JSON.parse(readFileSync(firstPaths.result, "utf8"))).toBe(firstResult);
      expect(JSON.parse(readFileSync(secondPaths.result, "utf8"))).toBe(secondResult);
      expect(
        queryRows(
          databasePath,
          "SELECT d.status AS deliveryStatus, d.ses_message_id AS deliveryMessageId, a.status AS attemptStatus, a.ses_message_id AS attemptMessageId FROM deliveries d JOIN send_attempts a ON a.delivery_id = d.id;",
        ),
      ).toEqual([
        {
          attemptMessageId: "race-message",
          attemptStatus: "succeeded",
          deliveryMessageId: "race-message",
          deliveryStatus: "sent",
        },
      ]);
    },
    20_000,
  );
});

function migrate(databasePath: string): void {
  const result = spawnSync("bun", ["src/db/migrate.ts", "up"], {
    cwd: serviceRoot,
    encoding: "utf8",
    env: { ...process.env, NUSEND_DB_PATH: databasePath },
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

function execSql(databasePath: string, sql: string): void {
  const result = spawnSync(
    "bun",
    [
      "-e",
      "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); db.run('PRAGMA foreign_keys = ON;'); db.exec(process.env.NUSEND_TEST_SQL); db.close();",
    ],
    {
      cwd: serviceRoot,
      encoding: "utf8",
      env: { ...process.env, NUSEND_DB_PATH: databasePath, NUSEND_TEST_SQL: sql },
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
}

function queryRows(databasePath: string, sql: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    "bun",
    [
      "-e",
      "import { Database } from 'bun:sqlite'; const db = new Database(process.env.NUSEND_DB_PATH); console.log(JSON.stringify(db.query(process.env.NUSEND_TEST_SQL).all())); db.close();",
    ],
    {
      cwd: serviceRoot,
      encoding: "utf8",
      env: { ...process.env, NUSEND_DB_PATH: databasePath, NUSEND_TEST_SQL: sql },
      timeout: 10_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
}

function startFixture(
  mode: string,
  databasePath: string,
  extraEnv: Record<string, string>,
): ChildProcess {
  const child = spawn("bun", [fixturePath, mode], {
    cwd: serviceRoot,
    env: { ...process.env, NUSEND_DB_PATH: databasePath, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

function runFixture(mode: string, databasePath: string, extraEnv: Record<string, string>): void {
  const result = spawnSync("bun", [fixturePath, mode], {
    cwd: serviceRoot,
    encoding: "utf8",
    env: { ...process.env, NUSEND_DB_PATH: databasePath, ...extraEnv },
    timeout: 10_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

async function waitForFile(path: string, attemptsRemaining = 200): Promise<void> {
  if (existsSync(path)) return;
  if (attemptsRemaining === 0) throw new Error(`Timed out waiting for ${path}.`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  return waitForFile(path, attemptsRemaining - 1);
}

async function waitForExit(child: ChildProcess, killed = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!killed) expect(child.exitCode).toBe(0);
    children.delete(child);
    return;
  }

  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for fixture process.")), 10_000),
    ),
  ]);
  children.delete(child);
  if (killed) expect(result.signal).toBe("SIGKILL");
  else expect(result.code, await childStderr(child)).toBe(0);
}

async function childStderr(child: ChildProcess): Promise<string> {
  const chunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return Buffer.concat(chunks).toString("utf8");
}

async function boundedDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function barrierPaths(directory: string, name: string) {
  return {
    acquired: join(directory, `${name}.acquired`),
    attempted: join(directory, `${name}.attempted`),
    release: join(directory, `${name}.release`),
    result: join(directory, `${name}.result`),
  };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
