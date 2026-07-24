import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STATE_SCHEMA_VERSION = 1;
export const INSTALLATION_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/u;
export const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u;
export const CURRENT_POINTER_NAME = "current";
export const STATE_FILE_NAME = "state.json";
export const ENV_FILE_NAME = "deployment.env";

/** Keys that must never appear in state.json, status, plans, or logs. */
export const SECRET_ENV_KEYS = Object.freeze([
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "NUSEND_API_KEY_HASH_SECRET",
  "NUSEND_UNSUBSCRIBE_SECRET",
  "NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "NUSEND_R2_SECRET_ACCESS_KEY",
  "NUSEND_RESTIC_PASSWORD",
]);

const SECRET_ENV_KEY_SET = new Set(SECRET_ENV_KEYS);

/** Non-secret deployment.env keys from the production contract. */
export const DEPLOYMENT_ENV_KEYS = Object.freeze([
  "NUSEND_DOMAIN",
  "NUSEND_INGRESS_MODE",
  "NUSEND_OWNER_EMAIL",
  "NUSEND_OWNER_NAME",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "NUSEND_API_KEY_HASH_SECRET",
  "NUSEND_UNSUBSCRIBE_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "NUSEND_SES_FROM_EMAIL",
  "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET",
  "NUSEND_SES_MARKETING_CONFIGURATION_SET",
  "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
  "NUSEND_SES_TRACKING_EVENTS",
  "NUSEND_SES_TRACKING_CUSTOM_REDIRECT_DOMAIN",
  "NUSEND_RESTIC_REPOSITORY",
  "NUSEND_R2_ACCESS_KEY_ID",
  "NUSEND_R2_SECRET_ACCESS_KEY",
  "NUSEND_RESTIC_PASSWORD",
]);

/**
 * @typedef {Partial<Record<string, string | undefined>>} PathEnvironment
 */

/**
 * @typedef {object} SetupStateConfig
 * @property {string} releaseTag
 * @property {string} domain
 * @property {"direct" | "cloudflare"} ingressMode
 * @property {string} ownerEmail
 * @property {string} ownerName
 * @property {string} awsProfile
 * @property {string} awsRegion
 * @property {string} awsAccountId
 * @property {string} sesIdentity
 * @property {string} sesFromEmail
 * @property {boolean} marketingEnabled
 * @property {boolean} trackingEnabled
 * @property {string} alertEmail
 * @property {string | null} route53HostedZoneId
 * @property {string} sshTarget
 * @property {string} remotePath
 * @property {string} [installationName]
 */

/**
 * @typedef {object} StageCheckpoint
 * @property {"complete"} status
 * @property {string} completedAt
 * @property {Record<string, unknown>} evidence
 */

/**
 * Non-secret AWS stack ownership, identity, production-access, and runtime key evidence.
 * Secrets never appear here (runtime secret lives only in deployment.env).
 * @typedef {object} SetupAwsState
 * @property {Record<string, unknown>} [stack]
 * @property {Record<string, unknown>} [stackCreation]
 * @property {string} [runtimeAccessKeyId]
 * @property {Record<string, unknown>} [productionAccess]
 * @property {Record<string, unknown>} [identity]
 */

/**
 * Non-secret deploy ownership/evidence after a healthy apply.
 * @typedef {Record<string, unknown>} SetupDeployState
 */

/**
 * @typedef {object} SetupState
 * @property {1} schemaVersion
 * @property {string} installationId
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {SetupStateConfig} config
 * @property {Record<string, StageCheckpoint>} stages
 * @property {Record<string, Record<string, unknown>>} plans
 * @property {SetupAwsState} [aws]
 * @property {SetupDeployState} [deploy]
 */

/**
 * @param {PathEnvironment} [env]
 */
export function setupHome(env = process.env) {
  const override = env.NUSEND_SETUP_HOME?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || homedir();
  return join(home, ".config", "nusend", "setup");
}

/**
 * @param {string} installationId
 */
