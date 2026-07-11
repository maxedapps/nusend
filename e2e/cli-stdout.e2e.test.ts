// Regression for the CLI stdout-truncation bug: the entry used process.exit(),
// which discards buffered stdout writes and truncates large piped --json output
// under Node (the CLI's real runtime — `#!/usr/bin/env node`). This builds the
// shipped dist and spawns it under node with a piped stdout and a >64 KB
// response, asserting the whole document arrives and the process exits cleanly.
// (Must run the built dist under node: bun flushes stdio on exit and would mask
// the bug.)
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = fileURLToPath(new URL("../apps/cli/dist/main.js", import.meta.url));

let server: http.Server | null = null;

beforeAll(() => {
  // Build the contract + CLI so the test exercises the real shipped artifact.
  execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "ignore" });
}, 120_000);

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

describe("CLI stdout", () => {
  it("does not truncate large piped --json output and exits cleanly", async () => {
    const items = Array.from({ length: 2000 }, (_, index) => ({
      createdAt: "2026-07-09T00:00:00.000Z",
      email: `user${index}@example.com`,
      id: `contact_${index}`,
      updatedAt: "2026-07-09T00:00:00.000Z",
    }));
    const body = JSON.stringify({
      items,
      pagination: { limit: 2000, nextOffset: null, offset: 0 },
    });

    server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(body);
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    const child = spawn(
      "node",
      [cliEntry, "--json", "--base-url", `http://127.0.0.1:${port}`, "contacts", "list"],
      { cwd: repoRoot, env: { ...process.env, NUSEND_API_KEY: "test-key", XDG_CONFIG_HOME: "" } },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI did not exit within 15s"));
      }, 15_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    expect(stderr, stderr).toBe("");
    expect(exitCode).toBe(0);
    // >64 KB (the pipe buffer that process.exit() truncated at).
    expect(stdout.length).toBeGreaterThan(64 * 1024);
    const parsed = JSON.parse(stdout) as { items: unknown[] };
    expect(parsed.items).toHaveLength(2000);
  });
});
