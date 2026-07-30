import { Effect, Result } from "effect";

import {
  AwsCli,
  isAwsCliV2_22OrNewer,
  revalidateStoredAuth,
  type AwsCliService,
} from "../auth/index.ts";
import {
  AwsAuthError,
  CancellationError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
  SetupCommandError,
  SetupStoreError,
  TerminalError,
} from "../errors.ts";
import { ProcessRunner, type ProcessRunnerService } from "../process-runner.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { unwrapEnvValue, type DeploymentEnvMap } from "../state/env.ts";
import { assertReleaseTag, type SetupState } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import { writeLine } from "./prompts.ts";

type NoteFn = (
  name: string,
  ok: boolean,
  detail: string,
) => Effect.Effect<void, TerminalError, TerminalService>;

export type DoctorOptions = {
  readonly platform?: string;
  readonly nodeVersion?: string;
  readonly skipRemoteDoctorChecks?: boolean;
  readonly env?: NodeJS.ProcessEnv;
};

/**
 * Read-only doctor. Requires AWS CLI v2.22+. Uses sanitized SSO verification when bound.
 */
export function runDoctor(
  options: DoctorOptions = {},
): Effect.Effect<
  void,
  | SetupCommandError
  | SetupStoreError
  | AwsAuthError
  | CancellationError
  | TerminalError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError,
  SetupStoreService | TerminalService | ProcessRunnerService | AwsCliService
> {
  return Effect.gen(function* () {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const nodeVersion = options.nodeVersion ?? process.versions.node;
    const skipRemote = options.skipRemoteDoctorChecks ?? false;

    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const note: NoteFn = (name, ok, detail) =>
      Effect.gen(function* () {
        checks.push({ name, ok, detail });
        yield* writeLine(`${ok ? "ok" : "FAIL"}  ${name}: ${detail}`);
      });

    if (platform === "win32") {
      yield* note(
        "platform",
        false,
        "Native Windows is not supported. Use WSL (Ubuntu) and rerun from the Linux environment.",
      );
      return yield* Effect.fail(
        new SetupCommandError({ message: "doctor failed: use WSL on Windows." }),
      );
    }
    yield* note("platform", true, platform);

    const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0] ?? "0", 10);
    yield* note(
      "node",
      nodeMajor >= 22,
      nodeMajor >= 22 ? `Node ${nodeVersion}` : `Node ${nodeVersion} is too old; require Node 22+`,
    );

    yield* checkLocalBinary(note, "pnpm", ["pnpm", "--version"], /./u);
    yield* checkLocalBinary(note, "git", ["git", "--version"], /^git version\b/iu);
    yield* checkAwsCliV2_22(note);
    yield* checkLocalBinary(note, "ssh", ["ssh", "-V"], /OpenSSH|ssh/iu);
    yield* checkLocalBinary(note, "curl", ["curl", "--version"], /^curl\b/iu);

    const store = yield* SetupStore;
    let state: SetupState;
    let envMap: DeploymentEnvMap;
    const loaded = yield* store.resolveInstallationId(env).pipe(
      Effect.flatMap((installationId) =>
        Effect.gen(function* () {
          const s = yield* store.loadState(installationId, env);
          const e = yield* store.loadDeploymentEnv(installationId, env);
          return { installationId, state: s, envMap: e };
        }),
      ),
      Effect.result,
    );

    if (Result.isFailure(loaded)) {
      const message =
        loaded.failure instanceof Error ? loaded.failure.message : String(loaded.failure);
      yield* note("state", false, message);
      return yield* Effect.fail(
        new SetupCommandError({
          message: `doctor failed: setup is not initialized or state/env is unsafe.\n${message}\nRun init first.`,
        }),
      );
    }

    state = loaded.success.state;
    envMap = loaded.success.envMap;
    yield* note(
      "state",
      true,
      `installation ${loaded.success.installationId}; directory and state/env permissions accepted`,
    );

    const releaseCheck = yield* Effect.try({
      try: () => assertReleaseTag(state.config.releaseTag),
      catch: (error) => error,
    }).pipe(Effect.result);
    if (Result.isSuccess(releaseCheck)) {
      yield* note("release-tag", true, state.config.releaseTag);
    } else {
      yield* note(
        "release-tag",
        false,
        releaseCheck.failure instanceof Error
          ? releaseCheck.failure.message
          : String(releaseCheck.failure),
      );
    }

    const missingEnv = requiredEnvKeys(state).filter((key) => {
      const value = envMap[key];
      if (value == null) return true;
      return unwrapEnvValue(value).trim() === "";
    });
    const missingNow = missingEnv.filter(
      (key) =>
        key !== "AWS_ACCESS_KEY_ID" &&
        key !== "AWS_SECRET_ACCESS_KEY" &&
        key !== "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET" &&
        key !== "NUSEND_SES_MARKETING_CONFIGURATION_SET" &&
        key !== "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
    );
    yield* note(
      "deployment-env",
      missingNow.length === 0,
      missingNow.length === 0
        ? "required non-AWS values present"
        : `missing: ${missingNow.join(", ")}`,
    );

    yield* checkAwsCaller(note, state);
    yield* checkSshHostKeyPolicy(note, state);

    if (!skipRemote) {
      yield* checkRemoteDockerCompose(note, state);
    } else {
      yield* note("remote-git", true, "skipped in this run");
      yield* note("remote-docker", true, "skipped in this run");
      yield* note("remote-compose", true, "skipped in this run");
    }

    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `doctor failed (${failed.length} check(s)). Fix the FAIL items above and rerun.`,
        }),
      );
    }
    yield* writeLine("doctor: all checks passed (read-only).");
  });
}

