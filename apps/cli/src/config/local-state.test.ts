import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { FileCredentialStore } from "../credentials/file-store.js";
import { acquireLocalStateLock, updateConfig, type LocalStateLockOptions } from "./local-state.js";
import {
  configDirectory,
  configPath,
  credentialsPath,
  localStateLockPath,
  localStateReaperMutexPath,
} from "./paths.js";
import { loadConfig } from "./profiles.js";

const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();
const fixturePath = fileURLToPath(new URL("../testing/local-state-subprocess.ts", import.meta.url));

afterEach(async () => {
  await Promise.all([...children].map((child) => terminateAndWaitForChild(child)));
  children.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI local-state lock", () => {
  it("coordinates overlapping profile subprocess writers without dropping either map", async () => {
    const env = await tempEnv("profiles");

    await runOverlappingWriters("profiles", env.XDG_CONFIG_HOME!, "alpha", "beta");

    const profiles = (await loadConfig(env)).profiles ?? {};
    expect(Object.keys(profiles)).toHaveLength(40);
    for (const identity of ["alpha", "beta"]) {
      for (let index = 0; index < 20; index += 1) {
        expect(profiles[`${identity}-${index}`]?.baseUrl).toBe(
          `https://${identity}-${index}.example.com`,
        );
      }
    }
  });

  it("coordinates overlapping credential subprocess writers without dropping either map", async () => {
    const env = await tempEnv("credentials");

    await runOverlappingWriters("credentials", env.XDG_CONFIG_HOME!, "first", "second");

    const store = new FileCredentialStore(env);
    await Promise.all(
      ["first", "second"].flatMap((identity) =>
        Array.from({ length: 20 }, (_, index) =>
          expect(store.read(`${identity}-${index}`)).resolves.toMatchObject({
            apiKey: `nusend_${identity}_${index}`,
          }),
        ),
      ),
    );
  });

  it("serializes same-profile login state so the last lock owner wins both files", async () => {
    const env = await tempEnv("login");

    await runOverlappingWriters("login", env.XDG_CONFIG_HOME!, "first", "second");

    await expect(loadConfig(env)).resolves.toMatchObject({
      profiles: { shared: { baseUrl: "https://second.example.com" } },
    });
    await expect(new FileCredentialStore(env).read("shared")).resolves.toMatchObject({
      apiKey: "nusend_second",
    });
  });

  it("recovers a sufficiently old dead same-host owner and cleans candidates/tombstones", async () => {
    const env = await tempEnv("dead-owner");
    const lockPath = localStateLockPath(env);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeOwner(lockPath, {
      createdAt: Date.now() - 10_000,
      host: hostname(),
      pid: 2_147_483_647,
      token: "dead-token",
      version: 1,
    });

    const release = await acquireLocalStateLock(env);
    await release();

    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(configDirectory(env))).filter(isLockArtifact)).toEqual([]);
  });

  it("never steals a live owner and returns the stable contention error after the production timeout", async () => {
    const env = await tempEnv("live-owner");
    const lockPath = localStateLockPath(env);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeOwner(lockPath, {
      createdAt: Date.now() - 10_000,
      host: hostname(),
      pid: process.pid,
      token: "live-token",
      version: 1,
    });
    const started = Date.now();

    await expect(acquireLocalStateLock(env)).rejects.toThrow(
      "Nusend local state is busy; another CLI process holds the lock.",
    );

    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: "live-token" });
  }, 7_000);

  it.each([
    [
      "foreign-host",
      (): string | Record<string, unknown> => ({
        createdAt: Date.now() - 10_000,
        host: "another-host",
        pid: 2_147_483_647,
        token: "x",
        version: 1,
      }),
    ],
    ["malformed", (): string | Record<string, unknown> => "not-json"],
    [
      "young-dead",
      (): string | Record<string, unknown> => ({
        createdAt: Date.now(),
        host: hostname(),
        pid: 2_147_483_647,
        token: "young",
        version: 1,
      }),
    ],
  ] as const)("fails closed for a %s lock", async (_label, makeUnsafeOwner) => {
    const env = await tempEnv("unsafe-owner");
    const lockPath = localStateLockPath(env);
    const owner = makeUnsafeOwner();
    const contents = typeof owner === "string" ? owner : JSON.stringify(owner);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, contents, { mode: 0o600 });

    await expect(acquireLocalStateLock(env, quickLockOptions())).rejects.toThrow(
      "Nusend local state is busy; another CLI process holds the lock.",
    );
    await expect(readFile(lockPath, "utf8")).resolves.toBe(contents);
  });

  it("fails closed with operator guidance for an orphaned reaper mutex", async () => {
    const env = await tempEnv("orphaned-reaper");
    const lockPath = localStateLockPath(env);
    const mutexPath = localStateReaperMutexPath(env);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeOwner(lockPath, {
      createdAt: Date.now() - 10_000,
      host: hostname(),
      pid: 2_147_483_647,
      token: "dead-token",
      version: 1,
    });
    await mkdir(mutexPath);
    await writeFile(join(mutexPath, "owner.json"), "malformed");

    await expect(acquireLocalStateLock(env, quickLockOptions())).rejects.toThrow(
      /reaper mutex.*operator/i,
    );
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: "dead-token" });
  });

  it("blocks publication while an active protocol mutex owns a missing lock path", async () => {
    const env = await tempEnv("active-mutex");
    let signalMutexAcquired!: () => void;
    let releaseMutex!: () => void;
    const mutexAcquired = new Promise<void>((resolve) => {
      signalMutexAcquired = resolve;
    });
    const mutexGate = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    const firstAcquisition = acquireLocalStateLock(env, {
      timeoutMs: 2_000,
      testHooks: {
        afterMutexAcquired: async (purpose) => {
          if (purpose !== "publish") return;
          signalMutexAcquired();
          await mutexGate;
        },
      },
    });
    await mutexAcquired;
    await expect(access(localStateLockPath(env))).rejects.toMatchObject({ code: "ENOENT" });

    let signalMutexContention!: () => void;
    let signalLockContention!: () => void;
    const mutexContention = new Promise<void>((resolve) => {
      signalMutexContention = resolve;
    });
    const lockContention = new Promise<void>((resolve) => {
      signalLockContention = resolve;
    });
    const secondAcquisition = acquireLocalStateLock(env, {
      timeoutMs: 2_000,
      testHooks: {
        afterLockContention: async () => signalLockContention(),
        afterMutexContention: async (purpose) => {
          if (purpose === "publish") signalMutexContention();
        },
      },
    });
    await mutexContention;
    await expect(access(localStateLockPath(env))).rejects.toMatchObject({ code: "ENOENT" });

    releaseMutex();
    const releaseFirst = await firstAcquisition;
    await lockContention;
    await releaseFirst();
    const releaseSecond = await secondAcquisition;
    await releaseSecond();

    expect((await readdir(configDirectory(env))).filter(isLockArtifact)).toEqual([]);
  });

  it.each(["missing-owner", "malformed-owner", "dead-owner"] as const)(
    "fails closed for a %s mutex while the canonical lock is missing",
    async (kind) => {
      const env = await tempEnv(`missing-lock-${kind}-mutex`);
      const mutexPath = localStateReaperMutexPath(env);
      await mkdir(mutexPath, { recursive: true });
      if (kind === "malformed-owner") {
        await writeFile(join(mutexPath, "owner.json"), "malformed");
      } else if (kind === "dead-owner") {
        await writeOwner(join(mutexPath, "owner.json"), {
          createdAt: Date.now() - 10_000,
          host: hostname(),
          pid: 2_147_483_647,
          token: "dead-mutex-owner",
          version: 1,
        });
      }

      await expect(acquireLocalStateLock(env, quickLockOptions())).rejects.toThrow(
        /reaper mutex.*operator/i,
      );
      await expect(access(localStateLockPath(env))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves a reaper tombstone when mutex release fails", async () => {
    const env = await tempEnv("reaper-release-failure");
    await mkdir(configDirectory(env), { recursive: true });
    await writeOwner(localStateLockPath(env), {
      createdAt: Date.now() - 10_000,
      host: hostname(),
      pid: 2_147_483_647,
      token: "dead-owner",
      version: 1,
    });

    await expect(
      acquireLocalStateLock(env, {
        timeoutMs: 500,
        testHooks: {
          beforeMutexRelease: async (purpose) => {
            if (purpose === "reap") throw new Error("injected mutex release failure");
          },
        },
      }),
    ).rejects.toThrow(/reaper mutex.*operator/i);

    await expect(access(localStateLockPath(env))).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(configDirectory(env))).filter((entry) => entry.includes("reap-tombstone")),
    ).toHaveLength(1);
    await expect(stat(localStateReaperMutexPath(env))).resolves.toBeDefined();
  });

  it("returns release ownership after post-link candidate cleanup fails and later cleans it", async () => {
    const env = await tempEnv("candidate-cleanup");
    let injected = false;
    const release = await acquireLocalStateLock(env, {
      testHooks: {
        beforeCandidateCleanup: async ({ published }) => {
          if (published && !injected) {
            injected = true;
            throw new Error("injected candidate cleanup failure");
          }
        },
      },
    });
    expect(
      (await readdir(configDirectory(env))).filter((entry) => entry.includes(".candidate-")),
    ).toHaveLength(1);

    await release();

    await expect(access(localStateLockPath(env))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(configDirectory(env))).filter(isLockArtifact)).toEqual([]);
  });

  it("keeps directory and local-state files private on Unix", async () => {
    if (process.platform === "win32") return;
    const env = await tempEnv("modes");

    await updateConfig(
      () => ({ profiles: { default: { baseUrl: "https://mail.example.com" } } }),
      env,
    );
    await new FileCredentialStore(env).write("default", { apiKey: "nusend_secret" });
    const release = await acquireLocalStateLock(env);

    expect((await stat(configDirectory(env))).mode & 0o777).toBe(0o700);
    expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
    expect((await stat(credentialsPath(env))).mode & 0o777).toBe(0o600);
    expect((await stat(localStateLockPath(env))).mode & 0o777).toBe(0o600);

    await release();
  });

  it("preserves readable old JSON and removes the temp when failure occurs before rename", async () => {
    const env = await tempEnv("pre-rename");
    await updateConfig(() => ({ profiles: { old: { baseUrl: "https://old.example.com" } } }), env);

    await expect(
      updateConfig(
        () => ({ profiles: { replacement: { baseUrl: "https://new.example.com" } } }),
        env,
        {
          beforeRename: async () => {
            throw new Error("injected before rename");
          },
        },
      ),
    ).rejects.toThrow("injected before rename");

    await expect(loadConfig(env)).resolves.toEqual({
      profiles: { old: { baseUrl: "https://old.example.com" } },
    });
    expect(
      (await readdir(configDirectory(env))).filter((entry) => entry.includes(".tmp-")),
    ).toEqual([]);
  });

  it("restores an unfamiliar replacement introduced after release serialization", async () => {
    const env = await tempEnv("release-token");
    const lockPath = localStateLockPath(env);
    const release = await acquireLocalStateLock(env, {
      testHooks: {
        beforeReleaseRename: async () => {
          await unlink(lockPath);
          await writeOwner(lockPath, {
            createdAt: Date.now(),
            host: hostname(),
            pid: process.pid,
            token: "replacement-token",
            version: 1,
          });
        },
      },
    });

    await release();

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      token: "replacement-token",
    });
    expect(
      (await readdir(configDirectory(env))).filter((entry) => entry.includes("tombstone")),
    ).toEqual([]);
  });

  it("never deletes a replacement created after atomic release rename", async () => {
    const env = await tempEnv("release-window-replacement");
    const lockPath = localStateLockPath(env);
    const release = await acquireLocalStateLock(env, {
      testHooks: {
        afterReleaseRename: async () => {
          await writeOwner(lockPath, {
            createdAt: Date.now(),
            host: hostname(),
            pid: process.pid,
            token: "window-replacement",
            version: 1,
          });
        },
      },
    });

    await release();

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      token: "window-replacement",
    });
    expect(
      (await readdir(configDirectory(env))).filter((entry) => entry.includes("tombstone")),
    ).toEqual([]);
  });
});

