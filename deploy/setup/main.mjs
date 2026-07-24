#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { pathToFileURL } from "node:url";

import { awsCoreStageHandler, runAwsApply, runAwsPlan } from "./aws.mjs";
import {
  deployStageHandler,
  humanGatesStageHandler,
  runDeployApply,
  runDeployPlan,
} from "./deploy.mjs";
import { runDestroyApply, runDestroyPlan } from "./destroy.mjs";
import { defaultProcessExecutor } from "./process.mjs";
import {
  awsFinalizeStageHandler,
  CLI_PATH,
  finalValidationStageHandler,
  preSimulatorStageHandler,
  runFinalValidation,
  runPreSimulatorValidation,
  runProviderRefresh,
  runSimulatorValidation,
  simulatorStageHandler,
} from "./validate.mjs";
import {
  assertAbsolutePosixPath,
  assertInstallationId,
  assertInstallationNotInitialized,
  assertReleaseTag,
  checkpointStage,
  generateSecret,
  loadDeploymentEnv,
  loadState,
  publicStatusView,
  removeUnpublishedInstallation,
  reserveInstallationDirectory,
  resolveInstallationId,
  setupHome,
  writeCurrentPointer,
  writeDeploymentEnv,
  writeState,
} from "./state.mjs";

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** Ordered post-init stages. Future tasks fill runners; T1 keeps grammar final. */
export const STAGE_ORDER = Object.freeze([
  "aws_core",
  "human_gates",
  "deploy",
  "aws_finalize",
  "validate_pre_simulator",
  "validate_simulator",
  "validate_final",
]);

export const HELP_TEXT = `Usage: pnpm nusend:setup <command>

Guided, resumable Nusend CloudFormation setup (workstation-side).

Commands:
  init
  doctor
  status [--refresh]
  continue
  aws plan
  aws apply
  deploy plan
  deploy apply
  validate pre-simulator
  validate simulator
  validate final
  destroy plan
  destroy apply

Global options:
  -h, --help    Show this help and exit

Environment:
  NUSEND_SETUP_HOME            Override setup home (default: ~/.config/nusend/setup)
  NUSEND_SETUP_INSTALLATION    Select installation id (else mode-0600 "current" pointer)

Notes:
  Help and unknown commands mutate nothing.
  Secrets live only in deployment.env under the installation directory.
  continue runs at most one eligible stage and checkpoints verified evidence only.
`;

/**
 * @typedef {object} SetupIo
 * @property {(message: string) => Promise<string>} prompt
 * @property {(message: string) => Promise<string>} promptSecret
 * @property {(message: string) => void} [log]
 * @property {(message: string) => void} [error]
 */

/**
 * @typedef {object} SetupContext
 * @property {NodeJS.ProcessEnv | import('./state.mjs').PathEnvironment} env
 * @property {typeof defaultProcessExecutor} executor
 * @property {SetupIo} io
 * @property {string} [platform]
 * @property {string} [nodeVersion]
 * @property {string} [cliPath]
 * @property {Partial<Record<string, StageHandler>>} [stageHandlers]
 * @property {boolean} [skipRemoteDoctorChecks]
 * @property {(milliseconds: number) => Promise<void>} [sleep]
 * @property {(input: { installationId: string }) => Promise<void>} [afterInitReservation]
 * @property {(input: { installationId: string }) => Promise<void>} [afterInitStateWrite]
 * @property {(input: { installationId: string }) => Promise<void>} [afterInitEnvWrite]
 */

/**
 * @typedef {object} StageHandler
 * @property {(ctx: SetupContext, state: import('./state.mjs').SetupState) => Promise<boolean> | boolean} [isEligible]
 * @property {(ctx: SetupContext, state: import('./state.mjs').SetupState) => Promise<Record<string, unknown>>} run
 */

/**
 * @typedef {{ kind: "help" }
 * | { kind: "init" }
 * | { kind: "doctor" }
 * | { kind: "status", refresh: boolean }
 * | { kind: "continue" }
 * | { kind: "aws", action: "plan" | "apply" }
 * | { kind: "deploy", action: "plan" | "apply" }
 * | { kind: "validate", action: "pre-simulator" | "simulator" | "final" }
 * | { kind: "destroy", action: "plan" | "apply" }
 * } ParsedCommand
 */

