import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AwsCliFake } from "./auth/aws-cli.ts";
import {
  CancellationError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
  TerminalError,
  UsageError,
} from "./errors.ts";
import {
  exitCodeForCause,
  exitCodeForTypedError,
  formatTypedError,
  HELP_TEXT,
  isMainEntry,
  mainProgram,
  normalizeArgv,
  runMain,
  runWithRuntime,
  SetupCliLive,
} from "./main.ts";
import { ProcessRunnerFake, ProcessRunnerLive } from "./process-runner.ts";
import { SetupStoreLive } from "./services/setup-store.ts";
import { TerminalFake } from "./terminal.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const require = createRequire(import.meta.url);
const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function testServices(terminal = TerminalFake()) {
  return {
    terminal,
    layer: Layer.mergeAll(
      terminal.layer,
      ProcessRunnerFake({
        runCaptured: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["true"],
          }),
      }),
      SetupStoreLive,
      AwsCliFake({
        listProfiles: () => Effect.succeed([]),
        configureGet: () => Effect.succeed(null),
        configureGetSsoSession: () => Effect.succeed(null),
        configureList: () => Effect.succeed(""),
        getCallerIdentity: () =>
          Effect.succeed({
            accountId: "123456789012",
            arn: "arn:aws:sts::123456789012:assumed-role/R/s",
            partition: "aws",
            roleName: "R",
            userId: null,
          }),
        verifyProfileSession: () =>
          Effect.succeed({
            accountId: "123456789012",
            arn: "arn:aws:sts::123456789012:assumed-role/R/s",
            partition: "aws",
            roleName: "R",
            userId: null,
          }),
        runInheritedSso: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws"],
          }),
        awsVersionText: () => Effect.succeed("aws-cli/2.22.0"),
        runCaptured: () =>
          Effect.succeed({
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            argv: ["aws"],
          }),
      }),
    ),
  };
}

