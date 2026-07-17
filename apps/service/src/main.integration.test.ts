import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serviceRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];
const activeProcesses = new Set<ServiceProcess>();

afterEach(async () => {
  try {
    await Promise.allSettled([...activeProcesses].map((process) => process.stop()));
  } finally {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe.sequential("real Bun service entrypoints", () => {
  it("serves health endpoints and shuts down cleanly on SIGTERM", async () => {
    const fixture = await createMigratedFixture();
    const process = await startHealthyService(fixture);

    const dbHealth = await fetch(`${fixture.origin}/health/db`);
    expect(dbHealth.status).toBe(200);
    await expect(dbHealth.json()).resolves.toEqual({ ok: true });

    const unauthenticated = await fetch(`${fixture.origin}/api/mailings`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({
      error: { code: "unauthenticated", message: "Authentication required." },
    });

    process.child.kill("SIGTERM");
    const exit = await process.waitForExit(5_000);
    expect(exit).toEqual({ code: 0, signal: null });
  }, 30_000);

  it("enforces the 2 MiB Bun request-body boundary and remains healthy", async () => {
    const fixture = await createMigratedFixture();
    await startHealthyService(fixture);

    const overLimit = await postActivationBody(fixture.origin, 2 * 1024 * 1024 + 1);
    expect(overLimit.status).toBe(413);

    const underLimit = await postActivationBody(fixture.origin, 2 * 1024 * 1024 - 1);
    expect(underLimit.status).toBe(403);
    expect(underLimit.body).toContain("Invalid activation token");

    await expect(
      fetch(`${fixture.origin}/health`).then((response) => response.json()),
    ).resolves.toEqual({ ok: true, service: "nusend" });
  }, 30_000);

  it("drains a partial in-flight request before disposing and exiting", async () => {
    const fixture = await createMigratedFixture();
    const process = await startHealthyService(fixture);

    const body = "code=ABCD-2345&action=approve&csrf=missing";
    const splitAt = "code=".length;
    const events: Record<string, number> = {};
    const responsePromise = new Promise<{ body: string; status: number }>((resolve, reject) => {
      const outgoing = request(
        `${fixture.origin}/cli/activate`,
        {
          headers: {
            "content-length": Buffer.byteLength(body),
            "content-type": "application/x-www-form-urlencoded",
            expect: "100-continue",
            origin: fixture.origin,
          },
          method: "POST",
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on("end", () => {
            events.complete = performance.now();
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              status: incoming.statusCode ?? 0,
            });
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.on("socket", (socket) => {
        socket.once("connect", () => {
          events.connected = performance.now();
        });
      });
      outgoing.on("continue", () => {
        outgoing.write(body.slice(0, splitAt), () => {
          events.sigterm = performance.now();
          process.child.kill("SIGTERM");
          outgoing.end(body.slice(splitAt));
        });
      });
      outgoing.flushHeaders();
    });

    const response = await withTimeout(responsePromise, 12_000, "partial request completion");
    const exit = await process.waitForExit(12_000);
    events.exit = performance.now();

    expect(response.status).toBe(403);
    expect(response.body).toContain("Invalid activation token");
    expect(events.connected).toBeLessThan(events.sigterm!);
    expect(events.sigterm).toBeLessThan(events.complete!);
    expect(events.complete).toBeLessThan(events.exit!);
    expect(events.complete! - events.sigterm!).toBeLessThan(10_000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(`${process.stdout}\n${process.stderr}`).not.toMatch(
      /closed database|database is closed/i,
    );
  }, 30_000);

  it.each([
    { args: ["src/main.ts"], label: "service", forbidden: "Nusend service listening" },
    {
      args: ["src/sending/worker-main.ts", "once"],
      label: "worker",
      forbidden: '"claimed"',
    },
  ])(
    "refuses to start the $label against a stale schema",
    async ({ args, forbidden }) => {
      const fixture = await createServiceFixture(false);

      const process = startBun(args, fixture.env);
      const exit = await process.waitForExit(10_000);
      const output = `${process.stdout}\n${process.stderr}`;

      expect(exit.code).not.toBe(0);
      expect(output).toMatch(/pending migration/i);
      expect(output).toContain("db:migrate");
      expect(output).not.toContain(forbidden);
    },
    30_000,
  );
});

type ServiceFixture = {
  readonly env: NodeJS.ProcessEnv;
  origin: string;
};

async function createMigratedFixture(): Promise<ServiceFixture> {
  return createServiceFixture(true);
}

async function createServiceFixture(migrateDatabase: boolean): Promise<ServiceFixture> {
  const directory = mkdtempSync(join(tmpdir(), "nusend-main-integration-"));
  temporaryDirectories.push(directory);
  const port = await allocatePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BETTER_AUTH_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    BETTER_AUTH_URL: origin,
    GOOGLE_CLIENT_ID: "smoke-client-id",
    GOOGLE_CLIENT_SECRET: "smoke-client-secret",
    NUSEND_API_KEY_HASH_SECRET: "api-key-hash-secret-value-32-chars",
    AWS_REGION: "us-east-1",
    NUSEND_DB_PATH: join(directory, "smoke.sqlite"),
    NUSEND_SES_FROM_EMAIL: "sender@example.com",
    NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "transactional-set",
    NUSEND_HOST: "127.0.0.1",
    NUSEND_PORT: String(port),
    NUSEND_SES_REQUEST_TIMEOUT_MS: "1000",
    NUSEND_SEND_WORKER_LEASE_SECONDS: "30",
  };
  if (migrateDatabase) {
    const migrate = spawnSync("bun", ["src/db/migrate.ts", "up"], {
      cwd: serviceRoot,
      encoding: "utf8",
      env,
    });
    expect(migrate.status, `${migrate.stdout}\n${migrate.stderr}`).toBe(0);
  }
  return { env, origin };
}

function startBun(args: readonly string[], env: NodeJS.ProcessEnv): ServiceProcess {
  const child = spawn("bun", [...args], { cwd: serviceRoot, env, stdio: "pipe" });
  const process = new ServiceProcess(child);
  activeProcesses.add(process);
  void process.exit.then(() => activeProcesses.delete(process));
  return process;
}

class ServiceProcess {
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  spawnError: Error | null = null;
  stderr = "";
  stdout = "";

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (this.stdout = appendBounded(this.stdout, chunk)));
    child.stderr.on("data", (chunk: string) => (this.stderr = appendBounded(this.stderr, chunk)));
    this.exit = new Promise((resolve) => {
      let settled = false;
      child.once("error", (error) => {
        this.spawnError = error;
        if (!settled) {
          settled = true;
          resolve({ code: null, signal: null });
        }
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          resolve({ code, signal });
        }
      });
    });
  }

  waitForExit(timeoutMs: number) {
    return withTimeout(
      this.exit,
      timeoutMs,
      `process exit\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`,
    );
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    try {
      await this.waitForExit(2_000);
    } catch {
      this.child.kill("SIGKILL");
      await this.waitForExit(2_000).catch(() => undefined);
    }
  }
}

async function startHealthyService(fixture: ServiceFixture): Promise<ServiceProcess> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const process = startBun(["src/main.ts"], fixture.env);
    try {
      await waitForHealth(fixture.origin, process);
      return process;
    } catch (error) {
      lastError = error;
      await process.stop();
      if (!`${process.stdout}\n${process.stderr}`.includes("EADDRINUSE")) throw error;
      const port = await allocatePort();
      fixture.origin = `http://127.0.0.1:${port}`;
      fixture.env.NUSEND_PORT = String(port);
      fixture.env.BETTER_AUTH_URL = fixture.origin;
    }
  }
  throw lastError;
}

async function waitForHealth(origin: string, process: ServiceProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.spawnError || process.child.exitCode !== null) {
      throw new Error(
        `Service exited before readiness: ${process.spawnError?.message ?? "process exit"}.\n${process.stdout}\n${process.stderr}`,
      );
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Service did not become healthy.\n${process.stdout}\n${process.stderr}`);
}

async function postActivationBody(
  origin: string,
  byteLength: number,
): Promise<{ readonly body: string; readonly status: number }> {
  const prefix = "code=ABCD-2345&action=approve&csrf=missing&padding=";
  const body = prefix + "x".repeat(byteLength - Buffer.byteLength(prefix));
  expect(Buffer.byteLength(body)).toBe(byteLength);

  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const outgoing = request(
      `${origin}/cli/activate`,
      {
        headers: {
          "content-length": byteLength,
          "content-type": "application/x-www-form-urlencoded",
          expect: "100-continue",
          origin,
          referer: `${origin}/cli/activate?code=ABCD-2345`,
        },
        method: "POST",
      },
      (incoming) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: incoming.statusCode ?? 0,
          }),
        );
        incoming.on("error", (error) => {
          if ((incoming.statusCode ?? 0) === 413) resolve({ body: "", status: 413 });
          else reject(error);
        });
      },
    );
    outgoing.on("continue", () => outgoing.end(body));
    outgoing.on("error", (error) => {
      if (!responseStarted) reject(error);
    });
    outgoing.flushHeaders();
  });
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a loopback port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  const maximumCharacters = 64 * 1024;
  const combined = current + chunk;
  return combined.length <= maximumCharacters ? combined : combined.slice(-maximumCharacters);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
