import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStackName,
  describeStack,
  parseJsonOutput,
  parseStackOutputs,
  refreshProductionAccessStatus,
  resolveCallerContext,
  runAws,
} from "./aws.mjs";
import { posixSingleQuote, runSsh, validateDeployHealth } from "./deploy.mjs";
import { redactText } from "./process.mjs";
import {
  loadDeploymentEnv,
  loadState,
  resolveInstallationId,
  sanitizePlanMetadata,
  secretValuesFromEnv,
  writeState,
} from "./state.mjs";

export const RUN_SIMULATOR_PHRASE = "RUN-SES-SIMULATOR";
export const ALARM_EXERCISE_PHRASE_PREFIX = "ALARM-NOTIFICATION-EXERCISED";
export const VALIDATION_PLAN_KEY = "validation";
export const REFRESH_PLAN_KEY = "refresh";
export const WEBHOOK_PATH = "/api/webhooks/aws/sns/ses";

export const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "cli",
  "dist",
  "main.js",
);

export const BASE_REQUIRED_READINESS_IDS = Object.freeze([
  "config.aws_region",
  "config.from_email",
  "config.configuration_set.transactional",
  "config.feedback_topics",
  "db.ses_operations_schema",
  "aws.credentials_and_account",
  "ses.account.production_access",
  "ses.account.sending_enabled",
  "ses.account.enforcement_status",
  "ses.identity.from_email",
  "ses.identity.dkim",
  "ses.config_set.transactional.exists",
  "ses.config_set.transactional.suppression",
  "ses.config_set.transactional.events",
  "sns.topic.exists",
  "sns.topic.signature_version",
  "sns.subscription.webhook",
]);

export const MARKETING_REQUIRED_READINESS_IDS = Object.freeze([
  "config.configuration_set.marketing",
  "config.unsubscribe_secret",
  "ses.config_set.marketing.exists",
  "ses.config_set.marketing.suppression",
  "ses.config_set.marketing.events",
]);

export const PRODUCTION_GATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "backup_restore",
    title: "Backup restore proof",
    phrase: (state) => `BACKUP-RESTORE-PROVEN ${state.installationId}`,
    action:
      "Restore the latest restic backup into an isolated location and verify the database before confirming.",
  }),
  Object.freeze({
    id: "reboot_recovery",
    title: "VPS reboot recovery proof",
    phrase: (state) => `REBOOT-RECOVERY-PROVEN ${state.config.sshTarget}`,
    action:
      "Perform an authorized VPS reboot and verify Compose and mandatory backup health recover before confirming.",
  }),
  Object.freeze({
    id: "gmail_headers",
    title: "Real Gmail DKIM/header inspection",
    phrase: (state) => `GMAIL-HEADERS-PROVEN ${state.config.domain}`,
    action:
      "Send an authorized real message to Gmail and inspect Authentication-Results/DKIM headers before confirming.",
  }),
  Object.freeze({
    id: "dmarc",
    title: "DMARC policy evidence",
    phrase: (state) => `DMARC-PROVEN ${state.config.sesIdentity}`,
    action:
      "Publish and verify the operator-selected DMARC policy outside this coordinator before confirming.",
  }),
  Object.freeze({
    id: "quota_ramp",
    title: "SES quota and ramp plan",
    phrase: (state) => `QUOTA-RAMP-REVIEWED ${state.config.awsAccountId} ${state.config.awsRegion}`,
    action:
      "Review current SES quotas and document a conservative volume/ramp plan before confirming.",
  }),
  Object.freeze({
    id: "provider_firewall",
    title: "Provider firewall verification",
    phrase: (state) => `PROVIDER-FIREWALL-VERIFIED ${state.config.domain}`,
    action:
      "Verify the provider firewall and ingress-mode restrictions from the provider console before confirming.",
  }),
]);

const EXPECTED_ALARMS = Object.freeze([
  ["sns-notifications-failed", "NumberOfNotificationsFailed"],
  ["sns-redriven-to-dlq", "NumberOfNotificationsRedrivenToDlq"],
  ["sns-redrive-failed", "NumberOfNotificationsFailedToRedriveToDlq"],
  ["dlq-visible-messages", "ApproximateNumberOfMessagesVisible"],
]);

/** @typedef {import('./state.mjs').SetupState} SetupState */
/** @typedef {import('./main.mjs').SetupContext} SetupContext */

/** @param {SetupState} state */
export function stackOutputs(state) {
  const outputs = state.aws?.stack?.outputs;
  if (outputs == null || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new Error("Stored stack outputs are missing. Apply the core stack first.");
  }
  return /** @type {Record<string, string>} */ (outputs);
}

/** @param {SetupState} state */
export function expectedWebhookEndpoint(state) {
  return `https://${state.config.domain}${WEBHOOK_PATH}`;
}