export class UsageError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = EXIT_USAGE) {
    super(message);
    this.name = "UsageError";
    this.exitCode = exitCode;
  }
}

export class SetupError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = EXIT_ERROR) {
    super(message);
    this.name = "SetupError";
    this.exitCode = exitCode;
  }
}

/**
 * @param {readonly string[]} argv
 * @returns {ParsedCommand}
 */
export function parseSetupArgv(argv) {
  const args = [...argv];
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    if (args.length > 1 && args[0] !== "help") {
      throw new UsageError(`Unexpected arguments after ${args[0]}.\n\n${HELP_TEXT}`);
    }
    return { kind: "help" };
  }

  const head = args[0];
  switch (head) {
    case "init":
      return parseUnary(args, "init");
    case "doctor":
      return parseUnary(args, "doctor");
    case "status": {
      let refresh = false;
      for (const flag of args.slice(1)) {
        if (flag === "--refresh") {
          refresh = true;
          continue;
        }
        if (flag === "-h" || flag === "--help") return { kind: "help" };
        throw new UsageError(`Unknown status option "${flag}".\n\n${HELP_TEXT}`);
      }
      return { kind: "status", refresh };
    }
    case "continue":
      return parseUnary(args, "continue");
    case "aws":
      return parseTwoPart(args, "aws", /** @type {const} */ (["plan", "apply"]));
    case "deploy":
      return parseTwoPart(args, "deploy", /** @type {const} */ (["plan", "apply"]));
    case "validate":
      return parseTwoPart(
        args,
        "validate",
        /** @type {const} */ (["pre-simulator", "simulator", "final"]),
      );
    case "destroy":
      return parseTwoPart(args, "destroy", /** @type {const} */ (["plan", "apply"]));
    default:
      throw new UsageError(`Unknown command "${head}".\n\n${HELP_TEXT}`);
  }
}

/**
 * @param {string[]} args
 * @param {"init" | "doctor" | "continue"} name
 * @returns {ParsedCommand}
 */
function parseUnary(args, name) {
  if (args.length === 1) return { kind: name };
  if (args[1] === "-h" || args[1] === "--help") return { kind: "help" };
  throw new UsageError(`Unexpected arguments for ${name}.\n\n${HELP_TEXT}`);
}

/**
 * @template {string} T
 * @param {string[]} args
 * @param {string} parent
 * @param {readonly T[]} actions
 * @returns {{ kind: any, action: T } | { kind: "help" }}
 */
function parseTwoPart(args, parent, actions) {
  const action = args[1];
  if (action == null || action === "-h" || action === "--help") {
    if (action == null) {
      throw new UsageError(
        `Missing action for ${parent}. Expected one of: ${actions.join(", ")}.\n\n${HELP_TEXT}`,
      );
    }
    return { kind: "help" };
  }
  if (!actions.includes(/** @type {T} */ (action))) {
    throw new UsageError(
      `Unknown ${parent} action "${action}". Expected one of: ${actions.join(", ")}.\n\n${HELP_TEXT}`,
    );
  }
  if (args.length > 2) {
    throw new UsageError(`Unexpected arguments for ${parent} ${action}.\n\n${HELP_TEXT}`);
  }
  return { kind: parent, action: /** @type {T} */ (action) };
}

/**
 * @param {readonly string[]} argv
 * @param {Partial<SetupContext>} [options]
 */
