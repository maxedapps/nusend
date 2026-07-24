import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HELP_TEXT,
  parseSetupArgv,
  runContinue,
  runDoctor,
  runInit,
  runSetup,
  runStatus,
  UsageError,
} from "./main.mjs";
import {
  envFilePath,
  loadDeploymentEnv,
  loadState,
  SECRET_ENV_KEYS,
  setupHome,
  stateFilePath,
  writeCurrentPointer,
  writeDeploymentEnv,
  writeState,
} from "./state.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("setup grammar and help", () => {
  it("parses the final legal command grammar", () => {
    expect(parseSetupArgv([])).toEqual({ kind: "help" });
    expect(parseSetupArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseSetupArgv(["init"])).toEqual({ kind: "init" });
    expect(parseSetupArgv(["doctor"])).toEqual({ kind: "doctor" });
    expect(parseSetupArgv(["status"])).toEqual({ kind: "status", refresh: false });
    expect(parseSetupArgv(["status", "--refresh"])).toEqual({ kind: "status", refresh: true });
    expect(parseSetupArgv(["continue"])).toEqual({ kind: "continue" });
    expect(parseSetupArgv(["aws", "plan"])).toEqual({ kind: "aws", action: "plan" });
    expect(parseSetupArgv(["aws", "apply"])).toEqual({ kind: "aws", action: "apply" });
    expect(parseSetupArgv(["deploy", "plan"])).toEqual({ kind: "deploy", action: "plan" });
    expect(parseSetupArgv(["deploy", "apply"])).toEqual({ kind: "deploy", action: "apply" });
    expect(parseSetupArgv(["validate", "pre-simulator"])).toEqual({
      kind: "validate",
      action: "pre-simulator",
    });
    expect(parseSetupArgv(["validate", "simulator"])).toEqual({
      kind: "validate",
      action: "simulator",
    });
    expect(parseSetupArgv(["validate", "final"])).toEqual({ kind: "validate", action: "final" });
    expect(parseSetupArgv(["destroy", "plan"])).toEqual({ kind: "destroy", action: "plan" });
    expect(parseSetupArgv(["destroy", "apply"])).toEqual({ kind: "destroy", action: "apply" });
  });

  it("rejects unknown commands and bad arity with usage errors", () => {
    expect(() => parseSetupArgv(["unknown"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["status", "--nope"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["aws"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["aws", "delete"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["validate", "all"])).toThrow(UsageError);
    expect(() => parseSetupArgv(["init", "extra"])).toThrow(UsageError);
  });

  it("help mutates nothing under a fresh setup home", async () => {
    const env = testEnv();
    const lines = [];
    const result = await runSetup(["--help"], {
      env,
      io: testIo({ log: (line) => lines.push(line) }),
      executor: async () => {
        throw new Error("executor must not run for help");
      },
    });
    expect(result.exitCode).toBe(0);
    expect(lines.join("\n")).toContain("init");
    expect(lines.join("\n")).toContain("destroy apply");
    expect(HELP_TEXT).toContain("status [--refresh]");
    expect(readdirSync(env.NUSEND_SETUP_HOME)).toEqual([]);
  });

  it("unknown command exits 2 without writing state", async () => {
    const env = testEnv();
    const errors = [];
    const result = await runSetup(["unknown"], {
      env,
      io: testIo({ error: (line) => errors.push(line) }),
      executor: async () => {
        throw new Error("executor must not run for unknown");
      },
    });
    expect(result.exitCode).toBe(2);
    expect(errors.join("\n")).toMatch(/Unknown command/);
    expect(readdirSync(env.NUSEND_SETUP_HOME)).toEqual([]);
  });

  it("deploy plan without init fails without writing state", async () => {
    const env = testEnv();
    const errors = [];
    const result = await runSetup(["deploy", "plan"], {
      env,
      io: testIo({ error: (line) => errors.push(line) }),
      executor: async () => {
        throw new Error("executor must not run without installation");
      },
    });
    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/No active installation|not initialized|init/i);
    expect(readdirSync(env.NUSEND_SETUP_HOME)).toEqual([]);
  });

  it("nested validate/destroy commands remain recognized but not-ready", async () => {
    const env = testEnv();
    const result = await runSetup(["validate", "final"], {
      env,
      io: testIo(),
    });
    expect(result.exitCode).toBe(1);
    expect(readdirSync(env.NUSEND_SETUP_HOME)).toEqual([]);
  });

  it("aws plan without init fails without writing state", async () => {
    const env = testEnv();
    const errors = [];
    const result = await runSetup(["aws", "plan"], {
      env,
      io: testIo({ error: (line) => errors.push(line) }),
      executor: async () => {
        throw new Error("executor must not run without installation");
      },
    });
    expect(result.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/No active installation|not initialized|init/i);
    expect(readdirSync(env.NUSEND_SETUP_HOME)).toEqual([]);
  });
});

describe("init", () => {
  it("collects choices, generates secrets, and never stores secrets in state", async () => {
    const env = testEnv();
    const logs = [];
    const answers = [
      "prod",
      "v0.1.1",
      "mail.example.com",
      "direct",
      "owner@example.com",
      "Owner",
      "nusend-provisioner",
      "us-east-1",
      "123456789012",
      "example.com",
      "sender@example.com",
      "n",
      "n",
      "alerts@example.com",
      "",
      "root@203.0.113.10",
      "/srv/nusend",
      "google-client-id",
      "google-client-secret-value",
      "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
      "r2-access-key",
      "r2-secret-key-value",
    ];
    const secrets = [];

    await runInit({
      env,
      executor: async () => {
        throw new Error("unused");
      },
      io: {
        prompt: async () => answers.shift() ?? "",
        promptSecret: async () => {
          const value = answers.shift() ?? "";
          secrets.push(value);
          return value;
        },
        log: (line) => logs.push(line),
        error: () => undefined,
      },
    });

    const state = await loadState("prod", env);
    expect(state.config.domain).toBe("mail.example.com");
    expect(state.stages.init.evidence.verified).toBe(true);
    const stateText = await readFile(stateFilePath("prod", env), "utf8");
    for (const secret of secrets) {
      expect(stateText).not.toContain(secret);
    }
    for (const key of SECRET_ENV_KEYS) {
      expect(stateText).not.toContain(key);
    }

    const deployment = await loadDeploymentEnv("prod", env);
    expect(deployment.GOOGLE_CLIENT_SECRET).toBe("google-client-secret-value");
    expect(deployment.NUSEND_R2_SECRET_ACCESS_KEY).toBe("r2-secret-key-value");
    expect(deployment.BETTER_AUTH_SECRET.length).toBeGreaterThan(20);
    expect(deployment.NUSEND_RESTIC_PASSWORD.length).toBeGreaterThan(20);
    expect(deployment.AWS_REGION).toBe("us-east-1");

    if (process.platform !== "win32") {
      expect((await stat(setupHome(env))).mode & 0o777).toBe(0o700);
      expect((await stat(stateFilePath("prod", env))).mode & 0o777).toBe(0o600);
      expect((await stat(envFilePath("prod", env))).mode & 0o777).toBe(0o600);
    }

    // Secrets must not appear in init logs.
    const logText = logs.join("\n");
    expect(logText).not.toContain("google-client-secret-value");
    expect(logText).not.toContain("r2-secret-key-value");
    expect(logText).not.toContain(deployment.BETTER_AUTH_SECRET);
  });

  it.each(["afterInitStateWrite", "afterInitEnvWrite"])(
    "removes unpublished artifacts after the %s failure seam so init can be retried",
    async (seam) => {
      const env = testEnv();
      const interruptedAnswers = initAnswers();
      await expect(
        runInit({
          env,
          executor: async () => {
            throw new Error("unused");
          },
          io: {
            prompt: async () => interruptedAnswers.shift() ?? "",
            promptSecret: async () => interruptedAnswers.shift() ?? "",
            log: () => undefined,
            error: () => undefined,
          },
          [seam]: async () => {
            throw new Error(`simulated ${seam}`);
          },
        }),
      ).rejects.toThrow(`simulated ${seam}`);
      expect(readdirSync(setupHome(env))).toEqual([]);

      const retryAnswers = initAnswers();
      await runInit({
        env,
        executor: async () => {
          throw new Error("unused");
        },
        io: {
          prompt: async () => retryAnswers.shift() ?? "",
          promptSecret: async () => retryAnswers.shift() ?? "",
          log: () => undefined,
          error: () => undefined,
        },
      });
      await expect(loadState("prod", env)).resolves.toMatchObject({ installationId: "prod" });
    },
  );

  it("atomically reserves an installation so concurrent same-id init cannot overwrite or delete it", async () => {
    const env = testEnv();
    const firstAnswers = initAnswers();
    let releaseReservation;
    const holdReservation = new Promise((resolve) => {
      releaseReservation = resolve;
    });
    let signalReserved;
    const reserved = new Promise((resolve) => {
      signalReserved = resolve;
    });

    const first = runInit({
      env,
      executor: async () => {
        throw new Error("unused");
      },
      io: {
        prompt: async () => firstAnswers.shift() ?? "",
        promptSecret: async () => firstAnswers.shift() ?? "",
        log: () => undefined,
        error: () => undefined,
      },
      afterInitReservation: async () => {
        signalReserved();
        await holdReservation;
      },
    });
    await reserved;

    const secondAnswers = initAnswers();
    await expect(
      runInit({
        env,
        executor: async () => {
          throw new Error("unused");
        },
        io: {
          prompt: async () => secondAnswers.shift() ?? "",
          promptSecret: async () => secondAnswers.shift() ?? "",
          log: () => undefined,
          error: () => undefined,
        },
      }),
    ).rejects.toThrow(/already exists|concurrent/i);

    releaseReservation();
    await first;
    await expect(loadState("prod", env)).resolves.toMatchObject({ installationId: "prod" });
  });

  it("retains another current installation pointer when unpublished init cleanup runs", async () => {
    const env = testEnv();
    await writeCurrentPointer("other", env);
    const answers = initAnswers();
    await expect(
      runInit({
        env,
        executor: async () => {
          throw new Error("unused");
        },
        io: {
          prompt: async () => answers.shift() ?? "",
          promptSecret: async () => answers.shift() ?? "",
          log: () => undefined,
          error: () => undefined,
        },
        afterInitEnvWrite: async () => {
          throw new Error("simulated pointer-prepublication failure");
        },
      }),
    ).rejects.toThrow(/pointer-prepublication/);

    expect(await readFile(join(setupHome(env), "current"), "utf8")).toBe("other\n");
    expect(readdirSync(setupHome(env))).toEqual(["current"]);
  });

  it("refuses duplicate init for the same installation and preserves bytes", async () => {
    const env = testEnv();
    const answers = () => [
      "prod",
      "v0.1.1",
      "mail.example.com",
      "direct",
      "owner@example.com",
      "Owner",
      "nusend-provisioner",
      "us-east-1",
      "123456789012",
      "example.com",
      "sender@example.com",
      "n",
      "n",
      "alerts@example.com",
      "",
      "root@203.0.113.10",
      "/srv/nusend",
      "google-client-id",
      "google-client-secret-value",
      "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
      "r2-access-key",
      "r2-secret-key-value",
    ];

    /** @param {string[]} queue */
    const initOnce = async (queue) =>
      runInit({
        env,
        executor: async () => {
          throw new Error("unused");
        },
        io: {
          prompt: async () => queue.shift() ?? "",
          promptSecret: async () => queue.shift() ?? "",
          log: () => undefined,
          error: () => undefined,
        },
      });

    await initOnce(answers());

    const stateBefore = await readFile(stateFilePath("prod", env));
    const envBefore = await readFile(envFilePath("prod", env));
    const pointerBefore = await readFile(join(setupHome(env), "current"));

    await expect(initOnce(answers())).rejects.toThrow(/already exists/);

    expect(await readFile(stateFilePath("prod", env))).toEqual(stateBefore);
    expect(await readFile(envFilePath("prod", env))).toEqual(envBefore);
    expect(await readFile(join(setupHome(env), "current"))).toEqual(pointerBefore);
  });
});

describe("continue and status", () => {
  it("runs at most one eligible stage and checkpoints only verified evidence", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const runs = [];

    await runContinue({
      env,
      executor: async () => ({
        exitCode: 0,
        signal: null,
        stdout: "ok",
        stderr: "",
        argv: ["true"],
      }),
      io: testIo(),
      stageHandlers: {
        aws_core: {
          run: async () => {
            runs.push("aws_core");
            return { verified: true, changeSetArn: "arn:example" };
          },
        },
        human_gates: {
          run: async () => {
            runs.push("human_gates");
            return { verified: true };
          },
        },
      },
    });

    expect(runs).toEqual(["aws_core"]);
    const state = await loadState("prod", env);
    expect(state.stages.aws_core.evidence).toEqual({
      verified: true,
      changeSetArn: "arn:example",
    });
    expect(state.stages.human_gates).toBeUndefined();
  });

  it("does not checkpoint when a stage exits successfully without verified evidence", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");

    await expect(
      runContinue({
        env,
        executor: async () => ({
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          argv: ["true"],
        }),
        io: testIo(),
        stageHandlers: {
          aws_core: {
            run: async (ctx) => {
              await ctx.executor({ command: "true", args: [] });
              return { exitCode: 0 };
            },
          },
        },
      }),
    ).rejects.toThrow(/without verified evidence/);

    const state = await loadState("prod", env);
    expect(state.stages.aws_core).toBeUndefined();
  });

  it("status is local-only by default and labels provider freshness", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const logs = [];
    let executorCalls = 0;

    await runStatus(
      {
        env,
        executor: async () => {
          executorCalls += 1;
          throw new Error("should not run");
        },
        io: testIo({ log: (line) => logs.push(line) }),
      },
      false,
    );

    expect(executorCalls).toBe(0);
    expect(logs.join("\n")).toMatch(/local-only \(stale\/unknown\)/);
    expect(logs.join("\n")).toMatch(/aws_core: pending/);

    const refreshLogs = [];
    await runStatus(
      {
        env,
        executor: async ({ command, args }) => {
          executorCalls += 1;
          if (command === "aws") {
            return {
              exitCode: 0,
              signal: null,
              stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123:user/x" }),
              stderr: "",
              argv: [command, ...args],
            };
          }
          return {
            exitCode: 0,
            signal: null,
            stdout: "Docker Compose version v5.3.1",
            stderr: "",
            argv: [command, ...args],
          };
        },
        io: testIo({ log: (line) => refreshLogs.push(line) }),
      },
      true,
    );

    expect(executorCalls).toBeGreaterThan(0);
    expect(refreshLogs.join("\n")).toMatch(/aws-caller: ok/);
    expect(refreshLogs.join("\n")).toMatch(/stack: ok/);
    expect(refreshLogs.join("\n")).toMatch(/remote-compose: unavailable/);
    expect(refreshLogs.join("\n")).toMatch(/readiness: unavailable/);
  });
});