async function tempEnv(label: string): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), `nusend-local-state-${label}-`));
  temporaryDirectories.push(root);
  return { XDG_CONFIG_HOME: root };
}

async function runOverlappingWriters(
  operation: "credentials" | "login" | "profiles",
  root: string,
  first: string,
  second: string,
): Promise<void> {
  const coordination = join(root, `coordination-${operation}`);
  await mkdir(coordination, { recursive: true });
  const firstAttempted = join(coordination, "first-attempted");
  const firstAcquired = join(coordination, "first-acquired");
  const firstRelease = join(coordination, "first-release");
  const secondAttempted = join(coordination, "second-attempted");
  const secondContended = join(coordination, "second-contended");
  const firstChild = spawnFixture([
    operation,
    root,
    first,
    firstAttempted,
    firstAcquired,
    firstRelease,
  ]);
  await waitForFile(firstAcquired, 3_000);
  const secondChild = spawnFixture([
    operation,
    root,
    second,
    secondAttempted,
    "",
    "",
    secondContended,
  ]);
  await waitForFile(secondAttempted, 3_000);
  // This marker is emitted from inside acquireLocalStateLock only after link()
  // returned EEXIST, proving the contender reached real lock contention.
  await waitForFile(secondContended, 3_000);
  await writeFile(firstRelease, "release");
  await Promise.all([waitForChild(firstChild, 8_000), waitForChild(secondChild, 8_000)]);
}

