import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadDeploymentEnv,
  loadState,
  resolveInstallationId,
  sanitizePlanMetadata,
  writeDeploymentEnv,
  writeState,
} from "./state.mjs";

export const AWS_PLAN_KEY = "aws";
export const STACK_NAME_PREFIX = "nusend-";
export const CHANGE_SET_NAME_PREFIX = "nusend-";
export const APPLY_PHRASE_PREFIX = "APPLY";
export const REQUEST_PRODUCTION_ACCESS_PHRASE = "REQUEST-PRODUCTION-ACCESS";
export const CREATE_RUNTIME_KEY_PHRASE = "CREATE-RUNTIME-KEY";
export const REQUIRED_CAPABILITY = "CAPABILITY_NAMED_IAM";
/** Durable apply checkpoint: provider succeeded; local env/state finalization may still be pending. */
export const APPLY_CHECKPOINT_LOCAL_FINALIZATION = "local-finalization";

export const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "aws",
  "nusend-stack.json",
);

/** Known non-secret stack outputs mapped into deployment.env. */
export const STACK_OUTPUT_ENV_MAP = Object.freeze({
  AwsRegion: "AWS_REGION",
  SesFromEmail: "NUSEND_SES_FROM_EMAIL",
  TransactionalConfigurationSetName: "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET",
  MarketingConfigurationSetName: "NUSEND_SES_MARKETING_CONFIGURATION_SET",
  FeedbackTopicArn: "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
  TrackingEvents: "NUSEND_SES_TRACKING_EVENTS",
});

/** Honest SES production-access brief fields (non-secret). */
export const PRODUCTION_BRIEF_FIELDS = Object.freeze([
  "website",
  "useCase",
  "mailType",
  "expectedVolume",
  "frequency",
  "recipientConsent",
  "unsubscribe",
  "bounceComplaintHandling",
  "formAbuseControls",
  "monitoring",
  "contactLanguage",
]);

const FABRICATED_PLACEHOLDERS = Object.freeze(
  new Set([
    "n/a",
    "na",
    "none",
    "null",
    "undefined",
    "todo",
    "tbd",
    "test",
    "testing",
    "example",
    "example.com",
    "www.example.com",
    "http://example.com",
    "https://example.com",
    "placeholder",
    "changeme",
    "fill me",
    "fillme",
    "xxx",
    "yyyy",
    "foo",
    "bar",
    "baz",
    "asdf",
    "qwerty",
    "sample",
    "dummy",
    "lorem",
    "lorem ipsum",
    "string",
    "value",
    "unknown",
  ]),
);

/**
 * @typedef {import('./state.mjs').SetupState} SetupState
 * @typedef {import('./main.mjs').SetupContext} SetupContext
 * @typedef {import('./process.mjs').RunProcessOptions} RunProcessOptions
 * @typedef {import('./process.mjs').RunProcessResult} RunProcessResult
 */

/**
 * @param {string} installationId
 */
export function buildStackName(installationId) {
  return `${STACK_NAME_PREFIX}${installationId}`;
}

/**
 * @param {string} installationId
 * @param {"core" | "finalize"} phase
 */
export function buildChangeSetName(installationId, phase) {
  return `${CHANGE_SET_NAME_PREFIX}${installationId}-${phase}`;
}

/**
 * Core until aws_core is complete; finalize once core is checkpointed (T6 eligibility still owns subscription safety).
 * @param {SetupState} state
 * @returns {"core" | "finalize"}
 */
export function determinePhase(state) {
  return state.stages.aws_core?.status === "complete" ? "finalize" : "core";
}

/**
 * @param {SetupState} state
 * @param {"core" | "finalize"} phase
 * @returns {ReadonlyArray<{ ParameterKey: string, ParameterValue: string }>}
 */
export function buildStackParameters(state, phase) {
  const installationName = state.config.installationName ?? state.installationId;
  const enableWebhook = phase === "finalize";
  return Object.freeze([
    { ParameterKey: "InstallationName", ParameterValue: installationName },
    { ParameterKey: "SesDomainIdentity", ParameterValue: state.config.sesIdentity },
    { ParameterKey: "SesFromEmail", ParameterValue: state.config.sesFromEmail },
    { ParameterKey: "PublicDomain", ParameterValue: state.config.domain },
    {
      ParameterKey: "EnableMarketing",
      ParameterValue: state.config.marketingEnabled ? "true" : "false",
    },
    {
      ParameterKey: "EnableTracking",
      ParameterValue: state.config.trackingEnabled ? "true" : "false",
    },
    { ParameterKey: "EnableDeliveryEvents", ParameterValue: "true" },
    {
      ParameterKey: "Route53HostedZoneId",
      ParameterValue: state.config.route53HostedZoneId ?? "",
    },
    { ParameterKey: "AlertEmail", ParameterValue: state.config.alertEmail },
    {
      ParameterKey: "EnableWebhookSubscription",
      ParameterValue: enableWebhook ? "true" : "false",
    },
  ]);
}

/**
 * @param {string} templateBody
 * @param {ReadonlyArray<{ ParameterKey: string, ParameterValue: string }>} parameters
 * @param {{ stackName: string, phase: string }} meta
 */
export function fingerprintTemplateAndParameters(templateBody, parameters, meta) {
  const canonical = JSON.stringify({
    stackName: meta.stackName,
    phase: meta.phase,
    template: templateBody,
    parameters: parameters.map((entry) => [entry.ParameterKey, entry.ParameterValue]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * @param {{ accountId: string, region: string, stackName: string, phase: string }} input
 */
export function buildApplyConfirmationPhrase(input) {
  return `${APPLY_PHRASE_PREFIX} ${input.accountId} ${input.region} ${input.stackName} ${input.phase}`;
}

/**
 * @param {string} answer
 * @param {{ accountId: string, region: string, stackName: string, phase: string }} expected
 */
export function validateApplyConfirmation(answer, expected) {
  const phrase = buildApplyConfirmationPhrase(expected);
  const trimmed = String(answer ?? "").trim();
  if (trimmed !== phrase) {
    throw new Error(`Confirmation rejected. Type exactly: ${phrase}`);
  }
  return phrase;
}

/**
 * @param {string} value
 */
export function isFabricatedPlaceholder(value) {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed.length < 3) return true;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (FABRICATED_PLACEHOLDERS.has(normalized)) return true;
  if (FABRICATED_PLACEHOLDERS.has(trimmed.toLowerCase())) return true;
  if (/^(x{3,}|y{3,}|z{3,}|\.{3,}|-{3,}|_{3,}|\d+)$/iu.test(trimmed)) return true;
  if (/example\.(com|org|net)/iu.test(trimmed)) return true;
  if (/^(test|todo|tbd|placeholder|changeme)\b/iu.test(trimmed)) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} brief
 * @returns {Record<string, string>}
 */
export function validateProductionBrief(brief) {
  if (brief == null || typeof brief !== "object" || Array.isArray(brief)) {
    throw new Error("Production-access brief must be an object.");
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const field of PRODUCTION_BRIEF_FIELDS) {
    const raw = brief[field];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`Production-access brief field "${field}" must be a non-empty string.`);
    }
    const value = raw.trim();
    // mailType and contactLanguage have dedicated enumerations below; skip generic placeholder heuristics for them.
    if (field !== "mailType" && field !== "contactLanguage" && isFabricatedPlaceholder(value)) {
      throw new Error(
        `Production-access brief field "${field}" looks blank or fabricated ("${value}"). Provide an honest operational answer.`,
      );
    }
    out[field] = value;
  }
  const mailType = out.mailType.toUpperCase();
  if (mailType !== "TRANSACTIONAL" && mailType !== "MARKETING") {
    throw new Error('Production-access brief field "mailType" must be TRANSACTIONAL or MARKETING.');
  }
  out.mailType = mailType;
  const language = out.contactLanguage.toUpperCase();
  if (!/^[A-Z]{2}$/u.test(language)) {
    throw new Error(
      'Production-access brief field "contactLanguage" must be a 2-letter code (e.g. EN).',
    );
  }
  out.contactLanguage = language;
  out.website = assertHonestWebsiteUrl(out.website);
  return out;
}

/**
 * Reject blank/fabricated and reserved-policy domains for the production-access website field.
 * @param {string} website
 */
export function assertHonestWebsiteUrl(website) {
  const value = String(website ?? "").trim();
  if (!/^https:\/\//iu.test(value)) {
    throw new Error('Production-access brief field "website" must be an https:// URL.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('Production-access brief field "website" must be a valid https:// URL.', {
      cause: error,
    });
  }
  if (parsed.protocol !== "https:") {
    throw new Error('Production-access brief field "website" must be an https:// URL.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(
      'Production-access brief field "website" must not use localhost or reserved local domains.',
    );
  }
  if (host.endsWith(".test") || host.endsWith(".invalid") || host.endsWith(".example")) {
    throw new Error(
      'Production-access brief field "website" must not use reserved domains (.test, .invalid, .example).',
    );
  }
  if (/(^|\.)example\.(com|net|org)$/u.test(host)) {
    throw new Error(
      'Production-access brief field "website" must not use example.com/net/org placeholder domains.',
    );
  }
  if (isFabricatedPlaceholder(value) || isFabricatedPlaceholder(host)) {
    throw new Error(
      `Production-access brief field "website" looks blank or fabricated ("${value}"). Provide an honest operational answer.`,
    );
  }
  return value;
}