export async function runSetup(argv, options = {}) {
  const ctx = createContext(options);
  try {
    const command = parseSetupArgv(argv);
    switch (command.kind) {
      case "help":
        ctx.io.log?.(HELP_TEXT.trimEnd());
        return { exitCode: EXIT_SUCCESS };
      case "init":
        await runInit(ctx);
        return { exitCode: EXIT_SUCCESS };
      case "doctor":
        await runDoctor(ctx);
        return { exitCode: EXIT_SUCCESS };
      case "status":
        await runStatus(ctx, command.refresh);
        return { exitCode: EXIT_SUCCESS };
      case "continue":
        await runContinue(ctx);
        return { exitCode: EXIT_SUCCESS };
      case "aws":
        if (command.action === "plan") {
          await runAwsPlan(ctx);
          return { exitCode: EXIT_SUCCESS };
        }
        if (command.action === "apply") {
          await runAwsApply(ctx);
          return { exitCode: EXIT_SUCCESS };
        }
        throw new UsageError(`Unknown aws action.

${HELP_TEXT}`);
      case "deploy":
        if (command.action === "plan") {
          await runDeployPlan(ctx);
          return { exitCode: EXIT_SUCCESS };
        }
        if (command.action === "apply") {
          await runDeployApply(ctx);
          return { exitCode: EXIT_SUCCESS };
        }
        throw new UsageError(`Unknown deploy action.

${HELP_TEXT}`);
      case "validate":
        if (command.action === "pre-simulator") await runPreSimulatorValidation(ctx);
        else if (command.action === "simulator") await runSimulatorValidation(ctx);
        else if (command.action === "final") await runFinalValidation(ctx);
        else throw new UsageError(`Unknown validate action.\n\n${HELP_TEXT}`);
        return { exitCode: EXIT_SUCCESS };
      case "destroy":
        if (command.action === "plan") await runDestroyPlan(ctx);
        else if (command.action === "apply") await runDestroyApply(ctx);
        else throw new UsageError(`Unknown destroy action.\n\n${HELP_TEXT}`);
        return { exitCode: EXIT_SUCCESS };
      default:
        throw new UsageError(`Unhandled command.\n\n${HELP_TEXT}`);
    }
  } catch (error) {
    return handleError(error, ctx);
  }
}

/**
 * @param {unknown} error
 * @param {SetupContext} ctx
 */
function handleError(error, ctx) {
  if (error instanceof UsageError) {
    ctx.io.error?.(error.message.trimEnd());
    return { exitCode: error.exitCode };
  }
  if (error instanceof SetupError) {
    ctx.io.error?.(error.message.trimEnd());
    return { exitCode: error.exitCode };
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  ctx.io.error?.(`Error: ${message}`);
  const exitCode =
    typeof error === "object" &&
    error !== null &&
    typeof (/** @type {any} */ (error).exitCode) === "number"
      ? /** @type {any} */ (error).exitCode
      : EXIT_ERROR;
  return { exitCode };
}

/**
 * @param {Partial<SetupContext>} options
 * @returns {SetupContext}
 */
export function createContext(options = {}) {
  return {
    env: options.env ?? process.env,
    executor: options.executor ?? defaultProcessExecutor,
    io: options.io ?? createDefaultIo(),
    platform: options.platform ?? process.platform,
    nodeVersion: options.nodeVersion ?? process.versions.node,
    cliPath: options.cliPath ?? CLI_PATH,
    stageHandlers: options.stageHandlers ?? {},
    skipRemoteDoctorChecks: options.skipRemoteDoctorChecks ?? false,
    sleep:
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    afterInitReservation: options.afterInitReservation,
    afterInitStateWrite: options.afterInitStateWrite,
    afterInitEnvWrite: options.afterInitEnvWrite,
  };
}

function createDefaultIo() {
  /** @type {import('node:readline/promises').Interface | undefined} */
  let rl;
  const ensureRl = () => {
    if (!rl) {
      rl = createInterface({ input: defaultStdin, output: defaultStdout });
    }
    return rl;
  };
  return {
    prompt: async (message) => {
      const answer = await ensureRl().question(message);
      return answer.trim();
    },
    promptSecret: async (message) => {
      // Avoid echoing secrets when a TTY is available.
      const output = defaultStdout;
      const input = defaultStdin;
      if (typeof input.setRawMode === "function" && input.isTTY) {
        output.write(message);
        const value = await readSilentLine(input, output);
        output.write("\n");
        return value;
      }
      const answer = await ensureRl().question(message);
      return answer;
    },
    log: (message) => {
      defaultStdout.write(`${message}\n`);
    },
    error: (message) => {
      defaultStdout.write(""); // keep ordering stable with stderr
      console.error(message);
    },
  };
}

/**
 * @param {NodeJS.ReadStream} input
 * @param {NodeJS.WriteStream} output
 */
function readSilentLine(input, output) {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    /** @type {string[]} */
    const chars = [];
    const onData = (/** @type {Buffer | string} */ chunk) => {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          resolve(chars.join(""));
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Interrupted"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          chars.pop();
          continue;
        }
        chars.push(ch);
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      if (typeof input.setRawMode === "function") input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    input.setEncoding("utf8");
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    // silence unused
    void output;
  });
}