/** @param {unknown} payload */
export function parseSubscriptions(payload) {
  const raw = payload && typeof payload === "object" ? /** @type {any} */ (payload) : {};
  if (!Array.isArray(raw.Subscriptions)) throw new Error("SNS subscription response is malformed.");
  return raw.Subscriptions.map((entry) => ({
    subscriptionArn: String(entry?.SubscriptionArn ?? ""),
    protocol: String(entry?.Protocol ?? "").toLowerCase(),
    endpoint: String(entry?.Endpoint ?? ""),
    owner: String(entry?.Owner ?? ""),
  }));
}

/** Read every page so a pending/duplicate subscription cannot hide behind NextToken. */
export async function listTopicSubscriptions(ctx, state, topicArn) {
  const subscriptions = [];
  let nextToken = "";
  do {
    const command = [
      "sns",
      "list-subscriptions-by-topic",
      "--topic-arn",
      topicArn,
      "--output",
      "json",
    ];
    if (nextToken) command.push("--next-token", nextToken);
    // oxlint-disable-next-line no-await-in-loop -- provider pagination is sequential by token.
    const result = await runAws(ctx, state, command);
    const payload = parseJsonOutput(result.stdout, "sns list-subscriptions-by-topic");
    subscriptions.push(...parseSubscriptions(payload));
    nextToken = typeof payload.NextToken === "string" ? payload.NextToken : "";
  } while (nextToken);
  return subscriptions;
}

/** Guard used before the finalize change set is even created. */
export async function assertPreFinalizeSubscriptionAbsence(ctx, state) {
  const outputs = stackOutputs(state);
  const topicArn = String(outputs.FeedbackTopicArn ?? "");
  if (!topicArn) throw new Error("Stored stack outputs are missing FeedbackTopicArn.");
  const deployment = await loadDeploymentEnv(state.installationId, ctx.env);
  if (deployment.NUSEND_SES_FEEDBACK_TOPIC_ARNS?.trim() !== topicArn) {
    throw new Error(
      "Finalize is blocked: the deployed topic allowlist does not exactly match the stack-owned feedback topic.",
    );
  }
  if (state.stages.deploy?.status !== "complete") {
    throw new Error("Finalize is blocked until the healthy deploy stage is checkpointed.");
  }
  const subscriptions = await listTopicSubscriptions(ctx, state, topicArn);
  const https = subscriptions.filter((entry) => entry.protocol === "https");
  if (https.length > 0) {
    const states = https.map((entry) =>
      entry.subscriptionArn.toLowerCase().includes("pending") ? "pending" : "confirmed",
    );
    throw new Error(
      `Finalize is blocked: ${https.length} pre-existing HTTPS subscription(s) exist (${states.join(", ")}). Resolve the pending/duplicate/wrong endpoint manually; the coordinator will not create another.`,
    );
  }
  return {
    verified: true,
    topicArn,
    expectedEndpoint: expectedWebhookEndpoint(state),
    httpsCount: 0,
  };
}

/** @param {unknown} payload */
export function parseSubscriptionAttributes(payload) {
  const attrs =
    payload && typeof payload === "object" ? /** @type {any} */ (payload).Attributes : null;
  if (attrs == null || typeof attrs !== "object" || Array.isArray(attrs)) {
    throw new Error("SNS subscription attributes response is malformed.");
  }
  let redrive = null;
  if (typeof attrs.RedrivePolicy === "string" && attrs.RedrivePolicy.trim()) {
    try {
      redrive = JSON.parse(attrs.RedrivePolicy);
    } catch (error) {
      throw new Error("SNS subscription RedrivePolicy is malformed JSON.", { cause: error });
    }
  }
  return {
    endpoint: String(attrs.Endpoint ?? ""),
    protocol: String(attrs.Protocol ?? "").toLowerCase(),
    pending: String(attrs.PendingConfirmation ?? "").toLowerCase() === "true",
    rawMessageDelivery: String(attrs.RawMessageDelivery ?? "").toLowerCase(),
    redriveArn: String(redrive?.deadLetterTargetArn ?? ""),
  };
}