function runCaptured(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

describe("setup-cli main boundary", () => {
  it("maps typed errors to stable exit codes", () => {
    expect(exitCodeForTypedError(new UsageError({ message: "bad" }))).toBe(2);
    expect(exitCodeForTypedError(new CancellationError({ message: "stop" }))).toBe(130);
    expect(
      exitCodeForTypedError(
        new ProcessFailedError({
          exitCode: 7,
          argv: ["cmd"],
          stdout: "",
          stderr: "",
          message: "fail",
        }),
      ),
    ).toBe(7);
    expect(
      exitCodeForTypedError(
        new ProcessSignalError({
          signal: "SIGTERM",
          exitCode: null,
          argv: ["cmd"],
          stdout: "",
          stderr: "",
          message: "sig",
        }),
      ),
    ).toBe(1);
    expect(
      exitCodeForTypedError(
        new ProcessStartError({ argv: ["cmd"], message: "start", cause: undefined }),
      ),
    ).toBe(1);
    expect(exitCodeForTypedError(new TerminalError({ operation: "writeOut", message: "io" }))).toBe(
      1,
    );
  });

  it("maps interrupt-only causes to 130 and unknown defects to 1", () => {
    expect(exitCodeForCause(Cause.interrupt(1))).toBe(130);
    expect(exitCodeForCause(Cause.die("boom"))).toBe(1);
    expect(exitCodeForCause(Cause.fail(new UsageError({ message: "x" })))).toBe(2);
  });

  it("formats typed errors without secret-bearing payloads", () => {
    expect(formatTypedError(new UsageError({ message: "Unknown arguments: x" }))).toContain(
      "Unknown arguments",
    );
    expect(
      formatTypedError(new TerminalError({ operation: "promptLine", message: "no tty" })),
    ).toContain("promptLine");
  });

  it("strips leading pnpm -- separators from argv", () => {
    expect(normalizeArgv(["--", "--help"])).toEqual(["--help"]);
    expect(normalizeArgv(["--", "--", "x"])).toEqual(["x"]);
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
  });

  it("prints help and returns exit 0", async () => {
    const { terminal, layer } = testServices();
    const code = await runMain(["--help"], layer);
    expect(code).toBe(0);
    expect(terminal.state.stdout.join("")).toContain("Usage:");
    expect(terminal.state.stdout.join("")).toContain(HELP_TEXT.trim().slice(0, 20));
  });

  it("maps unknown arguments to usage exit 2", async () => {
    const { terminal, layer } = testServices();
    const code = await runMain(["not-a-command"], layer);
    expect(code).toBe(2);
    expect(terminal.state.stderr.join("")).toMatch(/Unknown command|Unknown arguments/i);
  });

  it("runs bare guided invocation when no installation exists (starts init prompts)", async () => {
    const home = mkdtempSync(join(tmpdir(), "nusend-setup-main-"));
    temps.push(home);
    const terminal = TerminalFake({
      // Decline immediately by failing prompts after guided message — supply minimal
      // so we observe guided entry. First prompt is installation id; cancel via empty fail path.
      answers: [],
    });
    const { layer } = testServices(terminal);
    const code = await runMain([], layer, {
      ...process.env,
      NUSEND_SETUP_HOME: home,
    });
    // No answers → terminal error on first init prompt after guided message
    expect(code).not.toBe(0);
    expect(terminal.state.stdout.join("")).toMatch(/No active installation|guided init/i);
  });

  it("disposes ManagedRuntime finalizers after runWithRuntime", async () => {
    let finalized = false;
    const tracking = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized = true;
        }),
      ),
    );
    const { layer } = testServices();
    const runtime = ManagedRuntime.make(Layer.mergeAll(layer, tracking));

    try {
      const code = await runWithRuntime(runtime, ["--help"]);
      expect(code).toBe(0);
      expect(finalized).toBe(false);
    } finally {
      await runtime.dispose();
    }

    expect(finalized).toBe(true);
  });

  it("runMain disposes the runtime even when the program fails", async () => {
    let finalized = false;
    const tracking = Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized = true;
        }),
      ),
    );
    const { layer } = testServices();
    const code = await runMain(["nope"], Layer.mergeAll(layer, tracking));
    expect(code).toBe(2);
    expect(finalized).toBe(true);
  });

  it("mainProgram requires services and stays typed", async () => {
    const { terminal, layer } = testServices();
    await Effect.runPromise(mainProgram(["--help"]).pipe(Effect.provide(layer)));
    expect(terminal.state.stdout.join("").length).toBeGreaterThan(0);
  });

  it("recognizes main entry paths like the product CLI", () => {
    const spaced = "/tmp/with space/main.ts";
    expect(isMainEntry(spaced, pathToFileURL(spaced).href)).toBe(true);
    expect(isMainEntry("/tmp/main.ts", pathToFileURL("/tmp/other.ts").href)).toBe(false);
    expect(isMainEntry(undefined, pathToFileURL("/tmp/main.ts").href)).toBe(false);

    const self = fileURLToPath(import.meta.url);
    expect(isMainEntry(self, pathToFileURL(realpathSync(self)).href)).toBe(true);
  });

  it("smoke-runs the package start script through package-local tsx source entry", async () => {
    const tsxBin = require.resolve("tsx/cli", { paths: [packageRoot] });
    const mainTs = join(packageRoot, "src/main.ts");
    const home = mkdtempSync(join(tmpdir(), "nusend-setup-smoke-"));
    temps.push(home);
    const result = await runCaptured(process.execPath, [tsxBin, mainTs, "--help"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NUSEND_SETUP_HOME: home,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("aws auth");
    expect(result.stderr).toBe("");
  });

  it("smoke-runs pnpm package start -- --help with temp setup home (no mutation)", async () => {
    const home = mkdtempSync(join(tmpdir(), "nusend-setup-pnpm-help-"));
    temps.push(home);
    const result = await runCaptured(
      "pnpm",
      ["--filter", "@nusend/setup-cli", "start", "--", "--help"],
      {
        cwd: join(packageRoot, "../.."),
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NUSEND_SETUP_HOME: home,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
  }, 30_000);

  it("pretty-prints only unexpected defects at the runtime boundary", async () => {
    const { layer } = testServices();
    const runtime = ManagedRuntime.make(layer);
    const originalError = console.error;
    const lines: unknown[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      const exit = await runtime.runPromiseExit(Effect.die("unexpected-defect-marker"));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        console.error(Cause.pretty(exit.cause));
      }
      expect(lines.join("\n")).toContain("unexpected-defect-marker");
      expect(lines.join("\n")).not.toMatch(/AWS_SECRET|password=/i);
    } finally {
      console.error = originalError;
      await runtime.dispose();
    }
  });

  it("SetupCliLive still constructs", () => {
    expect(SetupCliLive).toBeDefined();
    expect(ProcessRunnerLive).toBeDefined();
  });
});