/**
 * @param {SetupContext} ctx
 */
export async function runInit(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  log("Initialize a new Nusend setup installation.");
  log("Secrets are written only to deployment.env and are never printed.");

  const installationId = assertInstallationId(
    await ask(ctx, "Installation id (slug, max 31) [a-z][a-z0-9-]*: "),
  );
  // Refuse early so an existing install is not partially re-prompted then clobbered.
  await assertInstallationNotInitialized(installationId, ctx.env);
  const releaseTag = assertReleaseTag(await ask(ctx, "Release tag (e.g. v0.1.1): "));
  const domain = await ask(ctx, "Public domain (e.g. mail.example.com): ");
  const ingressMode = await askChoice(ctx, "Ingress mode", ["direct", "cloudflare"]);
  const ownerEmail = await ask(ctx, "Owner email (Google account): ");
  const ownerName = await ask(ctx, "Owner display name: ");
  const awsProfile = await ask(ctx, "AWS CLI profile name: ");
  const awsRegion = await ask(ctx, "AWS region (e.g. us-east-1): ");
  const awsAccountId = await ask(ctx, "Expected 12-digit AWS account id: ");
  if (!/^\d{12}$/u.test(awsAccountId)) {
    throw new SetupError("AWS account id must be exactly 12 digits.");
  }
  const sesIdentity = await ask(ctx, "SES domain identity (e.g. example.com): ");
  const sesFromEmail = await ask(ctx, "SES from address: ");
  const marketingEnabled = await askBoolean(ctx, "Enable marketing configuration set?", false);
  const trackingEnabled = await askBoolean(ctx, "Enable open/click tracking?", false);
  const alertEmail = await ask(ctx, "Alert email for CloudWatch notifications: ");
  const route53Raw = await ask(ctx, "Route 53 hosted zone id (empty for manual DNS): ", true);
  const route53HostedZoneId = route53Raw === "" ? null : route53Raw;
  const sshTarget = await ask(ctx, "SSH target (user@host): ");
  const remotePath = assertAbsolutePosixPath(
    await ask(ctx, "Absolute remote checkout path (e.g. /srv/nusend): "),
  );

  const googleClientId = await ask(ctx, "Google OAuth client id: ");
  const googleClientSecret = await askSecret(ctx, "Google OAuth client secret: ");
  const resticRepository = await ask(
    ctx,
    "Restic repository URL (s3:https://...r2.../bucket/nusend): ",
  );
  const r2AccessKeyId = await ask(ctx, "R2 access key id: ");
  const r2SecretAccessKey = await askSecret(ctx, "R2 secret access key: ");

  const betterAuthSecret = generateSecret(32);
  const apiKeyHashSecret = generateSecret(32);
  const unsubscribeSecret = generateSecret(32);
  const resticPassword = generateSecret(32);

  const now = new Date().toISOString();
  /** @type {import('./state.mjs').SetupState} */
  const state = {
    schemaVersion: 1,
    installationId,
    createdAt: now,
    updatedAt: now,
    config: {
      releaseTag,
      domain,
      ingressMode: /** @type {"direct" | "cloudflare"} */ (ingressMode),
      ownerEmail,
      ownerName,
      awsProfile,
      awsRegion,
      awsAccountId,
      sesIdentity,
      sesFromEmail,
      marketingEnabled,
      trackingEnabled,
      alertEmail,
      route53HostedZoneId,
      sshTarget,
      remotePath,
      installationName: installationId,
    },
    stages: {
      init: {
        status: "complete",
        completedAt: now,
        evidence: {
          verified: true,
          installationId,
          domain,
          releaseTag,
          awsRegion,
          awsAccountId,
        },
      },
    },
    plans: {},
  };

  /** @type {Record<string, string>} */
  const deploymentEnv = {
    NUSEND_DOMAIN: domain,
    NUSEND_INGRESS_MODE: ingressMode,
    NUSEND_OWNER_EMAIL: ownerEmail,
    NUSEND_OWNER_NAME: ownerName,
    BETTER_AUTH_SECRET: betterAuthSecret,
    GOOGLE_CLIENT_ID: googleClientId,
    GOOGLE_CLIENT_SECRET: googleClientSecret,
    NUSEND_API_KEY_HASH_SECRET: apiKeyHashSecret,
    NUSEND_UNSUBSCRIBE_SECRET: unsubscribeSecret,
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_REGION: awsRegion,
    NUSEND_SES_FROM_EMAIL: sesFromEmail,
    NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "",
    NUSEND_RESTIC_REPOSITORY: resticRepository,
    NUSEND_R2_ACCESS_KEY_ID: r2AccessKeyId,
    NUSEND_R2_SECRET_ACCESS_KEY: r2SecretAccessKey,
    NUSEND_RESTIC_PASSWORD: resticPassword,
  };
  if (marketingEnabled) {
    deploymentEnv.NUSEND_SES_MARKETING_CONFIGURATION_SET = "";
  }
  if (trackingEnabled) {
    deploymentEnv.NUSEND_SES_TRACKING_EVENTS = "open,click";
  }

  // Atomically reserve the absent installation before durable writes. A concurrent same-id init
  // cannot enter this block or share cleanup ownership.
  await reserveInstallationDirectory(installationId, ctx.env);
  try {
    await ctx.afterInitReservation?.({ installationId });
    await writeState(state, ctx.env);
    await ctx.afterInitStateWrite?.({ installationId });
    await writeDeploymentEnv(installationId, deploymentEnv, ctx.env);
    await ctx.afterInitEnvWrite?.({ installationId });
    await writeCurrentPointer(installationId, ctx.env);
  } catch (error) {
    // Init preflight proved this installation absent. If pointer publication did not happen, remove
    // only this installation directory so the same id can be retried. If publication is ambiguous
    // or points here, retain all artifacts rather than risking damage to a published installation.
    await removeUnpublishedInstallation(installationId, ctx.env);
    throw error;
  }

  log(`Installation "${installationId}" created under ${setupHome(ctx.env)}.`);
  log("Next: run `pnpm nusend:setup doctor`, then `pnpm nusend:setup continue`.");
}