export function assertInstallationId(installationId) {
  if (
    typeof installationId !== "string" ||
    !INSTALLATION_ID_PATTERN.test(installationId) ||
    installationId === CURRENT_POINTER_NAME
  ) {
    throw new Error(
      `Invalid installation id "${installationId}". Use a conservative slug: lowercase letter, then 0-30 lowercase letters, digits, or hyphens (max 31 characters).`,
    );
  }
  return installationId;
}

/**
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export function installationDirectory(installationId, env = process.env) {
  return join(setupHome(env), assertInstallationId(installationId));
}

/**
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export function stateFilePath(installationId, env = process.env) {
  return join(installationDirectory(installationId, env), STATE_FILE_NAME);
}

/**
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export function envFilePath(installationId, env = process.env) {
  return join(installationDirectory(installationId, env), ENV_FILE_NAME);
}

/**
 * @param {PathEnvironment} [env]
 */
export function currentPointerPath(env = process.env) {
  return join(setupHome(env), CURRENT_POINTER_NAME);
}

/**
 * Resolve the active installation id from env override, then the mode-0600 pointer.
 * @param {PathEnvironment} [env]
 */
export async function resolveInstallationId(env = process.env) {
  const fromEnv = env.NUSEND_SETUP_INSTALLATION?.trim();
  if (fromEnv) return assertInstallationId(fromEnv);

  const pointer = currentPointerPath(env);
  try {
    await assertSymlinkFreePath(setupHome(env), "Setup home");
    await assertPrivateFile(pointer, "Installation pointer");
    const raw = await readFile(pointer, "utf8");
    const id = raw.trim();
    if (!id) {
      throw new Error(
        "Installation pointer is empty. Run `pnpm nusend:setup init` or set NUSEND_SETUP_INSTALLATION.",
      );
    }
    return assertInstallationId(id);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        "No active installation. Run `pnpm nusend:setup init` or set NUSEND_SETUP_INSTALLATION.",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export async function writeCurrentPointer(installationId, env = process.env) {
  const id = assertInstallationId(installationId);
  const home = setupHome(env);
  await assertSymlinkFreePath(home, "Setup home");
  await ensurePrivateDirectory(home);
  await writeAtomicFile(currentPointerPath(env), `${id}\n`, { mode: 0o600 });
}

/**
 * @param {string} bytes
 */
export function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

/**
 * @param {string} tag
 */
export function assertReleaseTag(tag) {
  if (typeof tag !== "string" || !RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid release tag "${tag}". Expected a conservative tag like v1.2.3.`);
  }
  return tag;
}

/**
 * @param {string} path
 */
export function assertAbsolutePosixPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Remote path must be an absolute POSIX path (got "${path}").`);
  }
  if (path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`Remote path must not contain relative segments (got "${path}").`);
  }
  return path;
}

/**
 * Parse KEY=VALUE env files without shell expansion.
 * Rejects exports, shell syntax, and duplicate keys.
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseEnvFile(raw) {
  if (typeof raw !== "string") {
    throw new Error("deployment.env must be a UTF-8 string.");
  }
  /** @type {Record<string, string>} */
  const out = {};
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line == null) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^(export|unset)\b/u.test(trimmed)) {
      throw new Error(`deployment.env line ${index + 1}: shell directives are not allowed.`);
    }
    const match = /^(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/u.exec(line);
    if (!match?.groups) {
      throw new Error(`deployment.env line ${index + 1}: expected KEY=VALUE.`);
    }
    const { key, value } = match.groups;
    if (Object.hasOwn(out, key)) {
      throw new Error(`deployment.env line ${index + 1}: duplicate key ${key}.`);
    }
    out[key] = unquoteEnvValue(value, index + 1);
  }
  return out;
}

/**
 * @param {Record<string, string | undefined | null>} values
 */
