import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Layer } from "effect";

import { sampleAwsAuth } from "../aws/test-harness.ts";
import { ProcessFailedError } from "../errors.ts";
import {
  ProcessRunnerFake,
  type ProcessResult,
  type ProcessRunnerError,
  type RunCapturedOptions,
} from "../process-runner.ts";
import { SetupStore, SetupStoreLive } from "../services/setup-store.ts";
import { TerminalFake } from "../terminal.ts";
import type { DeployWorkflowError, DeployWorkflowServices } from "./plan.ts";
import { buildOpenSshRemoteCommand } from "./pure.ts";
import { PUBLIC_REPO_URL } from "./constants.ts";
import { HUMAN_GATE_DEFINITIONS } from "./human-gates.ts";

export const temporaryDirectories: string[] = [];
export const PLANNED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export function testEnv(): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-cli-deploy-"));
  temporaryDirectories.push(directory);
  return {
    ...process.env,
    NUSEND_SETUP_HOME: directory,
    HOME: directory,
  };
}

export function cleanupTemps(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function ok(stdout: string, exitCode = 0, stderr = "", argv: string[] = []): ProcessResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    argv,
  };
}

export function sampleState(installationId: string) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 2 as const,
    installationId,
    createdAt: now,
    updatedAt: now,
    awsAuth: sampleAwsAuth(),
    config: {
      releaseTag: "v0.1.2",
      domain: "mail.example.com",
      ingressMode: "direct" as const,
      ownerEmail: "owner@example.com",
      ownerName: "Owner",
      awsProfile: "nusend-provisioner",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesIdentity: "example.com",
      sesFromEmail: "sender@example.com",
      marketingEnabled: false,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      installationName: installationId,
    },
    stages: {
      init: {
        status: "complete" as const,
        completedAt: now,
        evidence: { verified: true, installationId },
      },
    },
    plans: {},
  };
}