/**
 * @param {string | null | undefined} status
 */
export function isActiveStackStatus(status) {
  if (status == null || status === "") return false;
  const value = String(status);
  return value === "REVIEW_IN_PROGRESS" || /_IN_PROGRESS$/u.test(value);
}

/**
 * Healthy terminal CloudFormation statuses (not rollback/failed).
 * @param {string | null | undefined} status
 */
export function isHealthyTerminalStackStatus(status) {
  if (status == null || status === "") return false;
  const value = String(status);
  return /_COMPLETE$/u.test(value) && !/ROLLBACK|FAILED/u.test(value);
}

/**
 * Parse a CloudFormation change-set ARN and bind partition/region/account.
 * @param {string} arn
 */
export function parseChangeSetArn(arn) {
  const value = String(arn ?? "").trim();
  const match = /^arn:([^:]+):cloudformation:([^:]*):(\d{12}):changeSet\/([^/]+)\/([^/]+)$/u.exec(
    value,
  );
  if (!match) {
    throw new Error(
      `Change set ARN is malformed (expected arn:PARTITION:cloudformation:REGION:ACCOUNT:changeSet/NAME/ID): ${value}`,
    );
  }
  const region = match[2];
  if (!region) {
    throw new Error(`Change set ARN is missing a region: ${value}`);
  }
  return {
    arn: value,
    partition: match[1],
    region,
    accountId: match[3],
    changeSetName: match[4],
    changeSetUniqueId: match[5],
  };
}

/**
 * @param {Record<string, string>} brief
 */
export function buildUseCaseDescription(brief) {
  return [
    brief.useCase,
    `Volume: ${brief.expectedVolume}.`,
    `Frequency: ${brief.frequency}.`,
    `Recipient consent/acquisition: ${brief.recipientConsent}.`,
    `Unsubscribe: ${brief.unsubscribe}.`,
    `Bounce/complaint handling: ${brief.bounceComplaintHandling}.`,
    `Form-abuse controls: ${brief.formAbuseControls}.`,
    `Monitoring: ${brief.monitoring}.`,
  ].join(" ");
}

/**
 * @param {unknown} identity
 */
export function isIdentityReady(identity) {
  if (identity == null || typeof identity !== "object") return false;
  const raw = /** @type {Record<string, unknown>} */ (identity);
  const verification = String(raw.VerificationStatus ?? raw.verificationStatus ?? "");
  const verifiedForSending = raw.VerifiedForSendingStatus ?? raw.verifiedForSending;
  return verification === "SUCCESS" && verifiedForSending === true;
}

/**
 * @param {unknown} identity
 */
export function isDkimReady(identity) {
  if (identity == null || typeof identity !== "object") return false;
  const raw = /** @type {Record<string, unknown>} */ (identity);
  const dkim =
    raw.DkimAttributes && typeof raw.DkimAttributes === "object"
      ? /** @type {Record<string, unknown>} */ (raw.DkimAttributes)
      : raw;
  const status = String(dkim.Status ?? dkim.dkimStatus ?? "");
  const enabled = dkim.SigningEnabled ?? dkim.dkimSigningEnabled;
  return status === "SUCCESS" && enabled === true;
}

/**
 * @param {unknown} account
 */
export function summarizeProductionAccessStatus(account) {
  if (account == null || typeof account !== "object") {
    return {
      productionAccessEnabled: false,
      reviewStatus: "UNKNOWN",
      sendingEnabled: null,
    };
  }
  const raw = /** @type {Record<string, unknown>} */ (account);
  const details =
    raw.Details && typeof raw.Details === "object"
      ? /** @type {Record<string, unknown>} */ (raw.Details)
      : {};
  const review =
    details.ReviewDetails && typeof details.ReviewDetails === "object"
      ? /** @type {Record<string, unknown>} */ (details.ReviewDetails)
      : {};
  return {
    productionAccessEnabled: raw.ProductionAccessEnabled === true,
    reviewStatus: String(review.Status ?? "NONE"),
    sendingEnabled: raw.SendingEnabled === undefined ? null : raw.SendingEnabled === true,
  };
}

/**
 * @param {unknown} changeSet
 */
export function isNoChangeChangeSet(changeSet) {
  if (changeSet == null || typeof changeSet !== "object") return false;
  const raw = /** @type {Record<string, unknown>} */ (changeSet);
  const status = String(raw.Status ?? "");
  const reason = String(raw.StatusReason ?? "");
  const changes = Array.isArray(raw.Changes) ? raw.Changes : [];
  if (
    /didn't contain changes|no updates are to be performed|The submitted information didn't contain changes/iu.test(
      reason,
    )
  ) {
    return true;
  }
  return status === "FAILED" && changes.length === 0 && /change/iu.test(reason);
}

/**
 * @param {unknown} changeSet
 */
export function summarizeChangeSet(changeSet) {
  if (changeSet == null || typeof changeSet !== "object") {
    throw new Error("Change set description must be an object.");
  }
  const raw = /** @type {Record<string, unknown>} */ (changeSet);
  const changes = Array.isArray(raw.Changes) ? raw.Changes : [];
  /** @type {{ action: string, logicalId: string, type: string, replacement: string }[]} */
  const resources = [];
  let replacements = 0;
  let iamChanges = 0;
  for (const entry of changes) {
    if (entry == null || typeof entry !== "object") continue;
    const change = /** @type {Record<string, unknown>} */ (entry);
    const resourceChange =
      change.ResourceChange && typeof change.ResourceChange === "object"
        ? /** @type {Record<string, unknown>} */ (change.ResourceChange)
        : {};
    const action = String(resourceChange.Action ?? change.Action ?? "Unknown");
    const logicalId = String(resourceChange.LogicalResourceId ?? "");
    const type = String(resourceChange.ResourceType ?? "");
    const replacement = String(resourceChange.Replacement ?? "False");
    if (replacement === "True") replacements += 1;
    if (type.startsWith("AWS::IAM::")) iamChanges += 1;
    resources.push({ action, logicalId, type, replacement });
  }
  return {
    status: String(raw.Status ?? ""),
    statusReason: String(raw.StatusReason ?? ""),
    executionStatus: String(raw.ExecutionStatus ?? ""),
    changeSetId: String(raw.ChangeSetId ?? ""),
    changeSetName: String(raw.ChangeSetName ?? ""),
    stackId: String(raw.StackId ?? ""),
    stackName: String(raw.StackName ?? ""),
    capabilities: Array.isArray(raw.Capabilities) ? raw.Capabilities.map(String) : [],
    resourceCount: resources.length,
    replacements,
    iamChanges,
    resources,
    noChange: isNoChangeChangeSet(raw),
  };
}

/**
 * @param {unknown} outputs
 * @returns {Record<string, string>}
 */
export function parseStackOutputs(outputs) {
  /** @type {Record<string, string>} */
  const map = {};
  const list = Array.isArray(outputs)
    ? outputs
    : outputs && typeof outputs === "object" && Array.isArray(/** @type {any} */ (outputs).Outputs)
      ? /** @type {any} */ (outputs).Outputs
      : [];
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") continue;
    const key = String(/** @type {any} */ (entry).OutputKey ?? "");
    const value = /** @type {any} */ (entry).OutputValue;
    if (!key || value == null) continue;
    map[key] = String(value);
  }
  return map;
}

/**
 * Map known non-secret outputs into deployment.env keys. Omits empty optional values.
 * @param {Record<string, string>} outputs
 * @param {SetupState} state
 * @returns {Record<string, string>}
 */
export function mapStackOutputsToEnv(outputs, state) {
  /** @type {Record<string, string>} */
  const patch = {};
  for (const [outputKey, envKey] of Object.entries(STACK_OUTPUT_ENV_MAP)) {
    const value = outputs[outputKey];
    if (value == null) continue;
    const text = String(value);
    if (
      (envKey === "NUSEND_SES_MARKETING_CONFIGURATION_SET" ||
        envKey === "NUSEND_SES_TRACKING_EVENTS") &&
      text.trim() === ""
    ) {
      continue;
    }
    if (envKey === "NUSEND_SES_MARKETING_CONFIGURATION_SET" && !state.config.marketingEnabled) {
      continue;
    }
    patch[envKey] = text;
  }
  return patch;
}