export function serializeEnvFile(values) {
  const lines = [];
  for (const key of DEPLOYMENT_ENV_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (value == null) continue;
    lines.push(`${key}=${quoteEnvValue(String(value))}`);
  }
  // Preserve additional valid keys in stable order, including known secrets absent from the
  // primary ordering.
  const extras = Object.keys(values)
    .filter((key) => !DEPLOYMENT_ENV_KEYS.includes(key))
    .sort((a, b) => a.localeCompare(b));
  for (const key of extras) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid env key "${key}".`);
    }
    const value = values[key];
    if (value == null) continue;
    lines.push(`${key}=${quoteEnvValue(String(value))}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * @param {string} value
 * @param {number} lineNumber
 */
function unquoteEnvValue(value, lineNumber) {
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new Error(`deployment.env line ${lineNumber}: unterminated single quote.`);
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new Error(`deployment.env line ${lineNumber}: unterminated double quote.`);
    }
    const body = value.slice(1, -1);
    if (/\\([^nrt"\\])/u.test(body)) {
      throw new Error(`deployment.env line ${lineNumber}: unsupported escape sequence.`);
    }
    return body
      .replace(/\\n/gu, "\n")
      .replace(/\\r/gu, "\r")
      .replace(/\\t/gu, "\t")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }
  if (/[\s#]/u.test(value) || value.includes("'") || value.includes('"')) {
    throw new Error(
      `deployment.env line ${lineNumber}: unquoted values must not contain whitespace, quotes, or #.`,
    );
  }
  if (value.startsWith("$") || value.includes("`") || value.includes("$(")) {
    throw new Error(`deployment.env line ${lineNumber}: shell expansion is not allowed.`);
  }
  return value;
}

/**
 * @param {string} value
 */
function quoteEnvValue(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/u.test(value)) return value;
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")}"`;
}

/**
 * @param {unknown} value
 * @returns {SetupState}
 */
export function parseState(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state.json must be a JSON object.");
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported state schema version ${String(raw.schemaVersion)}. Expected ${STATE_SCHEMA_VERSION}.`,
    );
  }
  if (typeof raw.installationId !== "string") {
    throw new Error("state.json missing installationId.");
  }
  assertInstallationId(raw.installationId);
  if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") {
    throw new Error("state.json missing timestamps.");
  }
  const config = parseConfig(raw.config);
  const stages = parseStages(raw.stages);
  const plans = parsePlans(raw.plans);
  /** @type {SetupState} */
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    installationId: raw.installationId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    config,
    stages,
    plans,
  };
  if (raw.aws !== undefined) {
    state.aws = parseAwsState(raw.aws);
  }
  if (raw.deploy !== undefined) {
    state.deploy = parseDeployState(raw.deploy);
  }
  return state;
}

/**
 * @param {unknown} value
 * @returns {SetupDeployState}
 */
function parseDeployState(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state.json deploy must be an object when present.");
  }
  return sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (value));
}

/**
 * @param {unknown} value
 * @returns {SetupAwsState}
 */
function parseAwsState(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state.json aws must be an object when present.");
  }
  const sanitized = sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (value));
  /** @type {SetupAwsState} */
  const aws = {};
  if (sanitized.stack !== undefined) {
    if (
      sanitized.stack == null ||
      typeof sanitized.stack !== "object" ||
      Array.isArray(sanitized.stack)
    ) {
      throw new Error("state.json aws.stack must be an object when present.");
    }
    aws.stack = /** @type {Record<string, unknown>} */ (sanitized.stack);
  }
  if (sanitized.stackCreation !== undefined) {
    if (
      sanitized.stackCreation == null ||
      typeof sanitized.stackCreation !== "object" ||
      Array.isArray(sanitized.stackCreation)
    ) {
      throw new Error("state.json aws.stackCreation must be an object when present.");
    }
    aws.stackCreation = /** @type {Record<string, unknown>} */ (sanitized.stackCreation);
  }
  if (sanitized.runtimeAccessKeyId !== undefined) {
    if (
      typeof sanitized.runtimeAccessKeyId !== "string" ||
      sanitized.runtimeAccessKeyId.trim() === ""
    ) {
      throw new Error("state.json aws.runtimeAccessKeyId must be a non-empty string when present.");
    }
    aws.runtimeAccessKeyId = sanitized.runtimeAccessKeyId.trim();
  }
  if (sanitized.productionAccess !== undefined) {
    if (
      sanitized.productionAccess == null ||
      typeof sanitized.productionAccess !== "object" ||
      Array.isArray(sanitized.productionAccess)
    ) {
      throw new Error("state.json aws.productionAccess must be an object when present.");
    }
    aws.productionAccess = /** @type {Record<string, unknown>} */ (sanitized.productionAccess);
  }
  if (sanitized.identity !== undefined) {
    if (
      sanitized.identity == null ||
      typeof sanitized.identity !== "object" ||
      Array.isArray(sanitized.identity)
    ) {
      throw new Error("state.json aws.identity must be an object when present.");
    }
    aws.identity = /** @type {Record<string, unknown>} */ (sanitized.identity);
  }
  return aws;
}

