// Boot smoke: real `bun src/main.ts` process — serve, health endpoints, auth
// envelope, SIGTERM → clean exit (runtime dispose closes the database).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("main boot smoke", () => {
  it("serves health endpoints and shuts down cleanly on SIGTERM", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nusend-boot-smoke-"));
    temporaryDirectories.push(directory);
    const port = 43000 + (process.pid % 1000);
    const env = {
      ...process.env,
      BETTER_AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
      BETTER_AUTH_URL: `http://localhost:${port}`,
      GOOGLE_CLIENT_ID: "smoke-client-id",
      GOOGLE_CLIENT_SECRET: "smoke-client-secret",
      NUSEND_DB_PATH: join(directory, "smoke.sqlite"),
      NUSEND_PORT: String(port),
    };

    const migrate = spawnSync("bun", ["src/db/migrate.ts", "up"], {
      cwd: serviceRoot,
      encoding: "utf8",
      env,
    });
    expect(migrate.status, migrate.stderr).toBe(0);

    const server = spawn("bun", ["src/main.ts"], { cwd: serviceRoot, env });
    const exited = new Promise<number | null>((resolve) => {
      server.on("exit", (code) => resolve(code));
    });

    try {
      const health = await pollJson(`http://localhost:${port}/health`);
      expect(health).toEqual({ ok: true, service: "nusend" });

      const dbHealth = await fetch(`http://localhost:${port}/health/db`);
      expect(dbHealth.status).toBe(200);
      await expect(dbHealth.json()).resolves.toEqual({ ok: true });

      const unauthenticated = await fetch(`http://localhost:${port}/api/mailings`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unauthenticated.status).toBe(401);
      await expect(unauthenticated.json()).resolves.toEqual({
        error: { code: "unauthenticated", message: "Authentication required." },
      });
    } finally {
      server.kill("SIGTERM");
    }

    await expect(exited).resolves.toBe(0);
  }, 30_000);
});

async function pollJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return Promise.reject(new Error(`Server at ${url} did not become healthy.`));
}