/**
 * @param {unknown} eventsPayload
 * @param {number} [limit]
 */
export function summarizeFailedStackEvents(eventsPayload, limit = 15) {
  const events = Array.isArray(eventsPayload)
    ? eventsPayload
    : eventsPayload &&
        typeof eventsPayload === "object" &&
        Array.isArray(/** @type {any} */ (eventsPayload).StackEvents)
      ? /** @type {any} */ (eventsPayload).StackEvents
      : [];
  /** @type {{ logicalId: string, status: string, reason: string, timestamp: string }[]} */
  const failed = [];
  for (const event of events) {
    if (event == null || typeof event !== "object") continue;
    const status = String(/** @type {any} */ (event).ResourceStatus ?? "");
    if (!/(FAILED|ROLLBACK)/u.test(status)) continue;
    failed.push({
      logicalId: String(/** @type {any} */ (event).LogicalResourceId ?? ""),
      status,
      reason: String(/** @type {any} */ (event).ResourceStatusReason ?? ""),
      timestamp: String(/** @type {any} */ (event).Timestamp ?? ""),
    });
    if (failed.length >= limit) break;
  }
  return failed;
}

/**
 * @param {unknown} identityJson
 */
export function summarizeIdentity(identityJson) {
  if (identityJson == null || typeof identityJson !== "object") {
    throw new Error("SES identity payload must be an object.");
  }
  const raw = /** @type {Record<string, unknown>} */ (identityJson);
  const dkim =
    raw.DkimAttributes && typeof raw.DkimAttributes === "object"
      ? /** @type {Record<string, unknown>} */ (raw.DkimAttributes)
      : {};
  return {
    verificationStatus: String(raw.VerificationStatus ?? ""),
    verifiedForSending: raw.VerifiedForSendingStatus === true,
    dkimStatus: String(dkim.Status ?? ""),
    dkimSigningEnabled: dkim.SigningEnabled === true,
  };
}

/**
 * @param {Record<string, string>} outputs
 */
export function formatDkimRecords(outputs) {
  /** @type {{ name: string, value: string }[]} */
  const records = [];
  for (let index = 1; index <= 3; index += 1) {
    const name = outputs[`DkimRecordName${index}`];
    const value = outputs[`DkimRecordValue${index}`];
    if (name && value) records.push({ name, value });
  }
  return records;
}

/**
 * @param {SetupState} state
 * @param {readonly string[]} command
 */
export function awsArgv(state, command) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("AWS command must be a non-empty argv array.");
  }
  return Object.freeze([
    ...command.map(String),
    "--profile",
    state.config.awsProfile,
    "--region",
    state.config.awsRegion,
  ]);
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {readonly string[]} command
 * @param {Partial<RunProcessOptions>} [options]
 * @returns {Promise<RunProcessResult>}
 */
export async function runAws(ctx, state, command, options = {}) {
  const args = awsArgv(state, command);
  return ctx.executor({
    command: "aws",
    args,
    allowNonZero: options.allowNonZero,
    redact: options.redact,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    signal: options.signal,
  });
}

/**
 * @param {string} stdout
 * @param {string} label
 */
export function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned malformed JSON.`, { cause: error });
  }
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 */
export async function resolveCallerContext(ctx, state) {
  const result = await runAws(ctx, state, ["sts", "get-caller-identity", "--output", "json"]);
  const identity = parseJsonOutput(result.stdout, "sts get-caller-identity");
  const accountId = String(identity.Account ?? "");
  const arn = String(identity.Arn ?? "");
  if (!/^\d{12}$/u.test(accountId)) {
    throw new Error("STS caller identity did not return a 12-digit account id.");
  }
  if (accountId !== state.config.awsAccountId) {
    throw new Error(
      `AWS account mismatch: expected ${state.config.awsAccountId}, caller is ${accountId}. Refusing to plan or apply.`,
    );
  }
  const partition = arn.startsWith("arn:") ? arn.split(":")[1] || "aws" : "aws";
  return {
    accountId,
    arn,
    partition,
    region: state.config.awsRegion,
  };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} stackName
 * @returns {Promise<{ exists: boolean, stackId: string | null, status: string | null, raw: unknown | null }>}
 */
export async function describeStack(ctx, state, stackName) {
  const result = await runAws(
    ctx,
    state,
    ["cloudformation", "describe-stacks", "--stack-name", stackName, "--output", "json"],
    { allowNonZero: true },
  );
  if (result.exitCode !== 0) {
    const text = `${result.stdout}\n${result.stderr}`;
    if (/does not exist/iu.test(text)) {
      return { exists: false, stackId: null, status: null, raw: null };
    }
    throw new Error(`cloudformation describe-stacks failed:\n${text}`);
  }
  const payload = parseJsonOutput(result.stdout, "cloudformation describe-stacks");
  const stack = Array.isArray(payload.Stacks) ? payload.Stacks[0] : null;
  if (stack == null || typeof stack !== "object") {
    return { exists: false, stackId: null, status: null, raw: null };
  }
  return {
    exists: true,
    stackId: String(/** @type {any} */ (stack).StackId ?? "") || null,
    status: String(/** @type {any} */ (stack).StackStatus ?? "") || null,
    raw: stack,
  };
}

/**
 * Core planning may update an existing stack only when state preserves the immutable proof that
 * this coordinator created that exact stack through its reviewed core CREATE change set.
 * @param {SetupState} state
 * @param {{ stackId: string | null }} existing
 * @param {{ accountId: string, partition: string, region: string }} caller
 * @param {string} stackName
 */
function assertExistingCoreStackProvenance(state, existing, caller, stackName) {
  const proof = state.aws?.stackCreation;
  const fail = () => {
    throw new Error(
      `Stack name collision: ${stackName} already exists without exact coordinator core CREATE provenance for this stack id/account/partition/region. Refusing to adopt, plan changes, or mutate it.`,
    );
  };
  if (!existing.stackId || proof == null || typeof proof !== "object" || Array.isArray(proof)) {
    fail();
  }
  const expected = {
    provenance: "coordinator-reviewed-change-set",
    phase: "core",
    changeSetType: "CREATE",
    stackId: existing.stackId,
    stackName,
    accountId: caller.accountId,
    partition: caller.partition,
    region: caller.region,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (proof[key] !== value) fail();
  }
  if (
    typeof proof.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.fingerprint) ||
    typeof proof.appliedAt !== "string" ||
    !proof.appliedAt
  ) {
    fail();
  }
  try {
    const changeSet = parseChangeSetArn(String(proof.changeSetArn ?? ""));
    if (
      changeSet.accountId !== caller.accountId ||
      changeSet.partition !== caller.partition ||
      changeSet.region !== caller.region ||
      changeSet.changeSetName !== buildChangeSetName(state.installationId, "core")
    ) {
      fail();
    }
  } catch {
    fail();
  }
}

/**
 * @param {SetupContext} ctx
 */
export async function runAwsPlan(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);
  const caller = await resolveCallerContext(ctx, state);
  const phase = determinePhase(state);
  if (phase === "finalize") {
    const { assertPreFinalizeSubscriptionAbsence } = await import("./validate.mjs");
    await assertPreFinalizeSubscriptionAbsence(ctx, state);
  }
  const stackName = buildStackName(state.installationId);
  const parameters = buildStackParameters(state, phase);
  const templateBody = await readFile(TEMPLATE_PATH, "utf8");
  // Validate template body parses and AWS accepts it.
  JSON.parse(templateBody);
  await runAws(ctx, state, [
    "cloudformation",
    "validate-template",
    "--template-body",
    `file://${TEMPLATE_PATH}`,
    "--output",
    "json",
  ]);

  const existing = await describeStack(ctx, state, stackName);
  if (existing.exists && existing.status && isActiveStackStatus(existing.status)) {
    throw new Error(
      `Stack ${stackName} is ${existing.status}. Wait for the in-progress CloudFormation operation to finish, then re-run \`pnpm nusend:setup aws plan\`.`,
    );
  }
  if (
    existing.exists &&
    existing.status &&
    /ROLLBACK_COMPLETE|DELETE_FAILED/u.test(existing.status)
  ) {
    throw new Error(
      `Stack ${stackName} is in ${existing.status}. Delete or repair it before planning.`,
    );
  }
  if (phase === "core" && existing.exists) {
    assertExistingCoreStackProvenance(state, existing, caller, stackName);
  }
  const changeSetType = existing.exists ? "UPDATE" : "CREATE";
  const fingerprint = fingerprintTemplateAndParameters(templateBody, parameters, {
    stackName,
    phase,
  });
  const changeSetName = buildChangeSetName(state.installationId, phase);

  await deleteAbandonedChangeSet(ctx, state, stackName, changeSetName, state.plans?.[AWS_PLAN_KEY]);

  const parameterArgs = parameters.flatMap((entry) => [
    "ParameterKey=" + entry.ParameterKey + ",ParameterValue=" + entry.ParameterValue,
  ]);

  const createArgs = [
    "cloudformation",
    "create-change-set",
    "--stack-name",
    stackName,
    "--change-set-name",
    changeSetName,
    "--change-set-type",
    changeSetType,
    "--template-body",
    `file://${TEMPLATE_PATH}`,
    "--parameters",
    ...parameterArgs,
    "--capabilities",
    REQUIRED_CAPABILITY,
    "--output",
    "json",
  ];
  // For CREATE, include tags via empty include-nested? not required.
  if (changeSetType === "UPDATE") {
    // no-op marker for readability; UPDATE uses same shape
  }

  const created = await runAws(ctx, state, createArgs);
  const createdPayload = parseJsonOutput(created.stdout, "cloudformation create-change-set");
  const changeSetArn = String(createdPayload.Id ?? createdPayload.ChangeSetId ?? "");
  if (!changeSetArn) {
    throw new Error("create-change-set did not return a change set ARN.");
  }

  const described = await waitForChangeSet(ctx, state, changeSetArn);
  const summary = summarizeChangeSet(described);
  const noChange = summary.noChange;
  if (!noChange && summary.status !== "CREATE_COMPLETE") {
    throw new Error(
      `Change set ${changeSetName} ended in status ${summary.status}: ${summary.statusReason}`,
    );
  }

  log(`AWS plan (${phase}/${changeSetType}) for stack ${stackName}`);
  log(`  account=${caller.accountId} partition=${caller.partition} region=${caller.region}`);
  log(`  changeSet=${changeSetArn}`);
  log(`  capability=${REQUIRED_CAPABILITY}`);
  if (noChange) {
    log("  result=NO_CHANGES (stack already matches template/parameters)");
  } else {
    log(
      `  resources=${summary.resourceCount} replacements=${summary.replacements} iam=${summary.iamChanges}`,
    );
    if (summary.replacements > 0) {
      log("  WARNING: one or more resources will be replaced.");
    }
    for (const resource of summary.resources) {
      log(
        `  - ${resource.action} ${resource.logicalId} (${resource.type}) replacement=${resource.replacement}`,
      );
    }
  }

  const plannedAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const plan = sanitizePlanMetadata({
    changeSetArn,
    changeSetName,
    stackName,
    stackId: summary.stackId || existing.stackId || null,
    phase,
    changeSetType,
    fingerprint,
    accountId: caller.accountId,
    partition: caller.partition,
    region: caller.region,
    noChange,
    plannedAt,
    capability: REQUIRED_CAPABILITY,
    resourceCount: summary.resourceCount,
    replacements: summary.replacements,
    iamChanges: summary.iamChanges,
  });

  const now = new Date().toISOString();
  /** @type {SetupState} */
  const next = {
    ...state,
    updatedAt: now,
    plans: {
      ...state.plans,
      [AWS_PLAN_KEY]: plan,
    },
  };
  await writeState(next, ctx.env);
  log(
    `Plan stored. Review, then run \`pnpm nusend:setup aws apply\` and type the confirmation phrase.`,
  );
  log(
    `Expected confirmation: ${buildApplyConfirmationPhrase({
      accountId: caller.accountId,
      region: caller.region,
      stackName,
      phase,
    })}`,
  );
  return { plan, summary, caller };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} stackName
 * @param {string} changeSetName
 * @param {Record<string, unknown> | undefined} previousPlan
 */