/**
 * @param {unknown} value
 * @returns {SetupStateConfig}
 */
function parseConfig(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state.json config must be an object.");
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  const ingressMode = raw.ingressMode;
  if (ingressMode !== "direct" && ingressMode !== "cloudflare") {
    throw new Error('state.json config.ingressMode must be "direct" or "cloudflare".');
  }
  /** @type {SetupStateConfig} */
  const config = {
    releaseTag: assertReleaseTag(String(raw.releaseTag ?? "")),
    domain: requireNonEmptyString(raw.domain, "config.domain"),
    ingressMode,
    ownerEmail: requireNonEmptyString(raw.ownerEmail, "config.ownerEmail"),
    ownerName: requireNonEmptyString(raw.ownerName, "config.ownerName"),
    awsProfile: requireNonEmptyString(raw.awsProfile, "config.awsProfile"),
    awsRegion: requireNonEmptyString(raw.awsRegion, "config.awsRegion"),
    awsAccountId: requireAccountId(raw.awsAccountId),
    sesIdentity: requireNonEmptyString(raw.sesIdentity, "config.sesIdentity"),
    sesFromEmail: requireNonEmptyString(raw.sesFromEmail, "config.sesFromEmail"),
    marketingEnabled: Boolean(raw.marketingEnabled),
    trackingEnabled: Boolean(raw.trackingEnabled),
    alertEmail: requireNonEmptyString(raw.alertEmail, "config.alertEmail"),
    route53HostedZoneId:
      raw.route53HostedZoneId == null || raw.route53HostedZoneId === ""
        ? null
        : requireNonEmptyString(raw.route53HostedZoneId, "config.route53HostedZoneId"),
    sshTarget: requireNonEmptyString(raw.sshTarget, "config.sshTarget"),
    remotePath: assertAbsolutePosixPath(String(raw.remotePath ?? "")),
  };
  if (raw.installationName != null) {
    config.installationName = requireNonEmptyString(
      raw.installationName,
      "config.installationName",
    );
  }
  return config;
}

/**
 * @param {unknown} value
 */
function parseStages(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state.json stages must be an object.");
  }
  /** @type {Record<string, StageCheckpoint>} */
  const out = {};
  for (const [name, checkpoint] of Object.entries(value)) {
    if (checkpoint == null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
      throw new Error(`state.json stages.${name} must be an object.`);
    }
    const raw = /** @type {Record<string, unknown>} */ (checkpoint);
    if (raw.status !== "complete") {
      throw new Error(`state.json stages.${name}.status must be "complete".`);
    }
    if (typeof raw.completedAt !== "string") {
      throw new Error(`state.json stages.${name}.completedAt must be a string.`);
    }
    if (raw.evidence == null || typeof raw.evidence !== "object" || Array.isArray(raw.evidence)) {
      throw new Error(`state.json stages.${name}.evidence must be an object.`);
    }
    const evidence = sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (raw.evidence));
    if (evidence.verified !== true) {
      throw new Error(
        `state.json stages.${name}.evidence.verified must be true (exit status alone is not evidence).`,
      );
    }
    out[name] = {
      status: "complete",
      completedAt: raw.completedAt,
      evidence,
    };
  }
  return out;
}

/**
 * @param {unknown} value
 */
function parsePlans(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("state.json plans must be an object.");
  }
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {};
  for (const [name, plan] of Object.entries(value)) {
    if (plan == null || typeof plan !== "object" || Array.isArray(plan)) {
      throw new Error(`state.json plans.${name} must be an object.`);
    }
    out[name] = sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (plan));
  }
  return out;
}