/**
 * @param {SetupContext} ctx
 * @param {string} message
 * @param {boolean} [allowEmpty]
 */
async function ask(ctx, message, allowEmpty = false) {
  const value = (await ctx.io.prompt(message)).trim();
  if (!allowEmpty && value === "") {
    throw new SetupError(`A value is required for: ${message.trim()}`);
  }
  return value;
}

/**
 * @param {SetupContext} ctx
 * @param {string} message
 */
async function askSecret(ctx, message) {
  const value = await ctx.io.promptSecret(message);
  if (typeof value !== "string" || value.trim() === "") {
    throw new SetupError(`A secret value is required for: ${message.trim()}`);
  }
  return value.trim();
}

/**
 * @param {SetupContext} ctx
 * @param {string} label
 * @param {readonly string[]} choices
 */
async function askChoice(ctx, label, choices) {
  const value = (await ask(ctx, `${label} (${choices.join("|")}): `)).toLowerCase();
  if (!choices.includes(value)) {
    throw new SetupError(`Expected one of: ${choices.join(", ")}.`);
  }
  return value;
}

/**
 * @param {SetupContext} ctx
 * @param {string} label
 * @param {boolean} defaultValue
 */
async function askBoolean(ctx, label, defaultValue) {
  const hint = defaultValue ? "Y/n" : "y/N";
  const value = (await ask(ctx, `${label} [${hint}]: `, true)).toLowerCase();
  if (value === "") return defaultValue;
  if (["y", "yes"].includes(value)) return true;
  if (["n", "no"].includes(value)) return false;
  throw new SetupError("Please answer yes or no.");
}

/**
 * @param {SetupContext} ctx
 */