/** Require exactly one confirmed exact HTTPS subscription and exact CF-owned attributes. */
export async function verifyFinalizedSubscription(ctx, state, options = {}) {
  const outputs = stackOutputs(state);
  const topicArn = String(outputs.FeedbackTopicArn ?? "");
  const dlqArn = String(outputs.DlqArn ?? "");
  const expectedEndpoint = expectedWebhookEndpoint(state);
  if (!topicArn || !dlqArn) throw new Error("Stack outputs are missing feedback topic or DLQ ARN.");
  const attempts = Number(options.attempts ?? 12);
  let subscriptions = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- confirmation polling must remain sequential.
    subscriptions = await listTopicSubscriptions(ctx, state, topicArn);
    const https = subscriptions.filter((entry) => entry.protocol === "https");
    if (https.length > 1) {
      throw new Error(
        `Expected one HTTPS subscription; found ${https.length}. Resolve duplicates manually.`,
      );
    }
    if (https.length === 1 && !https[0].subscriptionArn.toLowerCase().includes("pending")) break;
    if (https.length === 1 && https[0].endpoint !== expectedEndpoint) {
      throw new Error(
        `HTTPS subscription endpoint is ${https[0].endpoint}, expected ${expectedEndpoint}.`,
      );
    }
    if (attempt < attempts) {
      // oxlint-disable-next-line no-await-in-loop -- deliberate bounded provider confirmation polling.
      await (ctx.sleep?.(5000) ?? new Promise((resolve) => setTimeout(resolve, 5000)));
    }
  }
  const https = subscriptions.filter((entry) => entry.protocol === "https");
  if (https.length !== 1) {
    throw new Error(
      `Expected exactly one HTTPS subscription after finalization; found ${https.length}.`,
    );
  }
  const subscription = https[0];
  if (subscription.owner !== state.config.awsAccountId) {
    throw new Error(
      `HTTPS subscription owner is ${subscription.owner || "unknown"}, expected account ${state.config.awsAccountId}.`,
    );
  }
  if (subscription.endpoint !== expectedEndpoint) {
    throw new Error(
      `HTTPS subscription endpoint is ${subscription.endpoint}, expected ${expectedEndpoint}.`,
    );
  }
  if (subscription.subscriptionArn.toLowerCase().includes("pending")) {
    throw new Error(
      "The exact HTTPS subscription is still PendingConfirmation. Inspect Nusend/Caddy logs, TLS, and the topic allowlist; do not create another subscription.",
    );
  }
  const result = await runAws(ctx, state, [
    "sns",
    "get-subscription-attributes",
    "--subscription-arn",
    subscription.subscriptionArn,
    "--output",
    "json",
  ]);
  const attrs = parseSubscriptionAttributes(
    parseJsonOutput(result.stdout, "sns get-subscription-attributes"),
  );
  if (
    attrs.protocol !== "https" ||
    attrs.endpoint !== expectedEndpoint ||
    attrs.pending ||
    attrs.rawMessageDelivery !== "false" ||
    attrs.redriveArn !== dlqArn
  ) {
    throw new Error(
      "Finalized subscription has wrong endpoint, confirmation, raw-delivery, or redrive state. Refusing to accept it.",
    );
  }
  return {
    verified: true,
    topicArn,
    subscriptionArn: subscription.subscriptionArn,
    endpoint: expectedEndpoint,
    rawMessageDelivery: false,
    dlqArn,
  };
}

/** @param {SetupContext} ctx @param {SetupState} state */
export async function verifyAlarmsAndEmail(ctx, state) {
  const outputs = stackOutputs(state);
  const alarmTopicArn = String(outputs.AlarmTopicArn ?? "");
  const feedbackTopicArn = String(outputs.FeedbackTopicArn ?? "");
  if (!alarmTopicArn || alarmTopicArn === feedbackTopicArn) {
    throw new Error("Dedicated alarm topic is missing or equals the SES feedback topic.");
  }
  const subscriptions = await listTopicSubscriptions(ctx, state, alarmTopicArn);
  const emailSubscriptions = subscriptions.filter((entry) => entry.protocol === "email");
  const expected = emailSubscriptions.filter((entry) => entry.endpoint === state.config.alertEmail);
  if (emailSubscriptions.length !== 1 || expected.length !== 1) {
    throw new Error(
      `Expected exactly one alarm email subscription, for ${state.config.alertEmail}; found ${emailSubscriptions.length} email subscription(s) and ${expected.length} exact match(es).`,
    );
  }
  if (expected[0].owner !== state.config.awsAccountId) {
    throw new Error(
      `Alarm email subscription owner is ${expected[0].owner || "unknown"}, expected account ${state.config.awsAccountId}.`,
    );
  }
  if (expected[0].subscriptionArn.toLowerCase().includes("pending")) {
    throw new Error(
      `Alarm email subscription for ${state.config.alertEmail} is PendingConfirmation. Open the AWS confirmation email, then rerun continue.`,
    );
  }

  const prefix = `nusend-${state.config.installationName ?? state.installationId}-`;
  const result = await runAws(ctx, state, [
    "cloudwatch",
    "describe-alarms",
    "--alarm-name-prefix",
    prefix,
    "--output",
    "json",
  ]);
  const payload = parseJsonOutput(result.stdout, "cloudwatch describe-alarms");
  const alarms = Array.isArray(payload.MetricAlarms) ? payload.MetricAlarms : [];
  if (alarms.length !== EXPECTED_ALARMS.length) {
    throw new Error(
      `Expected exactly ${EXPECTED_ALARMS.length} dedicated CloudWatch metric alarms; found ${alarms.length}.`,
    );
  }
  for (const [suffix, metric] of EXPECTED_ALARMS) {
    const match = alarms.filter(
      (alarm) => alarm?.AlarmName === `${prefix}${suffix}` && alarm?.MetricName === metric,
    );
    if (match.length !== 1) throw new Error(`Expected one CloudWatch alarm ${prefix}${suffix}.`);
    const actions = Array.isArray(match[0].AlarmActions) ? match[0].AlarmActions.map(String) : [];
    if (
      actions.length !== 1 ||
      actions[0] !== alarmTopicArn ||
      actions.includes(feedbackTopicArn)
    ) {
      throw new Error(`Alarm ${prefix}${suffix} must use only the dedicated alarm topic action.`);
    }
  }
  return {
    verified: true,
    alarmTopicArn,
    alertEmail: state.config.alertEmail,
    emailSubscriptionArn: expected[0].subscriptionArn,
    alarmCount: EXPECTED_ALARMS.length,
  };
}