/**
 * Remove secret-bearing keys from plan/status metadata.
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
export function sanitizePlanMetadata(input) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_ENV_KEY_SET.has(key) || isSecretishKey(key)) continue;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (value));
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item != null && typeof item === "object" && !Array.isArray(item)
          ? sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (item))
          : item,
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {string} key
 */
function isSecretishKey(key) {
  return /(password|secret|token|access_key|private)/iu.test(key);
}

/**
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 * @returns {Promise<SetupState>}
 */
export async function loadState(installationId, env = process.env) {
  const path = stateFilePath(installationId, env);
  await assertSymlinkFreePath(setupHome(env), "Setup home");
  await assertPrivateFile(path, "State file");
  await assertPrivateDirectory(
    installationDirectory(installationId, env),
    "Installation directory",
  );
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `Installation "${installationId}" has no state.json. Run \`pnpm nusend:setup init\`.`,
        { cause: error },
      );
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`state.json for "${installationId}" is malformed JSON.`, { cause: error });
  }
  return parseState(parsed);
}

/**
 * @param {SetupState} state
 * @param {PathEnvironment} [env]
 * @param {{ beforeRename?: (destination: string, temporary: string) => Promise<void> }} [hooks]
 */
export async function writeState(state, env = process.env, hooks = {}) {
  const validated = parseState(state);
  const destination = stateFilePath(validated.installationId, env);
  const directory = installationDirectory(validated.installationId, env);
  await assertSymlinkFreePath(setupHome(env), "Setup home");
  await ensurePrivateDirectory(setupHome(env));
  await ensurePrivateDirectory(directory);
  const body = `${JSON.stringify(validated, null, 2)}\n`;
  await writeAtomicFile(destination, body, { mode: 0o600, hooks });
  return validated;
}

/**
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export async function loadDeploymentEnv(installationId, env = process.env) {
  const path = envFilePath(installationId, env);
  await assertSymlinkFreePath(setupHome(env), "Setup home");
  await assertPrivateFile(path, "deployment.env");
  await assertPrivateDirectory(
    installationDirectory(installationId, env),
    "Installation directory",
  );
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `Installation "${installationId}" has no deployment.env. Run \`pnpm nusend:setup init\`.`,
        { cause: error },
      );
    }
    throw error;
  }
  return parseEnvFile(raw);
}

/**
 * @param {string} installationId
 * @param {Record<string, string | undefined | null>} values
 * @param {PathEnvironment} [env]
 * @param {{ beforeRename?: (destination: string, temporary: string) => Promise<void> }} [hooks]
 */
export async function writeDeploymentEnv(installationId, values, env = process.env, hooks = {}) {
  assertInstallationId(installationId);
  const destination = envFilePath(installationId, env);
  const directory = installationDirectory(installationId, env);
  await assertSymlinkFreePath(setupHome(env), "Setup home");
  await ensurePrivateDirectory(setupHome(env));
  await ensurePrivateDirectory(directory);
  const body = serializeEnvFile(values);
  // Round-trip to reject malformed content before writing.
  parseEnvFile(body);
  await writeAtomicFile(destination, body, { mode: 0o600, hooks });
}

/**
 * Checkpoint a stage only when evidence.verified === true.
 * @param {SetupState} state
 * @param {string} stageId
 * @param {Record<string, unknown>} evidence
 * @param {PathEnvironment} [env]
 */
export async function checkpointStage(state, stageId, evidence, env = process.env) {
  if (!stageId || typeof stageId !== "string") {
    throw new Error("stageId is required.");
  }
  const sanitized = sanitizePlanMetadata(evidence);
  if (sanitized.verified !== true) {
    throw new Error(
      `Refusing to checkpoint stage "${stageId}" without verified evidence (process exit alone is insufficient).`,
    );
  }
  const now = new Date().toISOString();
  /** @type {SetupState} */
  const next = {
    ...state,
    updatedAt: now,
    stages: {
      ...state.stages,
      [stageId]: {
        status: "complete",
        completedAt: now,
        evidence: sanitized,
      },
    },
  };
  return writeState(next, env);
}