function requiredEnvKeys(state: SetupState): string[] {
  const keys = [
    "NUSEND_DOMAIN",
    "NUSEND_INGRESS_MODE",
    "NUSEND_OWNER_EMAIL",
    "NUSEND_OWNER_NAME",
    "BETTER_AUTH_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "NUSEND_API_KEY_HASH_SECRET",
    "NUSEND_UNSUBSCRIBE_SECRET",
    "AWS_REGION",
    "NUSEND_SES_FROM_EMAIL",
    "NUSEND_RESTIC_REPOSITORY",
    "NUSEND_R2_ACCESS_KEY_ID",
    "NUSEND_R2_SECRET_ACCESS_KEY",
    "NUSEND_RESTIC_PASSWORD",
  ];
  if (state.config.marketingEnabled) keys.push("NUSEND_SES_MARKETING_CONFIGURATION_SET");
  return keys;
}

function checkLocalBinary(
  note: NoteFn,
  name: string,
  argv: readonly [string, ...string[]],
  pattern: RegExp,
): Effect.Effect<void, TerminalError, ProcessRunnerService | TerminalService> {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const result = yield* runner
      .runCaptured({
        command: argv[0],
        args: argv.slice(1),
        allowNonZero: true,
      })
      .pipe(
        Effect.catch(() =>
          Effect.succeed({
            exitCode: 1 as number | null,
            signal: null as NodeJS.Signals | null,
            stdout: "",
            stderr: "not found",
            argv: [...argv],
          }),
        ),
      );
    const text = `${result.stdout}\n${result.stderr}`;
    const matched = pattern.test(text);
    yield* note(
      name,
      matched || (result.exitCode === 0 && text.trim() !== ""),
      text.trim().split("\n")[0] ?? "present",
    );
  });
}

function checkAwsCliV2_22(
  note: NoteFn,
): Effect.Effect<void, TerminalError, AwsCliService | TerminalService> {
  return Effect.gen(function* () {
    const aws = yield* AwsCli;
    const text = yield* aws
      .awsVersionText()
      .pipe(
        Effect.catch((error) =>
          Effect.succeed(error instanceof Error ? error.message : String(error)),
        ),
      );
    const ok = isAwsCliV2_22OrNewer(text);
    yield* note(
      "aws-cli",
      ok,
      ok
        ? (text.split("\n")[0] ?? "aws-cli/2.22+")
        : `expected AWS CLI v2.22+, got: ${text || "missing"}`,
    );
  });
}

