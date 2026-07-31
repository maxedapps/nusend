import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AwsCliFake } from "../auth/aws-cli.ts";
import { ProcessRunnerFake } from "../process-runner.ts";
import { SetupStoreLive } from "../services/setup-store.ts";
import { TerminalFake } from "../terminal.ts";
import { runDoctor } from "./doctor.ts";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "nusend-setup-doctor-"));
  temps.push(home);
  return { ...process.env, NUSEND_SETUP_HOME: home };
}

const versions: Record<string, string> = {
  git: "git version 2.44.0",
  ssh: "OpenSSH_9.6p1",
  curl: "curl 8.6.0",
};

describe("runDoctor local binaries", () => {
  it("reports a missing pnpm as failing while present binaries still pass", async () => {
    const terminal = TerminalFake();
    const layer = Layer.mergeAll(
      SetupStoreLive,
      terminal.layer,
      ProcessRunnerFake({
        runCaptured: (options) =>
          options.command === "pnpm"
            ? Effect.succeed({
                exitCode: 1,
                signal: null,
                stdout: "",
                stderr: "not found",
                argv: ["pnpm", "--version"],
              })
            : Effect.succeed({
                exitCode: 0,
                signal: null,
                stdout: versions[options.command] ?? "",
                stderr: "",
                argv: [options.command],
              }),
      }),
      AwsCliFake({ awsVersionText: () => Effect.succeed("aws-cli/2.22.0") }),
    );

    const exit = await Effect.runPromiseExit(
      runDoctor({ env: tempEnv(), skipRemoteDoctorChecks: true }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const output = terminal.state.stdout.join("");
    expect(output).toMatch(/FAIL {2}pnpm/u);
    expect(output).toMatch(/ok {2}git/u);
  });
});