async function deleteAbandonedChangeSet(ctx, state, stackName, changeSetName, previousPlan) {
  const targets = new Set();
  if (previousPlan && typeof previousPlan.changeSetArn === "string" && previousPlan.changeSetArn) {
    targets.add(previousPlan.changeSetArn);
  }
  targets.add(changeSetName);
  await Promise.all(
    [...targets].map((target) =>
      runAws(
        ctx,
        state,
        [
          "cloudformation",
          "delete-change-set",
          "--stack-name",
          stackName,
          "--change-set-name",
          target,
          "--output",
          "json",
        ],
        { allowNonZero: true },
      ),
    ),
  );
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} changeSetArn
 */
async function describeChangeSet(ctx, state, changeSetArn) {
  const described = await runAws(ctx, state, [
    "cloudformation",
    "describe-change-set",
    "--change-set-name",
    changeSetArn,
    "--output",
    "json",
  ]);
  return parseJsonOutput(described.stdout, "cloudformation describe-change-set");
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} changeSetArn
 */
async function waitForChangeSet(ctx, state, changeSetArn) {
  // Prefer AWS waiter; fall back to describe when the waiter fails (no-change path).
  await runAws(
    ctx,
    state,
    ["cloudformation", "wait", "change-set-create-complete", "--change-set-name", changeSetArn],
    { allowNonZero: true },
  );
  return describeChangeSet(ctx, state, changeSetArn);
}

/**
 * @param {Record<string, unknown>} plan
 */
function isLocalFinalizationCheckpoint(plan) {
  return (
    plan.providerApplied === true || plan.applyCheckpoint === APPLY_CHECKPOINT_LOCAL_FINALIZATION
  );
}

/**
 * Exact stack id from the reviewed plan / prior ownership. Never invent a replacement.
 * @param {Record<string, unknown>} plan
 * @param {SetupState} state
 * @returns {string | null}
 */
function expectedStackIdFromPlan(plan, state) {
  const fromPlan = typeof plan.stackId === "string" && plan.stackId ? plan.stackId : "";
  if (fromPlan) return fromPlan;
  const owned =
    state.aws?.stack && typeof state.aws.stack === "object"
      ? /** @type {Record<string, unknown>} */ (state.aws.stack).stackId
      : null;
  return typeof owned === "string" && owned ? owned : null;
}

/**
 * Preserve the one immutable fact destroy relies on: this coordinator initially created the exact
 * stack through its reviewed core CREATE change set. Finalize UPDATE metadata must never replace it.
 * Existing UPDATE/no-change stacks deliberately receive no creation proof.
 * @param {SetupState} state
 * @param {Record<string, unknown>} plan
 * @param {{ stackId: string, stackName: string, accountId: string, partition: string, region: string, fingerprint: string, appliedAt: string }} binding
 */