export async function runDoctor(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const checks = [];
  const note = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    log(`${ok ? "ok" : "FAIL"}  ${name}: ${detail}`);
  };

  if (ctx.platform === "win32") {
    note(
      "platform",
      false,
      "Native Windows is not supported. Use WSL (Ubuntu) and rerun from the Linux environment.",
    );
    throw new SetupError("doctor failed: use WSL on Windows.", EXIT_ERROR);
  }
  note("platform", true, ctx.platform ?? "unknown");

  const nodeMajor = Number.parseInt(String(ctx.nodeVersion).split(".")[0] ?? "0", 10);
  note(
    "node",
    nodeMajor >= 22,
    nodeMajor >= 22
      ? `Node ${ctx.nodeVersion}`
      : `Node ${ctx.nodeVersion} is too old; require Node 22+`,
  );

  await checkLocalBinary(ctx, note, "pnpm", ["pnpm", "--version"], /./u);
  await checkLocalBinary(ctx, note, "git", ["git", "--version"], /^git version\b/iu);
  await checkAwsCliV2(ctx, note);
  await checkLocalBinary(ctx, note, "ssh", ["ssh", "-V"], /OpenSSH|ssh/iu);
  await checkLocalBinary(ctx, note, "curl", ["curl", "--version"], /^curl\b/iu);

  let state;
  let envMap;
  try {
    const installationId = await resolveInstallationId(ctx.env);
    state = await loadState(installationId, ctx.env);
    envMap = await loadDeploymentEnv(installationId, ctx.env);
    note(
      "state",
      true,
      `installation ${installationId}; directory and state/env permissions accepted`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note("state", false, message);
    throw new SetupError(
      `doctor failed: setup is not initialized or state/env is unsafe.\n${message}\nRun \`pnpm nusend:setup init\` first.`,
      EXIT_ERROR,
    );
  }

  try {
    assertReleaseTag(state.config.releaseTag);
    note("release-tag", true, state.config.releaseTag);
  } catch (error) {
    note("release-tag", false, error instanceof Error ? error.message : String(error));
  }

  const missingEnv = requiredEnvKeys(state).filter((key) => {
    const value = envMap[key];
    return typeof value !== "string" || value.trim() === "";
  });
  // AWS runtime keys are filled after stack apply; allow empty until then.
  const missingNow = missingEnv.filter(
    (key) =>
      key !== "AWS_ACCESS_KEY_ID" &&
      key !== "AWS_SECRET_ACCESS_KEY" &&
      key !== "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET" &&
      key !== "NUSEND_SES_MARKETING_CONFIGURATION_SET" &&
      key !== "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
  );
  note(
    "deployment-env",
    missingNow.length === 0,
    missingNow.length === 0
      ? "required non-AWS values present"
      : `missing: ${missingNow.join(", ")}`,
  );

  await checkAwsCaller(ctx, note, state);
  await checkSshHostKeyPolicy(ctx, note, state);

  if (!ctx.skipRemoteDoctorChecks) {
    await checkRemoteDockerCompose(ctx, note, state);
  } else {
    note("remote-git", true, "skipped in this run");
    note("remote-docker", true, "skipped in this run");
    note("remote-compose", true, "skipped in this run");
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new SetupError(
      `doctor failed (${failed.length} check(s)). Fix the FAIL items above and rerun.`,
      EXIT_ERROR,
    );
  }
  log("doctor: all checks passed (read-only).");
}

/**
 * @param {import('./state.mjs').SetupState} state
 */