function spawnFixture(args: string[]): ChildProcess {
  const child = spawn("bun", [fixturePath, ...args], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function waitForChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutResult = new Promise<"TimedOut">((resolve) => {
    timeout = setTimeout(() => resolve("TimedOut"), timeoutMs);
  });
  try {
    const result = await Promise.race([once(child, "exit"), timeoutResult]);
    if (result === "TimedOut") {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
      children.delete(child);
      throw new Error(`Child ${child.pid ?? "unknown"} timed out.`);
    }
    children.delete(child);
    const [code, signal] = result as [number | null, NodeJS.Signals | null];
    const stdout = await readStream(child.stdout);
    const stderr = await readStream(child.stderr);
    expect({ code, signal, stderr, stdout }).toMatchObject({ code: 0, signal: null });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function terminateAndWaitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
  children.delete(child);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Child ${child.pid ?? "unknown"} did not exit after SIGKILL.`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([once(child, "exit"), timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded polling coordinates real processes.
      await access(path);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling coordinates real processes.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function writeOwner(path: string, owner: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function quickLockOptions(): LocalStateLockOptions {
  return { timeoutMs: 75 };
}

function isLockArtifact(entry: string): boolean {
  return entry.includes("local-state.lock.") || entry.includes("local-state-reaper");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