function stackCreationProofForApply(state, plan, binding) {
  const existing = state.aws?.stackCreation;
  if (existing != null) {
    if (typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("Stored initial stack creation proof is malformed.");
    }
    const proof = /** @type {Record<string, unknown>} */ (existing);
    for (const [key, expected] of Object.entries({
      stackId: binding.stackId,
      stackName: binding.stackName,
      accountId: binding.accountId,
      partition: binding.partition,
      region: binding.region,
    })) {
      if (proof[key] !== expected) {
        throw new Error(
          `Stored initial stack creation proof ${key} does not match the exact live stack binding.`,
        );
      }
    }
    if (
      proof.provenance !== "coordinator-reviewed-change-set" ||
      proof.phase !== "core" ||
      proof.changeSetType !== "CREATE"
    ) {
      throw new Error("Stored initial stack creation proof is not a coordinator core CREATE.");
    }
    return proof;
  }

  if (plan.phase !== "core" || plan.changeSetType !== "CREATE" || plan.noChange === true) {
    return undefined;
  }
  const changeSetArn = String(plan.changeSetArn ?? "");
  if (!changeSetArn.startsWith("arn:")) {
    throw new Error(
      "Cannot record initial stack creation proof without the reviewed change set ARN.",
    );
  }
  return {
    provenance: "coordinator-reviewed-change-set",
    phase: "core",
    changeSetType: "CREATE",
    stackId: binding.stackId,
    stackName: binding.stackName,
    accountId: binding.accountId,
    partition: binding.partition,
    region: binding.region,
    changeSetArn,
    fingerprint: binding.fingerprint,
    appliedAt: binding.appliedAt,
  };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {Record<string, unknown>} plan
 * @param {{ accountId: string, region: string, partition: string }}
 *   caller
 * @param {string} stackName
 * @param {string} changeSetArn
 */
async function validateLiveChangeSet(ctx, state, plan, caller, stackName, changeSetArn) {
  const arnParts = parseChangeSetArn(changeSetArn);
  const planAccountId = String(plan.accountId ?? "");
  const planRegion = String(plan.region ?? "");
  const planPartition = String(plan.partition ?? caller.partition);
  if (arnParts.accountId !== planAccountId || arnParts.accountId !== caller.accountId) {
    throw new Error(
      `Change set ARN account ${arnParts.accountId} does not match plan ${planAccountId} / caller ${caller.accountId}.`,
    );
  }
  if (arnParts.region !== planRegion || arnParts.region !== caller.region) {
    throw new Error(
      `Change set ARN region ${arnParts.region} does not match plan ${planRegion} / caller ${caller.region}.`,
    );
  }
  if (arnParts.partition !== planPartition) {
    throw new Error(
      `Change set ARN partition ${arnParts.partition} does not match expected ${planPartition}.`,
    );
  }

  const described = await describeChangeSet(ctx, state, changeSetArn);
  const summary = summarizeChangeSet(described);
  const liveId = String(described.ChangeSetId ?? summary.changeSetId ?? "");
  if (liveId && liveId !== changeSetArn) {
    throw new Error(
      `Live change set id ${liveId} does not match stored ARN ${changeSetArn}. Re-run plan.`,
    );
  }
  if (summary.stackName && summary.stackName !== stackName) {
    throw new Error(
      `Change set stack name ${summary.stackName} does not match stored plan stack ${stackName}.`,
    );
  }
  const expectedStackId = expectedStackIdFromPlan(plan, state);
  if (expectedStackId && summary.stackId && summary.stackId !== expectedStackId) {
    throw new Error(
      `Change set stack id ${summary.stackId} does not match stored stack id ${expectedStackId}. Refusing to adopt a same-name replacement.`,
    );
  }
  return { described, summary, arnParts, expectedStackId };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {Record<string, unknown>} plan
 * @param {{ accountId: string, region: string, partition: string }}
 *   caller
 * @param {string} stackName
 * @param {string} changeSetArn
 * @param {(line: string) => void} log
 */
async function executeOrResumeChangeSet(ctx, state, plan, caller, stackName, changeSetArn, log) {
  const { summary, expectedStackId } = await validateLiveChangeSet(
    ctx,
    state,
    plan,
    caller,
    stackName,
    changeSetArn,
  );
  const executionStatus = summary.executionStatus;

  if (executionStatus === "OBSOLETE" || executionStatus === "UNAVAILABLE") {
    throw new Error(
      `Stored change set is ${executionStatus}. Re-run \`pnpm nusend:setup aws plan\` and review a fresh change set.`,
    );
  }

  if (executionStatus === "AVAILABLE") {
    if (summary.status !== "CREATE_COMPLETE") {
      throw new Error(
        `Change set status ${summary.status || "unknown"} is not executable (execution=${executionStatus}). Re-run plan.`,
      );
    }
    if (plan.phase === "finalize") {
      // Close the plan/apply race immediately before the first provider mutation. Once this exact
      // change set is in progress or complete, resume it without applying the absence guard again.
      const { assertPreFinalizeSubscriptionAbsence } = await import("./validate.mjs");
      await assertPreFinalizeSubscriptionAbsence(ctx, state);
    }
    const executed = await runAws(
      ctx,
      state,
      [
        "cloudformation",
        "execute-change-set",
        "--change-set-name",
        changeSetArn,
        "--output",
        "json",
      ],
      { allowNonZero: true },
    );
    if (executed.exitCode !== 0) {
      // Ambiguous failure: another process may have started execution. Re-describe before failing.
      const redecribed = await describeChangeSet(ctx, state, changeSetArn);
      const liveExecution = summarizeChangeSet(redecribed).executionStatus;
      if (liveExecution !== "EXECUTE_IN_PROGRESS" && liveExecution !== "EXECUTE_COMPLETE") {
        throw new Error(
          `execute-change-set failed for ${changeSetArn} (execution=${liveExecution || "unknown"}):\n${executed.stderr || executed.stdout}`,
        );
      }
      log(
        `execute-change-set returned an error, but change set execution is ${liveExecution}; continuing without re-executing.`,
      );
    }
  } else if (executionStatus === "EXECUTE_IN_PROGRESS") {
    log("Change set execution already in progress; waiting for the stack operation to finish.");
  } else if (executionStatus === "EXECUTE_COMPLETE") {
    log("Change set already executed; resuming post-provider local finalization.");
  } else {
    throw new Error(
      `Unexpected change set execution status "${executionStatus || "empty"}". Re-run \`pnpm nusend:setup aws plan\`.`,
    );
  }

  const waitName =
    String(plan.changeSetType ?? "CREATE") === "UPDATE"
      ? "stack-update-complete"
      : "stack-create-complete";
  const waited = await runAws(
    ctx,
    state,
    ["cloudformation", "wait", waitName, "--stack-name", stackName],
    { allowNonZero: true },
  );
  if (waited.exitCode !== 0) {
    const stackInfo = await describeStack(ctx, state, stackName);
    if (
      !stackInfo.exists ||
      !isHealthyTerminalStackStatus(stackInfo.status) ||
      (expectedStackId && stackInfo.stackId !== expectedStackId)
    ) {
      const diagnostics = await collectStackFailureDiagnostics(ctx, state, stackName);
      throw new Error(`Stack operation failed for ${stackName}.\n${diagnostics}`);
    }
    log(
      `Stack waiter exited non-zero, but live stack ${stackName} is ${stackInfo.status}; continuing local finalization.`,
    );
  }
}

/**
 * NO_CHANGES apply: never execute; require live exact stack ownership/status.
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {Record<string, unknown>} plan
 * @param {string} stackName
 * @param {(line: string) => void} log
 */
async function assertNoChangeStackReady(ctx, state, plan, stackName, log) {
  log("Plan recorded NO_CHANGES; skipping change-set execution.");
  const stackInfo = await describeStack(ctx, state, stackName);
  if (!stackInfo.exists || !stackInfo.stackId) {
    throw new Error(`NO_CHANGES plan requires existing stack ${stackName} with a stable stack id.`);
  }
  if (!isHealthyTerminalStackStatus(stackInfo.status)) {
    throw new Error(
      `NO_CHANGES apply refused: stack ${stackName} status is ${stackInfo.status ?? "unknown"}.`,
    );
  }
  const expectedStackId = expectedStackIdFromPlan(plan, state);
  if (expectedStackId && stackInfo.stackId !== expectedStackId) {
    throw new Error(
      `NO_CHANGES apply refused: live stack id ${stackInfo.stackId} does not match stored ${expectedStackId}.`,
    );
  }
  // When the recorded change set still exists, require the failed no-change reason path.
  const changeSetArn = String(plan.changeSetArn ?? "");
  if (changeSetArn.startsWith("arn:")) {
    const described = await describeChangeSet(ctx, state, changeSetArn);
    if (!isNoChangeChangeSet(described)) {
      const summary = summarizeChangeSet(described);
      throw new Error(
        `Stored plan is marked NO_CHANGES but live change set status=${summary.status} reason=${summary.statusReason || "none"}. Re-run plan.`,
      );
    }
    const summary = summarizeChangeSet(described);
    if (summary.stackName && summary.stackName !== stackName) {
      throw new Error(
        `NO_CHANGES change set stack name ${summary.stackName} does not match ${stackName}.`,
      );
    }
    if (expectedStackId && summary.stackId && summary.stackId !== expectedStackId) {
      throw new Error(
        `NO_CHANGES change set stack id ${summary.stackId} does not match stored ${expectedStackId}.`,
      );
    }
  }
  return stackInfo;
}

/**
 * @param {SetupContext} ctx
 */
export async function runAwsApply(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);
  const caller = await resolveCallerContext(ctx, state);
  const plan = state.plans?.[AWS_PLAN_KEY];
  if (plan == null || typeof plan !== "object") {
    throw new Error("No stored AWS plan. Run `pnpm nusend:setup aws plan` first.");
  }

  // Reject consumed plans before any prompt or provider mutation.
  if (plan.consumed === true) {
    throw new Error(
      "Stored AWS plan is already consumed. Re-run `pnpm nusend:setup aws plan` before applying again.",
    );
  }

  const stackName = String(plan.stackName ?? "");
  const phase = /** @type {"core" | "finalize"} */ (String(plan.phase ?? ""));
  const region = String(plan.region ?? "");
  const accountId = String(plan.accountId ?? "");
  const fingerprint = String(plan.fingerprint ?? "");
  const changeSetArn = String(plan.changeSetArn ?? "");
  const noChange = plan.noChange === true;
  const partition = String(plan.partition ?? caller.partition);
  const resumeLocalFinalization = isLocalFinalizationCheckpoint(plan);

  if (
    !stackName ||
    (phase !== "core" && phase !== "finalize") ||
    !region ||
    !accountId ||
    !fingerprint
  ) {
    throw new Error("Stored AWS plan is incomplete. Re-run `pnpm nusend:setup aws plan`.");
  }
  if (accountId !== state.config.awsAccountId || accountId !== caller.accountId) {
    throw new Error(
      `Stored plan account ${accountId} does not match expected ${state.config.awsAccountId} / caller ${caller.accountId}.`,
    );
  }
  if (region !== state.config.awsRegion || region !== caller.region) {
    throw new Error(
      `Stored plan region ${region} does not match configured ${state.config.awsRegion}.`,
    );
  }
  if (stackName !== buildStackName(state.installationId)) {
    throw new Error(`Stored plan stack ${stackName} does not match derived stack name.`);
  }
  const expectedPhase = determinePhase(state);
  if (phase !== expectedPhase) {
    throw new Error(
      `Stored plan phase "${phase}" does not match current phase "${expectedPhase}". Re-run \`pnpm nusend:setup aws plan\`.`,
    );
  }

  const templateBody = await readFile(TEMPLATE_PATH, "utf8");
  const parameters = buildStackParameters(state, phase);
  const currentFingerprint = fingerprintTemplateAndParameters(templateBody, parameters, {
    stackName,
    phase,
  });
  if (currentFingerprint !== fingerprint) {
    throw new Error(
      "Stored AWS plan fingerprint does not match current template/parameters. Re-run `pnpm nusend:setup aws plan`.",
    );
  }

  if (!resumeLocalFinalization) {
    const expectedPhrase = buildApplyConfirmationPhrase({
      accountId,
      region,
      stackName,
      phase,
    });
    log(`About to apply AWS change set for ${stackName} (${phase}).`);
    log(`Type exactly: ${expectedPhrase}`);
    const answer = await ctx.io.prompt("Confirmation: ");
    validateApplyConfirmation(answer, { accountId, region, stackName, phase });

    if (noChange) {
      await assertNoChangeStackReady(ctx, state, plan, stackName, log);
    } else {
      if (!changeSetArn.startsWith("arn:")) {
        throw new Error("Stored plan is missing a change set ARN.");
      }
      await executeOrResumeChangeSet(
        ctx,
        state,
        plan,
        { accountId: caller.accountId, region: caller.region, partition: caller.partition },
        stackName,
        changeSetArn,
        log,
      );
    }
  } else {
    log(
      `Resuming local finalization for ${stackName} (${phase}) after provider-side apply success; skipping provider mutation.`,
    );
  }

  const stackInfo = await describeStack(ctx, state, stackName);
  if (!stackInfo.exists || !stackInfo.raw || !stackInfo.stackId) {
    throw new Error(`Stack ${stackName} was not found after apply.`);
  }
  const status = String(stackInfo.status ?? "");
  if (!isHealthyTerminalStackStatus(status)) {
    const diagnostics = await collectStackFailureDiagnostics(ctx, state, stackName);
    throw new Error(`Stack ${stackName} ended in status ${status}.\n${diagnostics}`);
  }

  const expectedStackId = expectedStackIdFromPlan(plan, state);
  if (expectedStackId && stackInfo.stackId !== expectedStackId) {
    throw new Error(
      `Live stack id ${stackInfo.stackId} does not match expected ${expectedStackId}. Refusing to adopt a same-name replacement.`,
    );
  }
  // Bind the exact reviewed stack id for the rest of finalization (CREATE plans carry it from the change set).
  const boundStackId = expectedStackId ?? stackInfo.stackId;

  const outputs = parseStackOutputs(/** @type {any} */ (stackInfo.raw).Outputs ?? []);
  const envPatch = mapStackOutputsToEnv(outputs, state);
  let finalizedSubscription;
  if (phase === "finalize") {
    const { verifyFinalizedSubscription } = await import("./validate.mjs");
    finalizedSubscription = await verifyFinalizedSubscription(ctx, {
      ...state,
      aws: {
        ...(state.aws ?? {}),
        stack: {
          ...(state.aws?.stack ?? {}),
          stackId: boundStackId,
          stackName,
          accountId,
          partition,
          region,
          phase,
          status,
          outputs,
        },
      },
    });
  }
  const providerAppliedAt =
    typeof plan.providerAppliedAt === "string" && plan.providerAppliedAt
      ? plan.providerAppliedAt
      : new Date().toISOString();
  const stackCreation = stackCreationProofForApply(state, plan, {
    stackId: boundStackId,
    stackName,
    accountId,
    partition,
    region,
    fingerprint,
    appliedAt: providerAppliedAt,
  });

  // Durable ordering: stack ownership + non-consumed provider checkpoint BEFORE env write.
  /** @type {SetupState} */
  const checkpointState = {
    ...state,
    updatedAt: providerAppliedAt,
    plans: {
      ...state.plans,
      [AWS_PLAN_KEY]: sanitizePlanMetadata({
        ...plan,
        stackId: boundStackId,
        providerApplied: true,
        applyCheckpoint: APPLY_CHECKPOINT_LOCAL_FINALIZATION,
        providerAppliedAt,
        consumed: false,
      }),
    },
    aws: sanitizePlanMetadata({
      ...(state.aws ?? {}),
      ...(stackCreation ? { stackCreation } : {}),
      stack: {
        stackId: boundStackId,
        stackName,
        accountId,
        partition,
        region,
        phase,
        status,
        outputs,
        appliedFingerprint: fingerprint,
        appliedAt: providerAppliedAt,
        changeSetType: String(plan.changeSetType ?? ""),
        ...(finalizedSubscription ? { subscription: finalizedSubscription } : {}),
      },
    }),
  };
  await writeState(checkpointState, ctx.env);

  // Optional test seam for simulating crash after provider success / before env persistence.
  if (typeof ctx.afterProviderCheckpoint === "function") {
    await ctx.afterProviderCheckpoint({ state: checkpointState });
  }

  const deployment = await loadDeploymentEnv(installationId, ctx.env);
  const nextEnv = { ...deployment, ...envPatch };
  await writeDeploymentEnv(installationId, nextEnv, ctx.env);

  const dkimRecords = formatDkimRecords(outputs);
  log("Stack outputs mapped into deployment.env (non-secret values only).");
  if (dkimRecords.length > 0) {
    log("DKIM CNAME records (publish at your DNS provider if Route 53 is not managing them):");
    for (const record of dkimRecords) {
      log(`  CNAME ${record.name} -> ${record.value}`);
    }
  }

  const identity = await refreshAndStoreIdentity(
    ctx,
    {
      ...checkpointState,
      aws: {
        ...(checkpointState.aws ?? {}),
      },
    },
    { persist: false },
  );

  const appliedAt = new Date().toISOString();
  /** @type {SetupState} */
  const nextState = {
    ...checkpointState,
    updatedAt: appliedAt,
    plans: {
      ...checkpointState.plans,
      [AWS_PLAN_KEY]: sanitizePlanMetadata({
        consumed: true,
        consumedAt: appliedAt,
        previousChangeSetArn: changeSetArn || null,
        phase,
        stackName,
        stackId: boundStackId,
        fingerprint,
        accountId,
        partition,
        region,
        noChange,
        providerAppliedAt,
      }),
    },
    aws: sanitizePlanMetadata({
      ...(checkpointState.aws ?? {}),
      ...(stackCreation ? { stackCreation } : {}),
      stack: {
        stackId: boundStackId,
        stackName,
        accountId,
        partition,
        region,
        phase,
        status,
        outputs,
        appliedFingerprint: fingerprint,
        appliedAt,
        changeSetType: String(plan.changeSetType ?? ""),
        ...(finalizedSubscription ? { subscription: finalizedSubscription } : {}),
      },
      identity: {
        ...identity,
        checkedAt: appliedAt,
      },
    }),
  };
  await writeState(nextState, ctx.env);
  log(
    `AWS apply complete for ${stackName} (${phase}). continue remains blocked until identity/DKIM success and the runtime key exist.`,
  );
  return { state: nextState, outputs, noChange };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} stackName
 */
async function collectStackFailureDiagnostics(ctx, state, stackName) {
  const eventsResult = await runAws(
    ctx,
    state,
    [
      "cloudformation",
      "describe-stack-events",
      "--stack-name",
      stackName,
      "--max-items",
      "30",
      "--output",
      "json",
    ],
    { allowNonZero: true },
  );
  if (eventsResult.exitCode !== 0) {
    return `Could not load stack events: ${eventsResult.stderr || eventsResult.stdout}`;
  }
  const payload = parseJsonOutput(eventsResult.stdout, "cloudformation describe-stack-events");
  const failed = summarizeFailedStackEvents(payload, 15);
  if (failed.length === 0) {
    return "No FAILED/ROLLBACK stack events were returned. Inspect the stack in CloudFormation.";
  }
  return failed
    .map(
      (event) => `- ${event.logicalId}: ${event.status}${event.reason ? ` (${event.reason})` : ""}`,
    )
    .join("\n");
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {{ persist?: boolean }} [options]
 */
export async function refreshAndStoreIdentity(ctx, state, options = {}) {
  const result = await runAws(ctx, state, [
    "sesv2",
    "get-email-identity",
    "--email-identity",
    state.config.sesIdentity,
    "--output",
    "json",
  ]);
  const payload = parseJsonOutput(result.stdout, "sesv2 get-email-identity");
  const summary = summarizeIdentity(payload);
  if (options.persist !== false) {
    const now = new Date().toISOString();
    /** @type {SetupState} */
    const next = {
      ...state,
      updatedAt: now,
      aws: sanitizePlanMetadata({
        ...(state.aws ?? {}),
        identity: { ...summary, checkedAt: now },
      }),
    };
    await writeState(next, ctx.env);
    return summary;
  }
  return summary;
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {{ persist?: boolean }} [options]
 */
export async function refreshProductionAccessStatus(ctx, state, options = {}) {
  const result = await runAws(ctx, state, ["sesv2", "get-account", "--output", "json"]);
  const payload = parseJsonOutput(result.stdout, "sesv2 get-account");
  const summary = summarizeProductionAccessStatus(payload);
  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const productionAccess = {
    ...(state.aws?.productionAccess ?? {}),
    ...summary,
    checkedAt: now,
  };
  if (summary.productionAccessEnabled) {
    productionAccess.status = "approved";
  } else if (summary.reviewStatus === "PENDING") {
    productionAccess.status = "pending";
  } else if (productionAccess.status == null) {
    productionAccess.status = "not_submitted";
  }
  if (options.persist !== false) {
    /** @type {SetupState} */
    const next = {
      ...state,
      updatedAt: now,
      aws: sanitizePlanMetadata({
        ...(state.aws ?? {}),
        productionAccess,
      }),
    };
    await writeState(next, ctx.env);
  }
  return productionAccess;
}

/**
 * Collect + validate brief, require exact phrase, submit once when operator-enabled.
 * @param {SetupContext} ctx
 * @param {SetupState} [existingState]
 * @param {{ brief?: Record<string, unknown>, submitEnabled?: boolean, confirmation?: string }} [options]
 */
export async function runProductionAccessRequest(ctx, existingState, options = {}) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = existingState?.installationId ?? (await resolveInstallationId(ctx.env));
  let state = existingState ?? (await loadState(installationId, ctx.env));
  await resolveCallerContext(ctx, state);

  const status = await refreshProductionAccessStatus(ctx, state, { persist: true });
  state = await loadState(installationId, ctx.env);

  if (status.productionAccessEnabled === true || status.status === "approved") {
    log("SES production access is already approved in this region (read-only gate).");
    return { status: "approved", productionAccess: state.aws?.productionAccess };
  }
  if (status.reviewStatus === "PENDING" || status.status === "pending") {
    log("SES production access request is PENDING. Not resubmitting.");
    return { status: "pending", productionAccess: state.aws?.productionAccess };
  }

  const submitEnabled =
    options.submitEnabled ??
    (await askBoolean(ctx, "Submit SES production-access request now?", false));
  if (!submitEnabled) {
    log("Production-access submission skipped (operator did not enable submission).");
    return { status: "skipped", productionAccess: state.aws?.productionAccess };
  }

  const briefInput = options.brief ?? (await collectProductionBriefInteractive(ctx));
  const brief = validateProductionBrief(briefInput);
  const confirmation =
    options.confirmation ??
    (await ctx.io.prompt(`Type ${REQUEST_PRODUCTION_ACCESS_PHRASE} to submit: `));
  if (String(confirmation).trim() !== REQUEST_PRODUCTION_ACCESS_PHRASE) {
    throw new Error(`Confirmation rejected. Type exactly: ${REQUEST_PRODUCTION_ACCESS_PHRASE}`);
  }

  const useCaseDescription = buildUseCaseDescription(brief);
  await runAws(ctx, state, [
    "sesv2",
    "put-account-details",
    "--production-access-enabled",
    "--mail-type",
    brief.mailType,
    "--website-url",
    brief.website,
    "--contact-language",
    brief.contactLanguage,
    "--use-case-description",
    useCaseDescription,
    "--additional-contact-email-addresses",
    state.config.ownerEmail,
    "--output",
    "json",
  ]);

  const now = new Date().toISOString();
  /** @type {SetupState} */
  const next = {
    ...state,
    updatedAt: now,
    aws: sanitizePlanMetadata({
      ...(state.aws ?? {}),
      productionAccess: {
        status: "pending",
        productionAccessEnabled: false,
        reviewStatus: "PENDING",
        submittedAt: now,
        checkedAt: now,
        brief: {
          website: brief.website,
          mailType: brief.mailType,
          contactLanguage: brief.contactLanguage,
          useCase: brief.useCase,
          expectedVolume: brief.expectedVolume,
          frequency: brief.frequency,
          // Store short non-secret summaries only.
          recipientConsent: brief.recipientConsent.slice(0, 200),
          unsubscribe: brief.unsubscribe.slice(0, 200),
          bounceComplaintHandling: brief.bounceComplaintHandling.slice(0, 200),
          formAbuseControls: brief.formAbuseControls.slice(0, 200),
          monitoring: brief.monitoring.slice(0, 200),
        },
      },
    }),
  };
  await writeState(next, ctx.env);
  log("SES production-access request submitted. Approval is an external regional gate.");
  return { status: "submitted", productionAccess: next.aws?.productionAccess };
}

/**
 * @param {SetupContext} ctx
 */
async function collectProductionBriefInteractive(ctx) {
  /** @type {Record<string, string>} */
  const brief = {};
  brief.website = await askRequired(ctx, "Website URL (https://): ");
  brief.useCase = await askRequired(ctx, "Use case description: ");
  brief.mailType = await askRequired(ctx, "Mail type (TRANSACTIONAL|MARKETING): ");
  brief.expectedVolume = await askRequired(ctx, "Expected volume: ");
  brief.frequency = await askRequired(ctx, "Sending frequency: ");
  brief.recipientConsent = await askRequired(ctx, "Recipient consent/acquisition: ");
  brief.unsubscribe = await askRequired(ctx, "Unsubscribe handling: ");
  brief.bounceComplaintHandling = await askRequired(ctx, "Bounce/complaint handling: ");
  brief.formAbuseControls = await askRequired(ctx, "Form-abuse controls: ");
  brief.monitoring = await askRequired(ctx, "Monitoring: ");
  brief.contactLanguage = await askRequired(ctx, "Contact language (e.g. EN): ");
  return brief;
}

/**
 * Create one runtime access key after exact phrase. Refuses if any key exists.
 * @param {SetupContext} ctx
 * @param {SetupState} [existingState]
 * @param {{ confirmation?: string }} [options]
 */
export async function runCreateRuntimeKey(ctx, existingState, options = {}) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = existingState?.installationId ?? (await resolveInstallationId(ctx.env));
  let state = existingState ?? (await loadState(installationId, ctx.env));
  await resolveCallerContext(ctx, state);

  const stack = state.aws?.stack;
  if (stack == null || typeof stack !== "object") {
    throw new Error("Runtime key requires a successful core stack apply first.");
  }
  const outputs =
    stack.outputs && typeof stack.outputs === "object"
      ? /** @type {Record<string, string>} */ (stack.outputs)
      : {};
  const userName = String(outputs.RuntimeUserName ?? "");
  if (!userName) {
    throw new Error("Stack outputs are missing RuntimeUserName.");
  }
  if (state.aws?.runtimeAccessKeyId) {
    throw new Error(
      `Runtime access key ${state.aws.runtimeAccessKeyId} is already recorded. Lost secrets require explicit manual rotation; the coordinator will not recreate automatically.`,
    );
  }

  const listed = await runAws(ctx, state, [
    "iam",
    "list-access-keys",
    "--user-name",
    userName,
    "--output",
    "json",
  ]);
  const listPayload = parseJsonOutput(listed.stdout, "iam list-access-keys");
  const metadata = Array.isArray(listPayload.AccessKeyMetadata)
    ? listPayload.AccessKeyMetadata
    : [];
  if (metadata.length > 0) {
    throw new Error(
      `Runtime IAM user ${userName} already has ${metadata.length} access key(s). Refusing to create another. Delete the existing key only with an explicit manual process if rotation is required.`,
    );
  }

  const confirmation =
    options.confirmation ??
    (await ctx.io.prompt(`Type ${CREATE_RUNTIME_KEY_PHRASE} to create one runtime key: `));
  if (String(confirmation).trim() !== CREATE_RUNTIME_KEY_PHRASE) {
    throw new Error(`Confirmation rejected. Type exactly: ${CREATE_RUNTIME_KEY_PHRASE}`);
  }

  const created = await runAws(ctx, state, [
    "iam",
    "create-access-key",
    "--user-name",
    userName,
    "--output",
    "json",
  ]);
  // Redact after parse: never leave secret in logs via thrown executor messages later.
  const createdPayload = parseJsonOutput(created.stdout, "iam create-access-key");
  const accessKey = createdPayload.AccessKey ?? createdPayload;
  const accessKeyId = String(accessKey.AccessKeyId ?? "");
  const secretAccessKey = String(accessKey.SecretAccessKey ?? "");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("create-access-key did not return AccessKeyId/SecretAccessKey.");
  }

  const now = new Date().toISOString();
  /** @type {SetupState} */
  const nextState = {
    ...state,
    updatedAt: now,
    aws: sanitizePlanMetadata({
      ...(state.aws ?? {}),
      runtimeAccessKeyId: accessKeyId,
    }),
  };
  // Record non-secret key id first so a later env failure does not look like "no key".
  await writeState(nextState, ctx.env);

  const deployment = await loadDeploymentEnv(installationId, ctx.env);
  const nextEnv = {
    ...deployment,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  };
  // Atomic env write of id+secret together; never print either value.
  await writeDeploymentEnv(installationId, nextEnv, ctx.env);
  log("Runtime access key created and stored in deployment.env (values not printed).");
  return { accessKeyId, state: nextState };
}