export function buildAlarmExercisePhrase(state) {
  return `${ALARM_EXERCISE_PHRASE_PREFIX} ${state.config.alertEmail}`;
}

/** @param {SetupContext} ctx @param {SetupState} initialState */
export async function runAwsFinalizeStageVerification(ctx, initialState) {
  const state = await loadState(initialState.installationId, ctx.env);
  await resolveCallerContext(ctx, state);
  const stack = state.aws?.stack;
  if (!stack || stack.phase !== "finalize") {
    throw new Error(
      "AWS finalize is blocked. Run `pnpm nusend:setup aws plan`, review the finalize change set, then run `aws apply`.",
    );
  }
  const live = await describeStack(ctx, state, buildStackName(state.installationId));
  if (
    !live.exists ||
    live.stackId !== stack.stackId ||
    !String(live.status).endsWith("_COMPLETE")
  ) {
    throw new Error("AWS finalize is blocked: the exact owned stack is absent or not complete.");
  }
  const subscription = await verifyFinalizedSubscription(ctx, state);
  const alarms = await verifyAlarmsAndEmail(ctx, state);
  const validation = state.plans?.[VALIDATION_PLAN_KEY] ?? {};
  const exercised = validation.alarmExercise;
  if (!exercised || typeof exercised !== "object") {
    const phrase = buildAlarmExercisePhrase(state);
    ctx.io.log?.(
      "Exercise the dedicated CloudWatch alarm notification path and verify delivery to the alert mailbox.",
    );
    ctx.io.log?.("Do not use the SES feedback topic as an alarm action.");
    ctx.io.log?.(`Type exactly after observing delivery: ${phrase}`);
    const answer = (await ctx.io.prompt("Alarm exercise evidence: ")).trim();
    if (answer !== phrase) throw new Error(`Evidence rejected. Type exactly: ${phrase}`);
    const now = new Date().toISOString();
    await writeValidationPlan(ctx, state, {
      alarmExercise: { verified: true, completedAt: now, alertEmail: state.config.alertEmail },
    });
  }
  return { verified: true, subscription, alarms, alarmNotificationExercised: true };
}

/** @param {SetupState} state @param {boolean} final */
export function requiredReadinessIds(state, final = false) {
  return [
    ...BASE_REQUIRED_READINESS_IDS,
    ...(state.config.marketingEnabled ? MARKETING_REQUIRED_READINESS_IDS : []),
    ...(final ? ["operations.latest_feedback"] : []),
  ];
}

/** @param {unknown} payload @param {readonly string[]} requiredIds */
export function assertReadinessPayload(payload, requiredIds) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Nusend CLI readiness JSON must be an object.");
  }
  const checks = /** @type {any} */ (payload).checks;
  if (!Array.isArray(checks)) throw new Error("Nusend CLI readiness JSON is missing checks[].");
  const byId = new Map();
  for (const check of checks) {
    if (check && typeof check === "object" && typeof check.id === "string") {
      if (byId.has(check.id))
        throw new Error(`Nusend readiness returned duplicate check id ${check.id}.`);
      byId.set(check.id, check);
    }
  }
  const missing = requiredIds.filter((id) => !byId.has(id));
  if (missing.length > 0)
    throw new Error(`Nusend readiness is missing required checks: ${missing.join(", ")}.`);
  const failing = requiredIds
    .map((id) => byId.get(id))
    .filter((check) => check.status !== "ok")
    .map((check) => `${check.id}=${check.status}`);
  if (failing.length > 0)
    throw new Error(`Required Nusend readiness checks are not ok: ${failing.join(", ")}.`);
  return {
    status: String(/** @type {any} */ (payload).status ?? ""),
    requiredIds: [...requiredIds],
    checkCount: checks.length,
  };
}