describe("doctor", () => {
  it("fails actionably when init is missing and mutates nothing", async () => {
    const env = testEnv();
    const before = readdirSync(env.NUSEND_SETUP_HOME);
    await expect(
      runDoctor({
        env,
        platform: "linux",
        nodeVersion: "22.0.0",
        executor: async () => {
          throw new Error("should stop before executor-heavy checks");
        },
        io: testIo(),
        skipRemoteDoctorChecks: true,
      }),
    ).rejects.toThrow(/not initialized|No active installation/i);
    expect(readdirSync(env.NUSEND_SETUP_HOME)).toEqual(before);
  });

  it("is read-only and checks platform/node/tools/account with an injected executor", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const logs = [];
    /** @type {string[]} */
    const commands = [];

    await runDoctor({
      env,
      platform: "linux",
      nodeVersion: "22.11.0",
      skipRemoteDoctorChecks: false,
      io: testIo({ log: (line) => logs.push(line) }),
      executor: async ({ command, args }) => {
        commands.push([command, ...args].join(" "));
        const joined = [command, ...args].join(" ");
        if (joined === "pnpm --version") {
          return ok("11.9.0\n");
        }
        if (joined === "git --version" || joined.includes("git --version")) {
          return ok("git version 2.50.1\n");
        }
        if (joined === "aws --version") {
          return ok("aws-cli/2.17.0 Python/3.12.0\n");
        }
        if (joined.startsWith("aws sts get-caller-identity")) {
          return ok(JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123:user/x" }));
        }
        if (joined === "ssh -V") {
          return { ...ok(""), stderr: "OpenSSH_9.0\n" };
        }
        if (joined === "curl --version") {
          return ok("curl 8.0.0\n");
        }
        if (joined.startsWith("ssh -G")) {
          return ok("stricthostkeychecking accept-new\n");
        }
        if (joined.includes("docker version")) {
          return ok("27.0.0\n");
        }
        if (joined.includes("docker compose version")) {
          return ok("Docker Compose version v5.3.2\n");
        }
        throw new Error(`unexpected command: ${joined}`);
      },
    });

    expect(logs.join("\n")).toMatch(/doctor: all checks passed/);
    expect(commands).toContain("git --version");
    expect(commands).toContain("ssh root@203.0.113.10 git --version");
    expect(commands.some((line) => line.includes("cloudformation"))).toBe(false);
    expect(commands.some((line) => /\b(create|update|delete|apply)\b/u.test(line))).toBe(false);

    // Windows guidance
    await expect(
      runDoctor({
        env,
        platform: "win32",
        nodeVersion: "22.0.0",
        executor: async () => ok(""),
        io: testIo(),
      }),
    ).rejects.toThrow(/WSL/);
  });
});

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} installationId
 */