/**
 * Reject symlinks among existing components of a path.
 * Missing trailing components are allowed (create paths).
 * Root-level platform compatibility symlinks (macOS /tmp,/var,/etc) are permitted so
 * legitimate OS roots are not rejected; every deeper component must be symlink-free.
 * Does not enforce permission bits on ancestor platform directories.
 * @param {string} targetPath
 * @param {string} label
 */
export async function assertSymlinkFreePath(targetPath, label) {
  if (process.platform === "win32") return;
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    throw new Error(`${label} path is required.`);
  }

  const absolute = targetPath.startsWith("/") ? targetPath : join(process.cwd(), targetPath);
  const segments = absolute.split("/").filter((segment) => segment.length > 0);
  let current = absolute.startsWith("/") ? "/" : "";

  for (const segment of segments) {
    current = current === "/" ? `/${segment}` : `${current}/${segment}`;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      // macOS exposes these fixed system roots as compatibility symlinks.
      const platformAliases = new Set(["/etc", "/tmp", "/var"]);
      if (process.platform !== "darwin" || !platformAliases.has(current)) {
        throw new Error(`${label} path must not contain a symlink (${current}).`);
      }
    }
  }
}

/**
 * Refuse to initialize over an existing installation directory, state, or env.
 * Call before any init writes so prior bytes are preserved.
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export async function assertInstallationNotInitialized(installationId, env = process.env) {
  const id = assertInstallationId(installationId);
  const directory = installationDirectory(id, env);
  await assertSymlinkFreePath(directory, "Installation directory");

  /** @type {Array<[string, string]>} */
  const candidates = [
    [stateFilePath(id, env), "state.json"],
    [envFilePath(id, env), "deployment.env"],
    [directory, "installation directory"],
  ];

  for (const [path, label] of candidates) {
    try {
      await lstat(path);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    throw new Error(
      `Installation "${id}" already exists (${label} at ${path}). Refusing to overwrite existing state, deployment.env, or secrets. Choose a new installation id or continue the existing installation.`,
    );
  }

  return id;
}

/**
 * Atomically reserve a previously absent installation directory before init writes.
 * This closes the same-id race between the read-only preflight and durable persistence.
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export async function reserveInstallationDirectory(installationId, env = process.env) {
  const id = assertInstallationId(installationId);
  const home = setupHome(env);
  const directory = installationDirectory(id, env);
  await assertSymlinkFreePath(home, "Setup home");
  await ensurePrivateDirectory(home);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && /** @type {any} */ (error).code === "EEXIST") {
      throw new Error(
        `Installation "${id}" already exists at ${directory}. Refusing concurrent or duplicate initialization.`,
        { cause: error },
      );
    }
    throw error;
  }
  await assertPrivateDirectory(directory, "Installation directory");
  return id;
}

/**
 * Remove init artifacts only when the installation was not published as current.
 * A pointer read error is ambiguous, so retain the artifacts for manual inspection.
 * The current pointer itself is never changed here.
 * @param {string} installationId
 * @param {PathEnvironment} [env]
 */
export async function removeUnpublishedInstallation(installationId, env = process.env) {
  const id = assertInstallationId(installationId);
  try {
    const current = (await readFile(currentPointerPath(env), "utf8")).trim();
    if (current === id) return false;
  } catch (error) {
    if (!isNotFound(error)) return false;
  }

  const directory = installationDirectory(id, env);
  await assertSymlinkFreePath(directory, "Installation directory");
  await rm(directory, { force: true, recursive: true });
  return true;
}

/**
 * @param {string} destination
 * @param {string} body
 * @param {{ mode?: number, hooks?: { beforeRename?: (destination: string, temporary: string) => Promise<void> } }} [options]
 */