/** @param {SetupContext} ctx @param {SetupState} state @param {readonly string[]} args */
export async function runBuiltCliJson(ctx, state, args) {
  const cliPath = ctx.cliPath ?? CLI_PATH;
  try {
    await access(cliPath, constants.X_OK);
  } catch (error) {
    throw new Error(
      "Built Nusend CLI is absent or not executable. Run `pnpm --filter @nusend/cli build`, then `apps/cli/dist/main.js --json login https://" +
        state.config.domain +
        "`.",
      { cause: error },
    );
  }
  let secrets = [];
  try {
    secrets = secretValuesFromEnv(await loadDeploymentEnv(state.installationId, ctx.env));
  } catch {
    secrets = [];
  }
  const result = await ctx.executor({
    command: cliPath,
    args: ["--json", ...args],
    allowNonZero: true,
    redact: secrets,
  });
  if (result.exitCode !== 0) {
    const detail = redactText(result.stderr || result.stdout, secrets);
    if (result.exitCode === 3 || /unauthenticated|authentication required|login/iu.test(detail)) {
      throw new Error(
        `Built Nusend CLI is unauthenticated. Run \`${cliPath} --json login https://${state.config.domain}\`, then rerun validation.`,
      );
    }
    throw new Error(`Built Nusend CLI failed (${result.exitCode}): ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("Built Nusend CLI returned malformed JSON.", { cause: error });
  }
}

/** @param {SetupContext} ctx @param {SetupState} state @param {boolean} final */
export async function runReadinessValidation(ctx, state, final) {
  const payload = await runBuiltCliJson(ctx, state, ["ses", "readiness"]);
  const expected = expectedWebhookEndpoint(state);
  if (payload?.expectedWebhookUrl !== expected) {
    throw new Error(
      `Built Nusend CLI is connected to readiness for ${String(payload?.expectedWebhookUrl ?? "unknown")}, expected ${expected}. Log in to the deployed Nusend domain.`,
    );
  }
  return assertReadinessPayload(payload, requiredReadinessIds(state, final));
}

/** @param {SetupContext} ctx */
export async function runPreSimulatorValidation(ctx) {
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);
  await resolveCallerContext(ctx, state);
  if (state.stages.aws_finalize?.status !== "complete") {
    throw new Error("Pre-simulator validation requires the verified aws_finalize stage.");
  }
  const readiness = await runReadinessValidation(ctx, state, false);
  const queue = await readDlqCounters(ctx, state);
  assertDlqEmpty(queue);
  return { verified: true, readiness, dlq: queue };
}

/** @param {string} stdout @param {string} scenario */
export function parseSimulatorResult(stdout, scenario) {
  const lines = String(stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const payload = JSON.parse(line);
      if (payload && typeof payload === "object" && typeof payload.status === "string") {
        if (payload.status !== "validated") {
          throw new Error(
            `Simulator ${scenario} ended with status ${payload.status}, expected validated.`,
          );
        }
        const runId = String(payload.runId ?? "");
        const recipientEmail = String(payload.recipientEmail ?? "");
        const expectedRecipient = `${scenario}@simulator.amazonses.com`;
        if (!runId || recipientEmail !== expectedRecipient) {
          throw new Error(
            `Simulator ${scenario} returned incomplete/wrong evidence (runId=${runId || "missing"}, recipient=${recipientEmail || "missing"}).`,
          );
        }
        return { scenario, status: payload.status, runId, recipientEmail };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Simulator ")) throw error;
    }
  }
  throw new Error(`Simulator ${scenario} returned no valid JSON result.`);
}

/** @param {SetupContext} ctx */
export async function runSimulatorValidation(ctx) {
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);
  if (state.stages.validate_pre_simulator?.status !== "complete") {
    throw new Error("Simulator validation requires completed pre-simulator validation.");
  }
  ctx.io.log?.("This runs live SES mailbox-simulator sends and may be rate-limited or billed.");
  const answer = (await ctx.io.prompt(`Type ${RUN_SIMULATOR_PHRASE} to continue: `)).trim();
  if (answer !== RUN_SIMULATOR_PHRASE) {
    throw new Error(`Confirmation rejected. Type exactly: ${RUN_SIMULATOR_PHRASE}`);
  }
  const commands = [
    ["success", "end-to-end"],
    ["bounce", "end-to-end"],
    ["complaint", "end-to-end"],
  ];
  const results = [];
  for (const [scenario, mode] of commands) {
    const remote = `cd ${posixSingleQuote(state.config.remotePath)} && docker compose exec -T api bun apps/service/src/ses/simulator-main.ts ${scenario} --purpose transactional --mode ${mode}`;
    // oxlint-disable-next-line no-await-in-loop -- simulator scenarios intentionally run in semantic order.
    const result = await runSsh(ctx, state, remote);
    results.push(parseSimulatorResult(result.stdout, scenario));
  }
  const now = new Date().toISOString();
  await writeValidationPlan(ctx, state, {
    simulator: { verified: true, completedAt: now, results },
  });
  return { verified: true, confirmation: RUN_SIMULATOR_PHRASE, scenarios: results };
}

/** @param {unknown} payload @param {string} reason @param {string} email */
export function assertProtectedSuppression(payload, reason, email) {
  if (
    payload == null ||
    typeof payload !== "object" ||
    !Array.isArray(/** @type {any} */ (payload).items)
  ) {
    throw new Error(`Suppression JSON for ${reason} is malformed.`);
  }
  const found = /** @type {any} */ (payload).items.some(
    (item) => item?.email === email && item?.scope === "all" && item?.reason === reason,
  );
  if (!found)
    throw new Error(`Expected protected global ${reason} suppression for ${email} was not found.`);
  return { email, scope: "all", reason };
}

/** @param {SetupContext} ctx @param {SetupState} state */
async function validateProtectedSuppressions(ctx, state) {
  const bounceEmail = "bounce@simulator.amazonses.com";
  const complaintEmail = "complaint@simulator.amazonses.com";
  const bounce = assertProtectedSuppression(
    await runBuiltCliJson(ctx, state, [
      "suppressions",
      "list",
      "--email",
      bounceEmail,
      "--scope",
      "all",
      "--reason",
      "bounce",
    ]),
    "bounce",
    bounceEmail,
  );
  const complaint = assertProtectedSuppression(
    await runBuiltCliJson(ctx, state, [
      "suppressions",
      "list",
      "--email",
      complaintEmail,
      "--scope",
      "all",
      "--reason",
      "complaint",
    ]),
    "complaint",
    complaintEmail,
  );
  return { bounce, complaint };
}

/** @param {SetupContext} ctx */
export async function runFinalValidation(ctx) {
  const installationId = await resolveInstallationId(ctx.env);
  let state = await loadState(installationId, ctx.env);
  if (state.stages.validate_simulator?.status !== "complete") {
    throw new Error("Final validation requires the completed simulator stage.");
  }
  assertSimulatorStageEvidence(state.stages.validate_simulator.evidence);

  const next = productionGateProgress(state).find((gate) => !gate.complete);
  if (next) {
    ctx.io.log?.(`Manual production gate (one next action): ${next.title}`);
    ctx.io.log?.(next.action);
    ctx.io.log?.("This evidence is operator-controlled and is not marked automated.");
    ctx.io.log?.(`Type exactly: ${next.phrase}`);
    const answer = (await ctx.io.prompt("Production gate evidence: ")).trim();
    if (answer !== next.phrase) throw new Error(`Evidence rejected. Type exactly: ${next.phrase}`);
    const now = new Date().toISOString();
    await writeValidationPlan(
      ctx,
      state,
      next.id === "alarm_delivery"
        ? { alarmExercise: { verified: true, completedAt: now } }
        : {
            productionGates: {
              ...productionGateEvidence(state),
              [next.id]: { verified: true, completedAt: now },
            },
          },
    );
    state = await loadState(installationId, ctx.env);
    const remaining = productionGateProgress(state).filter((gate) => !gate.complete);
    if (remaining.length > 0) {
      return {
        verified: false,
        progress: true,
        completedGate: next.id,
        remaining: remaining.map((gate) => gate.id),
      };
    }
  }

  // Run volatile automated checks once, only after every manual gate, immediately before the
  // caller checkpoints validate_final. Repeated per-gate snapshots are stale and intentionally
  // not persisted.
  await resolveCallerContext(ctx, state);
  const readiness = await runReadinessValidation(ctx, state, true);
  const suppressions = await validateProtectedSuppressions(ctx, state);
  const queue = await readDlqCounters(ctx, state);
  assertDlqEmpty(queue);
  return {
    verified: true,
    readiness,
    suppressions,
    dlq: queue,
    productionGates: productionGateProgress(state).map((gate) => gate.id),
    alarmNotificationExercised: true,
  };
}

export function assertSimulatorStageEvidence(evidence) {
  const scenarios = evidence?.scenarios;
  if (!Array.isArray(scenarios)) {
    throw new Error("Final validation requires stored simulator scenario evidence.");
  }
  for (const expected of ["success", "bounce", "complaint"]) {
    const matches = scenarios.filter(
      (scenario) =>
        scenario?.scenario === expected &&
        scenario?.status === "validated" &&
        typeof scenario?.runId === "string" &&
        scenario.runId.length > 0 &&
        scenario?.recipientEmail === `${expected}@simulator.amazonses.com`,
    );
    if (matches.length !== 1) {
      throw new Error(`Final validation requires one validated ${expected} simulator result.`);
    }
  }
  return true;
}

/** @param {SetupState} state */
function productionGateEvidence(state) {
  const validation = state.plans?.[VALIDATION_PLAN_KEY];
  return validation && typeof validation.productionGates === "object" && validation.productionGates
    ? /** @type {Record<string, unknown>} */ (validation.productionGates)
    : {};
}

/** @param {SetupState} state */
export function productionGateProgress(state) {
  const evidence = productionGateEvidence(state);
  const alarmExercise = state.plans?.[VALIDATION_PLAN_KEY]?.alarmExercise;
  return [
    {
      id: "alarm_delivery",
      title: "Alarm notification delivery exercise",
      action: "Exercise and observe the dedicated alarm notification.",
      phrase: buildAlarmExercisePhrase(state),
      complete: Boolean(alarmExercise),
    },
    ...PRODUCTION_GATE_DEFINITIONS.map((gate) => ({
      id: gate.id,
      title: gate.title,
      action: gate.action,
      phrase: gate.phrase(state),
      complete: evidence[gate.id] != null,
    })),
  ];
}

/** @param {SetupContext} ctx @param {SetupState} state */
export async function readDlqCounters(ctx, state) {
  const url = String(stackOutputs(state).DlqUrl ?? "");
  if (!url) throw new Error("Stack outputs are missing DlqUrl.");
  const result = await runAws(ctx, state, [
    "sqs",
    "get-queue-attributes",
    "--queue-url",
    url,
    "--attribute-names",
    "ApproximateNumberOfMessages",
    "ApproximateNumberOfMessagesNotVisible",
    "ApproximateNumberOfMessagesDelayed",
    "--output",
    "json",
  ]);
  const payload = parseJsonOutput(result.stdout, "sqs get-queue-attributes");
  const attrs = payload.Attributes;
  if (attrs == null || typeof attrs !== "object")
    throw new Error("SQS queue attributes are malformed.");
  const counters = {
    visible: parseCounter(attrs.ApproximateNumberOfMessages, "ApproximateNumberOfMessages"),
    notVisible: parseCounter(
      attrs.ApproximateNumberOfMessagesNotVisible,
      "ApproximateNumberOfMessagesNotVisible",
    ),
    delayed: parseCounter(
      attrs.ApproximateNumberOfMessagesDelayed,
      "ApproximateNumberOfMessagesDelayed",
    ),
  };
  return counters;
}

function parseCounter(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`SQS ${name} is invalid.`);
  return number;
}

export function assertDlqEmpty(counters) {
  const nonzero = Object.entries(counters).filter(([, value]) => value !== 0);
  if (nonzero.length > 0)
    throw new Error(
      `DLQ is not empty: ${nonzero.map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    );
  return counters;
}

/** Store only sanitized summaries/evidence. */
async function writeValidationPlan(ctx, state, patch) {
  const now = new Date().toISOString();
  const latest = await loadState(state.installationId, ctx.env);
  await writeState(
    {
      ...latest,
      updatedAt: now,
      plans: {
        ...latest.plans,
        [VALIDATION_PLAN_KEY]: sanitizePlanMetadata({
          ...(latest.plans?.[VALIDATION_PLAN_KEY] ?? {}),
          ...patch,
          updatedAt: now,
        }),
      },
    },
    ctx.env,
  );
}

/** Opt-in provider refresh plus drift detection and sanitized local summary persistence. */
export async function runProviderRefresh(ctx, initialState) {
  const state = await loadState(initialState.installationId, ctx.env);
  const checkedAt = new Date().toISOString();
  let secrets = [];
  try {
    secrets = secretValuesFromEnv(await loadDeploymentEnv(state.installationId, ctx.env));
  } catch {
    secrets = [];
  }
  const summary = { checkedAt };
  const persistSummary = async () => {
    const sanitized = sanitizePlanMetadata(summary);
    const next = await loadState(state.installationId, ctx.env);
    await writeState(
      {
        ...next,
        updatedAt: checkedAt,
        plans: { ...next.plans, [REFRESH_PLAN_KEY]: sanitized },
      },
      ctx.env,
    );
    return sanitized;
  };
  const capture = async (key, fn) => {
    try {
      summary[key] = { status: "ok", ...(await fn()) };
    } catch (error) {
      summary[key] = {
        status: "unavailable",
        message: redactText(error instanceof Error ? error.message : String(error), secrets),
      };
    }
  };

  try {
    const caller = await resolveCallerContext(ctx, state);
    summary.caller = { status: "ok", accountId: caller.accountId, region: caller.region };
  } catch (error) {
    summary.caller = {
      status: "unavailable",
      message: redactText(error instanceof Error ? error.message : String(error), secrets),
    };
    summary.blocked = {
      status: "blocked",
      reason: "aws-caller-binding",
      message: "No further provider refresh operations were attempted.",
    };
    return persistSummary();
  }

  await capture("stack", async () => {
    const live = await describeStack(ctx, state, buildStackName(state.installationId));
    const outputs = live.raw ? parseStackOutputs(/** @type {any} */ (live.raw).Outputs ?? []) : {};
    return {
      exists: live.exists,
      stackId: live.stackId,
      stackStatus: live.status,
      outputKeys: Object.keys(outputs).sort(),
    };
  });
  await capture("drift", async () => {
    const detected = await runAws(ctx, state, [
      "cloudformation",
      "detect-stack-drift",
      "--stack-name",
      buildStackName(state.installationId),
      "--output",
      "json",
    ]);
    const detection = parseJsonOutput(detected.stdout, "cloudformation detect-stack-drift");
    const detectionId = String(detection.StackDriftDetectionId ?? "");
    if (!detectionId) throw new Error("CloudFormation drift detection returned no id.");
    await runAws(
      ctx,
      state,
      [
        "cloudformation",
        "wait",
        "stack-drift-detection-complete",
        "--stack-drift-detection-id",
        detectionId,
      ],
      { allowNonZero: true },
    );
    const statusResult = await runAws(ctx, state, [
      "cloudformation",
      "describe-stack-drift-detection-status",
      "--stack-drift-detection-id",
      detectionId,
      "--output",
      "json",
    ]);
    const status = parseJsonOutput(
      statusResult.stdout,
      "cloudformation describe-stack-drift-detection-status",
    );
    if (status.DetectionStatus !== "DETECTION_COMPLETE") {
      throw new Error(
        `CloudFormation drift detection did not complete (${String(status.DetectionStatus ?? "unknown")}).`,
      );
    }
    const result = await runAws(ctx, state, [
      "cloudformation",
      "describe-stack-resource-drifts",
      "--stack-name",
      buildStackName(state.installationId),
      "--output",
      "json",
    ]);
    const payload = parseJsonOutput(result.stdout, "cloudformation describe-stack-resource-drifts");
    const drifts = Array.isArray(payload.StackResourceDrifts) ? payload.StackResourceDrifts : [];
    return {
      stackDriftStatus: String(status.StackDriftStatus ?? "UNKNOWN"),
      resourceCount: drifts.length,
      driftedCount: drifts.filter(
        (item) =>
          item?.StackResourceDriftStatus === "MODIFIED" ||
          item?.StackResourceDriftStatus === "DELETED",
      ).length,
    };
  });
  await capture("ses", async () => {
    const identityResult = await runAws(ctx, state, [
      "sesv2",
      "get-email-identity",
      "--email-identity",
      state.config.sesIdentity,
      "--output",
      "json",
    ]);
    const identity = parseJsonOutput(identityResult.stdout, "sesv2 get-email-identity");
    const production = await refreshProductionAccessStatus(ctx, state, { persist: false });
    return {
      verificationStatus: String(identity.VerificationStatus ?? ""),
      dkimStatus: String(identity.DkimAttributes?.Status ?? ""),
      productionAccessEnabled: production.productionAccessEnabled === true,
      reviewStatus: String(production.reviewStatus ?? "UNKNOWN"),
    };
  });
  await capture("subscription", async () => {
    const value = await verifyFinalizedSubscription(ctx, state, { attempts: 1 });
    return {
      confirmed: true,
      endpoint: value.endpoint,
      rawMessageDelivery: value.rawMessageDelivery,
      dlqArn: value.dlqArn,
    };
  });
  await capture("dlq", async () => readDlqCounters(ctx, state));
  await capture("remote", async () => {
    const deployment = await loadDeploymentEnv(state.installationId, ctx.env);
    const health = await validateDeployHealth(ctx, state, {
      domain: state.config.domain,
      remotePath: state.config.remotePath,
      secrets: secretValuesFromEnv(deployment),
    });
    return {
      composeHealthy: true,
      publicHealth: health.publicHealth,
      publicHealthDb: health.publicHealthDb,
      apiHealthDb: health.apiHealthDb,
    };
  });
  await capture("readiness", async () =>
    runReadinessValidation(ctx, state, state.stages.validate_simulator?.status === "complete"),
  );

  return persistSummary();
}

export const awsFinalizeStageHandler = {
  async isEligible(ctx, state) {
    void ctx;
    return state.stages.deploy?.status === "complete";
  },
  run: runAwsFinalizeStageVerification,
};

export const preSimulatorStageHandler = {
  async isEligible(ctx, state) {
    void ctx;
    return state.stages.aws_finalize?.status === "complete";
  },
  run: runPreSimulatorValidation,
};

export const simulatorStageHandler = {
  async isEligible(ctx, state) {
    void ctx;
    return state.stages.validate_pre_simulator?.status === "complete";
  },
  run: runSimulatorValidation,
};

export const finalValidationStageHandler = {
  async isEligible(ctx, state) {
    void ctx;
    return state.stages.validate_simulator?.status === "complete";
  },
  run: runFinalValidation,
};