async function seedInstallation(env, installationId) {
  const now = "2026-01-01T00:00:00.000Z";
  await writeState(
    {
      schemaVersion: 1,
      installationId,
      createdAt: now,
      updatedAt: now,
      config: {
        releaseTag: "v0.1.1",
        domain: "mail.example.com",
        ingressMode: "direct",
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
      },
      stages: {
        init: {
          status: "complete",
          completedAt: now,
          evidence: { verified: true, installationId },
        },
      },
      plans: {},
    },
    env,
  );
  await writeDeploymentEnv(
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
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_REGION: "us-east-1",
      NUSEND_SES_FROM_EMAIL: "sender@example.com",
      NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "",
      NUSEND_RESTIC_REPOSITORY: "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
      NUSEND_R2_ACCESS_KEY_ID: "r2-access",
      NUSEND_R2_SECRET_ACCESS_KEY: "r2-secret-value-xxxxxx",
      NUSEND_RESTIC_PASSWORD: "restic-password-value-xxxxxx",
    },
    env,
  );
  await writeCurrentPointer(installationId, env);
}

function initAnswers() {
  return [
    "prod",
    "v0.1.1",
    "mail.example.com",
    "direct",
    "owner@example.com",
    "Owner",
    "nusend-provisioner",
    "us-east-1",
    "123456789012",
    "example.com",
    "sender@example.com",
    "n",
    "n",
    "alerts@example.com",
    "",
    "root@203.0.113.10",
    "/srv/nusend",
    "google-client-id",
    "google-client-secret-value",
    "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
    "r2-access-key",
    "r2-secret-key-value",
  ];
}

function testEnv() {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-main-"));
  temporaryDirectories.push(directory);
  return { NUSEND_SETUP_HOME: directory, HOME: directory };
}

/**
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [overrides]
 */
function testIo(overrides = {}) {
  return {
    prompt: async () => "",
    promptSecret: async () => "",
    log: overrides.log ?? (() => undefined),
    error: overrides.error ?? (() => undefined),
  };
}

/**
 * @param {string} stdout
 */
function ok(stdout) {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    argv: [],
  };
}