export async function writeAtomicFile(destination, body, options = {}) {
  const mode = options.mode ?? 0o600;
  const hooks = options.hooks ?? {};
  const directory = dirname(destination);

  await assertSymlinkFreePath(destination, "Destination");

  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink at ${destination}.`);
    }
    if (process.platform !== "win32") {
      const existingMode = existing.mode & 0o777;
      if ((existingMode & 0o077) !== 0) {
        throw new Error(
          `Refusing to overwrite ${destination}: permissions ${existingMode.toString(8)} are too broad (expected mode 0600).`,
        );
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.(destination, temporary);
    await rename(temporary, destination);
    if (process.platform !== "win32") await chmod(destination, mode);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

/**
 * Create a mode-0700 directory when missing. Existing directories must already be
 * private and symlink-free; broad modes are rejected rather than repaired.
 * @param {string} directory
 */
export async function ensurePrivateDirectory(directory) {
  await assertSymlinkFreePath(directory, "Directory");

  if (process.platform === "win32") {
    await mkdir(directory, { mode: 0o700, recursive: true });
    return;
  }

  try {
    const existing = await lstat(directory);
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked directory ${directory}.`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`Expected a directory at ${directory}.`);
    }
    const existingMode = existing.mode & 0o777;
    if ((existingMode & 0o077) !== 0) {
      throw new Error(
        `Directory permissions for ${directory} are too broad (${existingMode.toString(8)}); expected 0700.`,
      );
    }
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked directory ${directory}.`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Expected a directory at ${directory}.`);
  }
  // Only newly created directories are normalized to 0700 (umask-safe).
  await chmod(directory, 0o700);
  const mode = (await stat(directory)).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `Directory permissions for ${directory} are too broad (${mode.toString(8)}); expected 0700.`,
    );
  }
}

/**
 * @param {string} path
 * @param {string} label
 */
export async function assertPrivateDirectory(path, label) {
  if (process.platform === "win32") return;
  await assertSymlinkFreePath(path, label);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink (${path}).`);
  }
  if (!info.isDirectory()) {
    throw new Error(`${label} must be a directory (${path}).`);
  }
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions are too broad (${mode.toString(8)}). Expected mode 0700 at ${path}.`,
    );
  }
}

/**
 * @param {string} path
 * @param {string} label
 */
export async function assertPrivateFile(path, label) {
  if (process.platform === "win32") return;
  await assertSymlinkFreePath(path, label);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink (${path}).`);
  }
  if (!info.isFile()) {
    throw new Error(`${label} must be a regular file (${path}).`);
  }
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${label} permissions are too broad (${mode.toString(8)}). Expected mode 0600 at ${path}.`,
    );
  }
}

/**
 * Collect secret values from a deployment env map for redaction.
 * @param {Record<string, string>} envMap
 */
export function secretValuesFromEnv(envMap) {
  /** @type {string[]} */
  const secrets = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = envMap[key];
    if (typeof value === "string" && value.length >= 4) secrets.push(value);
  }
  return secrets;
}

/**
 * @param {SetupState} state
 */
export function publicStatusView(state) {
  /** @type {Record<string, unknown>} */
  const view = {
    installationId: state.installationId,
    schemaVersion: state.schemaVersion,
    updatedAt: state.updatedAt,
    config: { ...state.config },
    stages: Object.fromEntries(
      Object.entries(state.stages).map(([id, checkpoint]) => [
        id,
        {
          status: checkpoint.status,
          completedAt: checkpoint.completedAt,
          evidence: sanitizePlanMetadata(checkpoint.evidence),
        },
      ]),
    ),
    plans: Object.fromEntries(
      Object.entries(state.plans).map(([id, plan]) => [id, sanitizePlanMetadata(plan)]),
    ),
  };
  if (state.aws) {
    view.aws = sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (state.aws));
  }
  if (state.deploy) {
    view.deploy = sanitizePlanMetadata(/** @type {Record<string, unknown>} */ (state.deploy));
  }
  return view;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 */
function requireAccountId(value) {
  const text = requireNonEmptyString(value, "config.awsAccountId");
  if (!/^\d{12}$/u.test(text)) {
    throw new Error("config.awsAccountId must be a 12-digit AWS account id.");
  }
  return text;
}

/**
 * @param {string} directory
 */
async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * @param {unknown} error
 */
function isUnsupportedDirectorySync(error) {
  return ["EINVAL", "ENOTSUP", "EBADF"].some((code) => hasCode(error, code));
}

/**
 * @param {unknown} error
 */
export function isNotFound(error) {
  return hasCode(error, "ENOENT");
}

/**
 * @param {unknown} error
 * @param {string} code
 */
function hasCode(error, code) {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
