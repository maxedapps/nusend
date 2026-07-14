#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const localStateUrl = new URL("../dist/config/local-state.js", import.meta.url);

if (process.argv[2] === "--child") {
  await runChild(process.argv.slice(3));
} else {
  await runParent();
}

async function runChild([root, identity, acquiredPath, releasePath, contendedPath]) {
  if (!root || !identity) throw new Error("Missing overlap-smoke child arguments.");
  const { updateConfig } = await import(localStateUrl.href);
  await updateConfig(
    (current) => ({
      ...current,
      profiles: {
        ...(current.profiles ?? {}),
        [identity]: { baseUrl: `https://${identity}.example.com` },
      },
    }),
    { XDG_CONFIG_HOME: root },
    {
      afterLockAcquired: acquiredPath
        ? async () => {
            await writeFile(acquiredPath, identity);
            await waitForFile(releasePath, 5_000);
          }
        : undefined,
      afterLockContention: contendedPath
        ? async () => {
            await writeFile(contendedPath, identity);
          }
        : undefined,
    },
  );
}

async function runParent() {
  const root = await mkdtemp(join(tmpdir(), "nusend-node-built-overlap-"));
  const holderAcquired = join(root, "holder-acquired");
  const holderRelease = join(root, "holder-release");
  const contenderContended = join(root, "contender-contended");
  const children = new Set();
  try {
    const holder = spawnChild([root, "node-holder", holderAcquired, holderRelease, ""], children);
    await waitForFile(holderAcquired, 3_000);
    const contender = spawnChild([root, "node-contender", "", "", contenderContended], children);
    // This is emitted only after the built module's link() observed EEXIST.
    await waitForFile(contenderContended, 3_000);
    await writeFile(holderRelease, "release");
    await Promise.all([
      waitForChild(holder, children, 8_000),
      waitForChild(contender, children, 8_000),
    ]);

    const directory = join(root, "nusend");
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    for (const identity of ["node-holder", "node-contender"]) {
      if (config.profiles?.[identity]?.baseUrl !== `https://${identity}.example.com`) {
        throw new Error(`Missing built-module profile ${identity}.`);
      }
    }
    const artifacts = (await readdir(directory)).filter(
      (entry) => entry.includes("local-state") || entry.includes(".tmp-"),
    );
    if (artifacts.length > 0) throw new Error(`Leftover artifacts: ${artifacts.join(", ")}`);
    if (process.platform !== "win32") {
      if (((await stat(directory)).mode & 0o777) !== 0o700) {
        throw new Error("Built-module directory mode is not 0700.");
      }
      if (((await stat(join(directory, "config.json"))).mode & 0o777) !== 0o600) {
        throw new Error("Built-module config mode is not 0600.");
      }
    }
    console.log("node built local-state overlap smoke ok");
  } finally {
    await Promise.all([...children].map((child) => terminateAndWait(child)));
    await rm(root, { force: true, recursive: true });
  }
}

function spawnChild(args, children) {
  const child = spawn(process.execPath, [scriptPath, "--child", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function waitForChild(child, children, timeoutMs) {
  let timeout;
  const timeoutResult = new Promise((resolve) => {
    timeout = setTimeout(() => resolve("TimedOut"), timeoutMs);
  });
  try {
    const result = await Promise.race([once(child, "exit"), timeoutResult]);
    if (result === "TimedOut") {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
      throw new Error(`Child ${child.pid ?? "unknown"} timed out.`);
    }
    children.delete(child);
    const [code, signal] = result;
    const [stdout, stderr] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
    ]);
    if (code !== 0 || signal !== null) {
      throw new Error(`Child failed: code=${code} signal=${signal}\n${stdout}\n${stderr}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function terminateAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Child ${child.pid ?? "unknown"} did not exit.`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([once(child, "exit"), timedOut]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded polling coordinates real processes.
      await access(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling coordinates real processes.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function readStream(stream) {
  if (!stream) return "";
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