function checkAwsCaller(
  note: NoteFn,
  state: SetupState,
): Effect.Effect<void, TerminalError, AwsCliService | TerminalService> {
  return Effect.gen(function* () {
    if (state.schemaVersion !== 2) {
      yield* note(
        "aws-caller",
        false,
        "No SSO binding in state (schema v1). Run aws auth to bind a modern SSO profile.",
      );
      return;
    }

    const result = yield* revalidateStoredAuth(state, { promptForLogin: false }).pipe(
      Effect.result,
    );
    if (Result.isFailure(result)) {
      const err = result.failure;
      yield* note("aws-caller", false, err instanceof Error ? err.message : String(err));
      return;
    }
    const caller = result.success;
    const ok = caller.accountId === state.config.awsAccountId;
    yield* note(
      "aws-caller",
      ok,
      ok
        ? `account ${caller.accountId} region ${state.config.awsRegion} via profile ${state.awsAuth.profileName} (sso)`
        : `account mismatch: expected ${state.config.awsAccountId}, got ${caller.accountId}`,
    );
  });
}

function checkSshHostKeyPolicy(
  note: NoteFn,
  state: SetupState,
): Effect.Effect<void, TerminalError, ProcessRunnerService | TerminalService> {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const host = state.config.sshTarget.includes("@")
      ? (state.config.sshTarget.split("@").at(-1) ?? state.config.sshTarget)
      : state.config.sshTarget;
    const result = yield* runner.runCaptured({ command: "ssh", args: ["-G", host] }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          exitCode: 1 as number | null,
          signal: null as NodeJS.Signals | null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          argv: ["ssh", "-G", host],
        }),
      ),
    );
    if (result.exitCode !== 0) {
      yield* note("ssh-host-key", false, result.stderr || result.stdout || "ssh -G failed");
      return;
    }
    const match = /^stricthostkeychecking\s+(\S+)/imu.exec(result.stdout);
    const value = match?.[1]?.toLowerCase() ?? "";
    const ok = value === "yes" || value === "accept-new";
    yield* note(
      "ssh-host-key",
      ok,
      ok
        ? `StrictHostKeyChecking=${value}`
        : `StrictHostKeyChecking=${value || "unknown"} (require yes or accept-new)`,
    );
  });
}

function checkRemoteDockerCompose(
  note: NoteFn,
  state: SetupState,
): Effect.Effect<void, TerminalError, ProcessRunnerService | TerminalService> {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner;

    const git = yield* runner
      .runCaptured({
        command: "ssh",
        args: [state.config.sshTarget, "git", "--version"],
        allowNonZero: true,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            exitCode: 1 as number | null,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            signal: null as NodeJS.Signals | null,
            argv: ["ssh"],
          }),
        ),
      );
    {
      const text = `${git.stdout} ${git.stderr}`.trim();
      const ok = /^git version\b/iu.test(text);
      yield* note(
        "remote-git",
        ok,
        ok ? text : `expected Git, got: ${text || "no version output"}`,
      );
    }

    const docker = yield* runner
      .runCaptured({
        command: "ssh",
        args: [state.config.sshTarget, "docker", "version", "--format", "{{.Server.Version}}"],
        allowNonZero: true,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            exitCode: 1 as number | null,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            signal: null as NodeJS.Signals | null,
            argv: ["ssh"],
          }),
        ),
      );
    if (docker.exitCode === 0) {
      yield* note("remote-docker", true, `Docker ${docker.stdout.trim() || "ok"}`);
    } else {
      yield* note("remote-docker", false, docker.stderr || docker.stdout || "docker failed");
    }

    const compose = yield* runner
      .runCaptured({
        command: "ssh",
        args: [state.config.sshTarget, "docker", "compose", "version"],
        allowNonZero: true,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            exitCode: 1 as number | null,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            signal: null as NodeJS.Signals | null,
            argv: ["ssh"],
          }),
        ),
      );
    {
      const text = `${compose.stdout} ${compose.stderr}`;
      const versionMatch = /(\d+)\.(\d+)\.(\d+)/u.exec(text);
      let ok = false;
      let detail = text.trim();
      if (versionMatch) {
        const major = Number(versionMatch[1]);
        const minor = Number(versionMatch[2]);
        const patch = Number(versionMatch[3]);
        ok = major > 5 || (major === 5 && (minor > 3 || (minor === 3 && patch >= 0)));
        detail = `Compose ${major}.${minor}.${patch}${ok ? "" : " (require 5.3.0+)"}`;
      } else {
        detail = `could not parse Compose version from: ${text.trim()}`;
      }
      yield* note("remote-compose", ok, detail);
    }
  });
}