function requiredEnvKeys(state) {
  /** @type {string[]} */
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

/**
 * @param {SetupContext} ctx
 * @param {(name: string, ok: boolean, detail: string) => void} note
 * @param {string} name
 * @param {readonly [string, ...string[]]} argv
 * @param {RegExp} pattern
 */
async function checkLocalBinary(ctx, note, name, argv, pattern) {
  try {
    const result = await ctx.executor({
      command: argv[0],
      args: argv.slice(1),
      allowNonZero: true,
    });
    const text = `${result.stdout}\n${result.stderr}`;
    // ssh -V writes to stderr and may use exit 0
    const matched = pattern.test(text);
    note(
      name,
      matched || (result.exitCode === 0 && text.trim() !== ""),
      text.trim().split("\n")[0] ?? "present",
    );
  } catch (error) {
    note(name, false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {SetupContext} ctx
 * @param {(name: string, ok: boolean, detail: string) => void} note
 */
async function checkAwsCliV2(ctx, note) {
  try {
    const result = await ctx.executor({
      command: "aws",
      args: ["--version"],
      allowNonZero: true,
    });
    const text = `${result.stdout} ${result.stderr}`;
    const ok = /aws-cli\/2\./u.test(text);
    note(
      "aws-cli",
      ok,
      ok ? (text.trim().split("\n")[0] ?? "aws-cli/2") : `expected AWS CLI v2, got: ${text.trim()}`,
    );
  } catch (error) {
    note("aws-cli", false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {SetupContext} ctx
 * @param {(name: string, ok: boolean, detail: string) => void} note
 * @param {import('./state.mjs').SetupState} state
 */
async function checkAwsCaller(ctx, note, state) {
  try {
    const result = await ctx.executor({
      command: "aws",
      args: [
        "sts",
        "get-caller-identity",
        "--profile",
        state.config.awsProfile,
        "--region",
        state.config.awsRegion,
        "--output",
        "json",
      ],
    });
    const identity = JSON.parse(result.stdout);
    const account = String(identity.Account ?? "");
    const ok = account === state.config.awsAccountId;
    note(
      "aws-caller",
      ok,
      ok
        ? `account ${account} region ${state.config.awsRegion} via profile ${state.config.awsProfile}`
        : `account mismatch: expected ${state.config.awsAccountId}, got ${account || "unknown"}`,
    );
  } catch (error) {
    note("aws-caller", false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {SetupContext} ctx
 * @param {(name: string, ok: boolean, detail: string) => void} note
 * @param {import('./state.mjs').SetupState} state
 */
async function checkSshHostKeyPolicy(ctx, note, state) {
  try {
    const host = state.config.sshTarget.includes("@")
      ? (state.config.sshTarget.split("@").at(-1) ?? state.config.sshTarget)
      : state.config.sshTarget;
    const result = await ctx.executor({
      command: "ssh",
      args: ["-G", host],
    });
    const match = /^stricthostkeychecking\s+(\S+)/imu.exec(result.stdout);
    const value = match?.[1]?.toLowerCase() ?? "";
    const ok = value === "yes" || value === "accept-new";
    note(
      "ssh-host-key",
      ok,
      ok
        ? `StrictHostKeyChecking=${value}`
        : `StrictHostKeyChecking=${value || "unknown"} (require yes or accept-new)`,
    );
  } catch (error) {
    note("ssh-host-key", false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {SetupContext} ctx
 * @param {(name: string, ok: boolean, detail: string) => void} note
 * @param {import('./state.mjs').SetupState} state
 */
async function checkRemoteDockerCompose(ctx, note, state) {
  try {
    const git = await ctx.executor({
      command: "ssh",
      args: [state.config.sshTarget, "git", "--version"],
    });
    const text = `${git.stdout} ${git.stderr}`.trim();
    const ok = /^git version\b/iu.test(text);
    note("remote-git", ok, ok ? text : `expected Git, got: ${text || "no version output"}`);
  } catch (error) {
    note("remote-git", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const docker = await ctx.executor({
      command: "ssh",
      args: [state.config.sshTarget, "docker", "version", "--format", "{{.Server.Version}}"],
    });
    note("remote-docker", true, `Docker ${docker.stdout.trim() || "ok"}`);
  } catch (error) {
    note("remote-docker", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const compose = await ctx.executor({
      command: "ssh",
      args: [state.config.sshTarget, "docker", "compose", "version"],
    });
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
    note("remote-compose", ok, detail);
  } catch (error) {
    note("remote-compose", false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {SetupContext} ctx
 * @param {boolean} refresh
 */
export async function runStatus(ctx, refresh) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);
  const view = publicStatusView(state);

  log(`Installation: ${view.installationId}`);
  log(`Domain: ${view.config.domain}`);
  log(`Release: ${view.config.releaseTag}`);
  log(`Updated: ${view.updatedAt}`);
  log("Stages:");
  const completed = new Set(Object.keys(view.stages));
  if (completed.has("init")) {
    log(`  init: complete (${view.stages.init?.completedAt ?? ""})`);
  } else {
    log("  init: missing");
  }
  for (const stageId of STAGE_ORDER) {
    if (completed.has(stageId)) {
      log(`  ${stageId}: complete (${view.stages[stageId]?.completedAt ?? ""})`);
    } else {
      log(`  ${stageId}: pending`);
    }
  }

  if (!refresh) {
    log(
      "Provider state: local-only (stale/unknown). Re-run with --refresh for opt-in provider checks and drift detection.",
    );
    return;
  }

  log("Provider refresh (opt-in; drift detection updates AWS drift metadata only):");
  const summary = await runProviderRefresh(ctx, state);
  for (const [key, value] of Object.entries(summary)) {
    if (key === "checkedAt") continue;
    const item = value && typeof value === "object" ? value : { status: "unavailable" };
    const label = key === "caller" ? "aws-caller" : key === "remote" ? "remote-compose" : key;
    log(`  ${label}: ${item.status ?? "unknown"} ${JSON.stringify(item)}`);
  }
  log(`  checkedAt: ${summary.checkedAt}`);
}

/**
 * @param {SetupContext} ctx
 */
export async function runContinue(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);

  if (state.stages.init?.status !== "complete") {
    throw new SetupError("init has not completed. Run `pnpm nusend:setup init` first.");
  }

  const handlers = { ...defaultStageHandlers(), ...(ctx.stageHandlers ?? {}) };
  const selected = STAGE_ORDER.find((stageId) => state.stages[stageId]?.status !== "complete");

  if (!selected) {
    log("Nothing to continue; all known stages are complete.");
    return;
  }

  const handler = handlers[selected];
  if (!handler) {
    throw new SetupError(
      `Next stage "${selected}" is not ready in this release yet. Use status to inspect progress; provider commands remain available once implemented.`,
      EXIT_ERROR,
    );
  }

  const eligible = handler.isEligible ? await handler.isEligible(ctx, state) : true;
  if (!eligible) {
    throw new SetupError(
      `Next stage "${selected}" is blocked until its prerequisites are met. Run doctor/status for details.`,
      EXIT_ERROR,
    );
  }

  log(`Running one stage: ${selected}`);
  const evidence = await handler.run(ctx, state);
  if (
    evidence != null &&
    typeof evidence === "object" &&
    evidence.progress === true &&
    evidence.verified !== true
  ) {
    // Human/external gates may record one evidence step without completing the stage.
    log(
      `Stage "${selected}" recorded progress for one next action; checkpoint not written. Rerun continue.`,
    );
    return;
  }
  if (evidence == null || typeof evidence !== "object" || evidence.verified !== true) {
    throw new SetupError(
      `Stage "${selected}" finished without verified evidence; checkpoint not written (exit status alone is insufficient).`,
      EXIT_ERROR,
    );
  }

  // Stage handlers may persist validation, gate, or simulator evidence while they run.
  // Checkpoint against the latest state so that evidence is not overwritten by this stage write.
  const latestState = await loadState(installationId, ctx.env);
  await checkpointStage(latestState, selected, evidence, ctx.env);
  log(`Stage "${selected}" checkpointed with verified evidence.`);
}

/**
 * Default stage handlers. Later tasks add deploy/validate handlers.
 * Tests may override via SetupContext.stageHandlers.
 * @returns {Record<string, StageHandler>}
 */
export function defaultStageHandlers() {
  return {
    aws_core: awsCoreStageHandler,
    human_gates: humanGatesStageHandler,
    deploy: deployStageHandler,
    aws_finalize: awsFinalizeStageHandler,
    validate_pre_simulator: preSimulatorStageHandler,
    validate_simulator: simulatorStageHandler,
    validate_final: finalValidationStageHandler,
  };
}

/**
 * CLI entry when executed directly.
 * @param {readonly string[]} argv
 * @param {Partial<SetupContext>} [options]
 */
export async function runMain(argv = process.argv.slice(2), options = {}) {
  return runSetup(argv, options);
}

/**
 * @param {string | undefined} argv1
 * @param {string} metaUrl
 */
export function isMainEntry(argv1, metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === metaUrl;
  } catch {
    try {
      return pathToFileURL(argv1).href === metaUrl;
    } catch {
      return false;
    }
  }
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  runMain()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = EXIT_ERROR;
    });
}