export async function seedInstallation(
  env: NodeJS.ProcessEnv,
  installationId: string,
  options: {
    awsCoreComplete?: boolean;
    humanGatesComplete?: boolean;
    productionAccessEnabled?: boolean;
  } = {},
) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      const base = sampleState(installationId) as ReturnType<typeof sampleState> & {
        stages: Record<string, unknown>;
        aws?: Record<string, unknown>;
      };
      if (options.awsCoreComplete) {
        base.stages.aws_core = {
          status: "complete",
          completedAt: "2026-01-02T00:00:00.000Z",
          evidence: { verified: true, stackId: "stack" },
        };
      }
      if (options.humanGatesComplete) {
        base.stages.human_gates = {
          status: "complete",
          completedAt: "2026-01-03T00:00:00.000Z",
          evidence: {
            verified: true,
            gates: HUMAN_GATE_DEFINITIONS.map((gate) => gate.id),
          },
        };
      }
      if (options.productionAccessEnabled) {
        base.aws = {
          productionAccess: {
            productionAccessEnabled: true,
            status: "granted",
            reviewStatus: "GRANTED",
          },
        };
      }
      yield* store.writeState(base as never, env);
      yield* store.writeDeploymentEnv(
        installationId,
        {
          NUSEND_DOMAIN: "mail.example.com",
          NUSEND_INGRESS_MODE: "direct",
          NUSEND_OWNER_EMAIL: "owner@example.com",
          NUSEND_OWNER_NAME: "Owner",
          BETTER_AUTH_SECRET: "better-auth-secret-value-xxxxxxxx",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret-value",
          NUSEND_API_KEY_HASH_SECRET: "api-key-hash-secret-value-xxxxxx",
          NUSEND_UNSUBSCRIBE_SECRET: "unsubscribe-secret-value-xxxxxx",
          AWS_ACCESS_KEY_ID: "AKIATESTACCESSKEY0001",
          AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-value-xxxx",
          AWS_REGION: "us-east-1",
          NUSEND_SES_FROM_EMAIL: "sender@example.com",
          NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "nusend-prod-transactional",
          NUSEND_SES_FEEDBACK_TOPIC_ARNS: "arn:aws:sns:us-east-1:123456789012:topic",
          NUSEND_RESTIC_REPOSITORY: "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
          NUSEND_R2_ACCESS_KEY_ID: "r2-access",
          NUSEND_R2_SECRET_ACCESS_KEY: "r2-secret-value-xxxxxx",
          NUSEND_RESTIC_PASSWORD: "restic-password-value-xxxxxx",
        },
        env,
      );
      yield* store.writeCurrentPointer(installationId, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

export function composeYamlFixture() {
  return [
    "name: nusend",
    "x-app-image: &app-image ghcr.io/maxedapps/nusend:v0.1.2",
    "x-backup-image: &backup-image ghcr.io/maxedapps/nusend-backup:v0.1.2",
    "services:",
    "  api:",
    "    image: *app-image",
    "  backup:",
    "    image: *backup-image",
  ].join("\n");
}

export function opensshJoinedRemote(argv: string[]) {
  if (argv[0] !== "ssh") return "";
  return argv.slice(2).join(" ");
}

export function assertOpenSshArgvShape(argv: string[]) {
  if (argv[0] !== "ssh") throw new Error(`expected ssh, got ${argv[0]}`);
  if (argv.length !== 3) throw new Error(`expected 3 argv, got ${argv.length}`);
  if (!String(argv[2]).startsWith("sh -c '")) throw new Error("expected sh -c quoted remote");
}

export function planExecutor(
  calls: Array<{ argv: string[]; stdin?: string }>,
  options: {
    pathMode?: "absent" | "empty" | "existing_git" | "nonempty_not_git";
    composeVersionText?: string;
    arch?: string;
    origin?: string;
    head?: string;
    dirty?: boolean;
    branch?: string;
    tagSha?: string;
    lsRemoteSha?: string;
  } = {},
) {
  return (runOptions: RunCapturedOptions): Effect.Effect<ProcessResult, ProcessRunnerError> =>
    Effect.gen(function* () {
      const argv = [runOptions.command, ...(runOptions.args ?? [])];
      calls.push({ argv, stdin: runOptions.stdin });
      const joined = argv.join(" ");
      const remote = opensshJoinedRemote(argv);
      const respond = (stdout: string, exitCode = 0, stderr = "") =>
        ok(stdout, exitCode, stderr, argv);

      const finish = (result: ProcessResult): Effect.Effect<ProcessResult, ProcessFailedError> => {
        if (result.exitCode !== 0 && !runOptions.allowNonZero) {
          return Effect.fail(
            new ProcessFailedError({
              exitCode: result.exitCode,
              argv,
              stdout: result.stdout,
              stderr: result.stderr,
              message: `Command failed (${result.exitCode}): ${argv.join(" ")}\n${result.stderr || result.stdout}`,
            }),
          );
        }
        return Effect.succeed(result);
      };

      if (runOptions.command === "git" && runOptions.args?.[0] === "ls-remote") {
        const sha = options.lsRemoteSha ?? PLANNED_SHA;
        return yield* finish(ok(`${sha}\trefs/tags/v0.1.2\n`, 0, "", argv));
      }

      if (runOptions.command !== "ssh") {
        return yield* Effect.die(new Error(`unexpected command: ${joined}`));
      }
      assertOpenSshArgvShape(argv);

      if (remote.includes("uname")) {
        return yield* finish(respond(`Linux\n${options.arch ?? "x86_64"}\n`));
      }
      if (remote.includes("docker version")) {
        return yield* finish(respond("27.0.0\n"));
      }
      if (remote.includes("docker compose version")) {
        return yield* finish(
          respond(options.composeVersionText ?? "Docker Compose version v5.3.2\n"),
        );
      }
      if (remote.includes("ss -lnt") || remote.includes("NO_PORT_TOOL")) {
        return yield* finish(respond("LISTEN 0 128 0.0.0.0:22\n"));
      }
      if (remote.includes("path=") && remote.includes("ABSENT_WRITABLE_PARENT")) {
        if (options.pathMode === "absent")
          return yield* finish(respond("ABSENT_WRITABLE_PARENT\n"));
        if (options.pathMode === "empty") return yield* finish(respond("EMPTY_DIRECTORY\n"));
        if (options.pathMode === "existing_git") return yield* finish(respond("EXISTING_GIT\n"));
        if (options.pathMode === "nonempty_not_git")
          return yield* finish(respond("NONEMPTY_NOT_GIT\n"));
        return yield* finish(respond("ABSENT_WRITABLE_PARENT\n"));
      }
      if (remote.includes("remote get-url origin")) {
        const tagSha =
          options.tagSha === undefined ? (options.head ?? PLANNED_SHA) : options.tagSha;
        if (options.dirty) {
          return yield* finish(
            respond(
              [
                `ORIGIN:${options.origin ?? PUBLIC_REPO_URL}`,
                "PORCELAIN: M README.md",
                `HEAD:${options.head ?? PLANNED_SHA}`,
                `BRANCH:${options.branch ?? ""}`,
                `TAG_SHA:${tagSha}`,
              ].join("\n") + "\n",
            ),
          );
        }
        return yield* finish(
          respond(
            [
              `ORIGIN:${options.origin ?? PUBLIC_REPO_URL}`,
              "PORCELAIN:",
              `HEAD:${options.head ?? PLANNED_SHA}`,
              `BRANCH:${options.branch ?? ""}`,
              `TAG_SHA:${tagSha}`,
            ].join("\n") + "\n",
          ),
        );
      }
      if (remote.includes("docker compose") && remote.includes("config --quiet")) {
        return yield* finish(respond(""));
      }
      if (remote.includes("cat compose.yaml")) {
        return yield* finish(respond(composeYamlFixture()));
      }

      return yield* Effect.die(new Error(`unexpected remote script: ${remote}`));
    });
}

export function applyExecutor(options: {
  calls?: Array<{ argv: string[]; stdin?: string }>;
  pathModeAfterPlan?: "absent" | "empty" | "existing_git";
  lsRemoteSha?: string;
  imageRevision?: string;
  failAt?: "config" | "pull" | "up" | "private-db";
  publicHealthCode?: string;
  publicDbCode?: string;
  missingService?: string;
  apiHealth?: string;
  caddyHealth?: string;
  workerHealth?: string;
  dirtyAtApply?: boolean;
  hostKeyPolicy?: string;
}) {
  const calls = options.calls ?? [];
  let cloned = options.pathModeAfterPlan === "existing_git";

  return (runOptions: RunCapturedOptions): Effect.Effect<ProcessResult, ProcessRunnerError> =>
    Effect.gen(function* () {
      const argv = [runOptions.command, ...(runOptions.args ?? [])];
      calls.push({ argv, stdin: runOptions.stdin });
      const joined = argv.join(" ");
      const remote = opensshJoinedRemote(argv);
      const respond = (stdout: string, exitCode = 0, stderr = "") =>
        ok(stdout, exitCode, stderr, argv);

      const finish = (result: ProcessResult): Effect.Effect<ProcessResult, ProcessFailedError> => {
        if (result.exitCode !== 0 && !runOptions.allowNonZero) {
          return Effect.fail(
            new ProcessFailedError({
              exitCode: result.exitCode,
              argv,
              stdout: result.stdout,
              stderr: result.stderr,
              message: `Command failed (${result.exitCode}): ${argv.join(" ")}\n${result.stderr || result.stdout}`,
            }),
          );
        }
        return Effect.succeed(result);
      };

      if (runOptions.command === "git" && runOptions.args?.[0] === "ls-remote") {
        return yield* finish(
          ok(`${options.lsRemoteSha ?? PLANNED_SHA}\trefs/tags/v0.1.2\n`, 0, "", argv),
        );
      }

      if (runOptions.command === "curl") {
        const url = runOptions.args?.[runOptions.args.length - 1] ?? "";
        if (url.endsWith("/health/db")) {
          return yield* finish(respond(options.publicDbCode ?? "404"));
        }
        if (url.endsWith("/health")) {
          return yield* finish(respond(options.publicHealthCode ?? "200"));
        }
        return yield* Effect.die(new Error(`unexpected curl: ${joined}`));
      }

      if (runOptions.command !== "ssh") {
        return yield* Effect.die(new Error(`unexpected command: ${joined}`));
      }

      if (runOptions.args?.[0] === "-G") {
        return yield* finish(
          respond(`stricthostkeychecking ${options.hostKeyPolicy ?? "accept-new"}\n`),
        );
      }

      assertOpenSshArgvShape(argv);

      if (remote.includes("path=") && remote.includes("ABSENT_WRITABLE_PARENT")) {
        if (cloned || options.pathModeAfterPlan === "existing_git")
          return yield* finish(respond("EXISTING_GIT\n"));
        if (options.pathModeAfterPlan === "empty")
          return yield* finish(respond("EMPTY_DIRECTORY\n"));
        return yield* finish(respond("ABSENT_WRITABLE_PARENT\n"));
      }

      if (remote.includes("git clone")) {
        cloned = true;
        return yield* finish(respond(`${PLANNED_SHA}\n`));
      }

      if (remote.includes("remote get-url origin")) {
        if (options.dirtyAtApply) {
          return yield* finish(
            respond(
              [
                `ORIGIN:${PUBLIC_REPO_URL}`,
                "PORCELAIN: M file",
                `HEAD:${PLANNED_SHA}`,
                "BRANCH:",
                `TAG_SHA:${PLANNED_SHA}`,
              ].join("\n") + "\n",
            ),
          );
        }
        return yield* finish(
          respond(
            [
              `ORIGIN:${PUBLIC_REPO_URL}`,
              "PORCELAIN:",
              `HEAD:${PLANNED_SHA}`,
              "BRANCH:",
              `TAG_SHA:${PLANNED_SHA}`,
            ].join("\n") + "\n",
          ),
        );
      }

      if (
        remote.includes(".env.tmp") ||
        remote.includes('cat >"$tmp"') ||
        remote.includes("mktemp")
      ) {
        return yield* finish(respond(""));
      }
      if (remote.includes("stat -c") || remote.includes("stat -f")) {
        return yield* finish(respond("600\n"));
      }
      if (remote.includes("docker compose config --quiet")) {
        if (options.failAt === "config") {
          return yield* finish(respond("", 1, "config error"));
        }
        return yield* finish(respond(""));
      }
      if (remote.includes("docker compose pull")) {
        if (options.failAt === "pull") {
          return yield* finish(respond("", 1, "pull error"));
        }
        return yield* finish(respond("pulled\n"));
      }
      if (remote.includes("docker image inspect")) {
        return yield* finish(respond(`${options.imageRevision ?? PLANNED_SHA}\n`));
      }
      if (remote.includes("cat compose.yaml")) {
        return yield* finish(respond(composeYamlFixture()));
      }
      if (remote.includes("docker compose up -d --wait")) {
        if (options.failAt === "up") {
          return yield* finish(respond("", 1, "up error"));
        }
        return yield* finish(respond("up\n"));
      }
      if (remote.includes("docker compose ps --format json")) {
        const workerEntry =
          options.workerHealth === ""
            ? { Service: "worker", State: "running", Status: "Up" }
            : {
                Service: "worker",
                State: "running",
                Status: "Up",
                ...(options.workerHealth ? { Health: options.workerHealth } : {}),
              };
        const caddyEntry =
          options.caddyHealth === ""
            ? { Service: "caddy", State: "running", Status: "Up" }
            : {
                Service: "caddy",
                State: "running",
                Health: options.caddyHealth ?? "healthy",
              };
        const services = [
          {
            Service: "api",
            State: "running",
            Health: options.apiHealth ?? "healthy",
          },
          workerEntry,
          caddyEntry,
          { Service: "backup", State: "running", Health: "healthy" },
        ].filter((entry) => entry.Service !== options.missingService);
        return yield* finish(
          respond(services.map((entry) => JSON.stringify(entry)).join("\n") + "\n"),
        );
      }
      if (remote.includes("docker compose ps -q")) {
        return yield* finish(respond("healthy\n"));
      }
      if (remote.includes("health/db")) {
        if (options.failAt === "private-db") {
          return yield* finish(respond("", 1, "db down"));
        }
        return yield* finish(respond(""));
      }

      return yield* Effect.die(new Error(`unexpected remote script: ${remote}`));
    });
}

export function deployLayer(
  _env: NodeJS.ProcessEnv,
  runCaptured: (options: RunCapturedOptions) => Effect.Effect<ProcessResult, ProcessRunnerError>,
  terminalAnswers: readonly string[] = [],
) {
  const terminal = TerminalFake({ answers: terminalAnswers });
  const layer = Layer.mergeAll(
    SetupStoreLive,
    terminal.layer,
    ProcessRunnerFake({ runCaptured }),
  ) as Layer.Layer<DeployWorkflowServices>;
  return { layer, terminal };
}

export async function runDeployWorkflow<A>(
  effect: Effect.Effect<A, DeployWorkflowError, DeployWorkflowServices>,
  layer: Layer.Layer<DeployWorkflowServices>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

export async function runDeployWorkflowExit<A>(
  effect: Effect.Effect<A, DeployWorkflowError, DeployWorkflowServices>,
  layer: Layer.Layer<DeployWorkflowServices>,
): Promise<Exit.Exit<A, DeployWorkflowError>> {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));
}

void buildOpenSshRemoteCommand;