/**
 * Stage handler for continue: never checkpoints on process success alone.
 * @type {import('./main.mjs').StageHandler}
 */
export const awsCoreStageHandler = {
  async isEligible(ctx, state) {
    void ctx;
    return state.stages.init?.status === "complete";
  },
  async run(ctx, state) {
    return runAwsCoreVerification(ctx, state);
  },
};

/**
 * @param {SetupContext} ctx
 * @param {SetupState} initialState
 */
export async function runAwsCoreVerification(ctx, initialState) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = initialState.installationId;
  let state = await loadState(installationId, ctx.env);
  const caller = await resolveCallerContext(ctx, state);

  const stack = state.aws?.stack;
  if (stack == null || typeof stack !== "object") {
    throw new Error(
      "AWS core is blocked: no stack ownership is stored. Run `pnpm nusend:setup aws plan` then `aws apply`.",
    );
  }
  const stackName = String(stack.stackName ?? "");
  const stackId = String(stack.stackId ?? "");
  const accountId = String(stack.accountId ?? "");
  const region = String(stack.region ?? "");
  if (!stackName || !stackId || !accountId || !region) {
    throw new Error("AWS core is blocked: stored stack ownership is incomplete.");
  }
  if (accountId !== state.config.awsAccountId || accountId !== caller.accountId) {
    throw new Error(
      `AWS core is blocked: stack account ${accountId} does not match expected/caller account.`,
    );
  }
  if (region !== state.config.awsRegion) {
    throw new Error(
      `AWS core is blocked: stack region ${region} does not match configured ${state.config.awsRegion}.`,
    );
  }
  if (stackName !== buildStackName(state.installationId)) {
    throw new Error(`AWS core is blocked: unexpected stack name ${stackName}.`);
  }

  // Confirm stack still exists with matching id.
  const live = await describeStack(ctx, state, stackName);
  if (!live.exists || live.stackId !== stackId) {
    throw new Error(
      `AWS core is blocked: live stack id does not match stored ownership (${stackId}).`,
    );
  }
  if (!live.status || !/_COMPLETE$/u.test(live.status) || /ROLLBACK|FAILED/u.test(live.status)) {
    throw new Error(`AWS core is blocked: live stack status is ${live.status ?? "unknown"}.`);
  }

  const identity = await refreshAndStoreIdentity(ctx, state, { persist: true });
  state = await loadState(installationId, ctx.env);
  if (
    !isIdentityReady({
      VerificationStatus: identity.verificationStatus,
      VerifiedForSendingStatus: identity.verifiedForSending,
    })
  ) {
    throw new Error(
      `AWS core is blocked: SES identity verification is not ready (VerificationStatus=${identity.verificationStatus}, VerifiedForSending=${identity.verifiedForSending}). Publish DKIM/DNS and rerun continue.`,
    );
  }
  if (
    !isDkimReady({
      DkimAttributes: {
        Status: identity.dkimStatus,
        SigningEnabled: identity.dkimSigningEnabled,
      },
    })
  ) {
    throw new Error(
      `AWS core is blocked: DKIM is not ready (Status=${identity.dkimStatus}, SigningEnabled=${identity.dkimSigningEnabled}). Wait for DNS propagation and rerun continue.`,
    );
  }

  // Runtime key gate
  const deployment = await loadDeploymentEnv(installationId, ctx.env);
  const envKeyId = deployment.AWS_ACCESS_KEY_ID?.trim() ?? "";
  const envSecret = deployment.AWS_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!state.aws?.runtimeAccessKeyId) {
    log("Runtime access key is missing; creating one requires an exact confirmation phrase.");
    await runCreateRuntimeKey(ctx, state);
    state = await loadState(installationId, ctx.env);
  } else if (!envKeyId || !envSecret) {
    throw new Error(
      `AWS core is blocked: runtime key ${state.aws.runtimeAccessKeyId} is recorded but deployment.env is missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. Restore the secret manually; the coordinator will not recreate it automatically.`,
    );
  } else if (state.aws.runtimeAccessKeyId !== envKeyId) {
    throw new Error(
      "AWS core is blocked: deployment.env AWS_ACCESS_KEY_ID does not match the recorded runtime key id.",
    );
  }

  // Production access: refresh status; submission optional; approval is a later human gate.
  await refreshProductionAccessStatus(ctx, state, { persist: true });
  state = await loadState(installationId, ctx.env);
  const production = state.aws?.productionAccess ?? {};
  if (
    production.productionAccessEnabled !== true &&
    production.status !== "pending" &&
    production.reviewStatus !== "PENDING"
  ) {
    log(
      "SES production access is not approved yet (sandbox ok for simulator). Submission remains optional via guided prompts.",
    );
    const submit = await askBoolean(ctx, "Submit SES production-access request now?", false);
    if (submit) {
      await runProductionAccessRequest(ctx, state, { submitEnabled: true });
      state = await loadState(installationId, ctx.env);
    }
  }

  const finalDeployment = await loadDeploymentEnv(installationId, ctx.env);
  const requiredEnv = [
    "AWS_REGION",
    "NUSEND_SES_FROM_EMAIL",
    "NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET",
    "NUSEND_SES_FEEDBACK_TOPIC_ARNS",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ];
  for (const key of requiredEnv) {
    if (!finalDeployment[key] || finalDeployment[key].trim() === "") {
      throw new Error(`AWS core is blocked: deployment.env missing ${key}.`);
    }
  }
  if (
    state.config.marketingEnabled &&
    !finalDeployment.NUSEND_SES_MARKETING_CONFIGURATION_SET?.trim()
  ) {
    throw new Error(
      "AWS core is blocked: marketing configuration set missing from deployment.env.",
    );
  }

  // Evidence only — secrets excluded by sanitize/checkpoint.
  return {
    verified: true,
    stackId,
    stackName,
    accountId,
    region,
    phase: String(stack.phase ?? "core"),
    identityVerificationStatus: identity.verificationStatus,
    verifiedForSending: identity.verifiedForSending,
    dkimStatus: identity.dkimStatus,
    dkimSigningEnabled: identity.dkimSigningEnabled,
    runtimeAccessKeyId: state.aws?.runtimeAccessKeyId,
    productionAccessStatus: state.aws?.productionAccess?.status ?? "unknown",
  };
}

/**
 * @param {SetupContext} ctx
 * @param {string} message
 */
async function askRequired(ctx, message) {
  const value = (await ctx.io.prompt(message)).trim();
  if (!value) throw new Error(`A value is required for: ${message.trim()}`);
  return value;
}

/**
 * @param {SetupContext} ctx
 * @param {string} label
 * @param {boolean} defaultValue
 */
async function askBoolean(ctx, label, defaultValue) {
  const hint = defaultValue ? "Y/n" : "y/N";
  const value = (await ctx.io.prompt(`${label} [${hint}]: `)).trim().toLowerCase();
  if (value === "") return defaultValue;
  if (["y", "yes"].includes(value)) return true;
  if (["n", "no"].includes(value)) return false;
  throw new Error("Please answer yes or no.");
}
