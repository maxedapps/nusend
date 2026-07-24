import { createHash } from "node:crypto";

import {
  describeStack,
  isActiveStackStatus,
  parseChangeSetArn,
  parseJsonOutput,
  resolveCallerContext,
  runAws,
} from "./aws.mjs";
import {
  assertFullCommitSha,
  inspectExistingCheckout,
  posixSingleQuote,
  runSsh,
} from "./deploy.mjs";
import {
  assertDlqEmpty,
  listTopicSubscriptions,
  parseSubscriptionAttributes,
  readDlqCounters,
} from "./validate.mjs";
import {
  loadDeploymentEnv,
  loadState,
  resolveInstallationId,
  sanitizePlanMetadata,
  writeDeploymentEnv,
  writeState,
} from "./state.mjs";

export const DESTROY_PLAN_KEY = "destroy";
export const DESTROY_PHRASE_PREFIX = "DESTROY";
export const DESTROY_PLAN_VERSION = 2;

export const RETAINED_RESOURCES = Object.freeze([
  "SES production access (regional account state)",
  "External/public DNS records, including manually managed DKIM records",
  "Cloudflare R2 bucket and restic repository/backups",
  "Google OAuth client and credentials",
  "Remote checkout and remote .env",
  "Nusend database data",
  "Caddy certificate/configuration state and backup working state",
  "All Docker Compose volumes",
]);

/** @typedef {import('./state.mjs').SetupState} SetupState */
/** @typedef {import('./main.mjs').SetupContext} SetupContext */

/** @param {string} stackId */
export function parseStackId(stackId) {
  const value = String(stackId ?? "").trim();
  const match = /^arn:([^:]+):cloudformation:([^:]+):(\d{12}):stack\/([^/]+)\/([^/]+)$/u.exec(
    value,
  );
  if (!match) throw new Error(`Stored CloudFormation stack ID is malformed: ${value}`);
  return {
    stackId: value,
    partition: match[1],
    region: match[2],
    accountId: match[3],
    stackName: match[4],
    uniqueId: match[5],
  };
}

/**
 * Require immutable coordinator evidence; names/tags are never ownership evidence.
 * @param {SetupState} state
 */
export function assertInitialStackCreationProof(state) {
  const stack = state.aws?.stack;
  const proof = state.aws?.stackCreation;
  if (!stack || typeof stack !== "object" || !proof || typeof proof !== "object") {
    throw new Error(
      "Destroy is blocked: initial stack ownership is unproven. A stack name or tag is not ownership evidence; require the coordinator's reviewed core CREATE proof.",
    );
  }
  const stackId = String(stack.stackId ?? "");
  const parsed = parseStackId(stackId);
  const expected = {
    stackId,
    stackName: String(stack.stackName ?? ""),
    accountId: String(stack.accountId ?? ""),
    partition: String(stack.partition ?? ""),
    region: String(stack.region ?? ""),
  };
  if (
    proof.provenance !== "coordinator-reviewed-change-set" ||
    proof.phase !== "core" ||
    proof.changeSetType !== "CREATE" ||
    typeof proof.changeSetArn !== "string" ||
    !proof.changeSetArn.startsWith("arn:") ||
    typeof proof.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(proof.fingerprint)
  ) {
    throw new Error(
      "Destroy is blocked: initial stack ownership is not an immutable coordinator core CREATE proof.",
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (proof[key] !== value) {
      throw new Error(`Destroy is blocked: initial stack creation proof ${key} mismatch.`);
    }
  }
  const changeSet = parseChangeSetArn(proof.changeSetArn);
  if (
    changeSet.partition !== expected.partition ||
    changeSet.region !== expected.region ||
    changeSet.accountId !== expected.accountId
  ) {
    throw new Error(
      "Destroy is blocked: initial CREATE change-set ARN differs from the exact stack context.",
    );
  }
  if (
    parsed.stackName !== expected.stackName ||
    parsed.accountId !== expected.accountId ||
    parsed.partition !== expected.partition ||
    parsed.region !== expected.region
  ) {
    throw new Error(
      "Destroy is blocked: stored stack ID/account/region/partition binding differs.",
    );
  }
  if (
    expected.stackName === "" ||
    expected.accountId !== state.config.awsAccountId ||
    expected.region !== state.config.awsRegion
  ) {
    throw new Error("Destroy is blocked: exact stack context differs from installation state.");
  }
  return { ...expected, proof: /** @type {Record<string, unknown>} */ (proof) };
}

/** @param {{ accountId: string, region: string, stackName: string, domain: string, sshTarget: string }} input */
export function buildDestroyConfirmationPhrase(input) {
  return `${DESTROY_PHRASE_PREFIX} ${input.accountId} ${input.region} ${input.stackName} ${input.domain} ${input.sshTarget}`;
}

/** @param {string} answer @param {Parameters<typeof buildDestroyConfirmationPhrase>[0]} expected */
export function validateDestroyConfirmation(answer, expected) {
  const phrase = buildDestroyConfirmationPhrase(expected);
  if (String(answer ?? "").trim() !== phrase) {
    throw new Error(`Confirmation rejected. Type exactly: ${phrase}`);
  }
  return phrase;
}

/** Fingerprint every reviewed, non-secret destroy-plan fact. */
export function fingerprintDestroyPlan(plan) {
  const canonical = JSON.stringify({
    version: plan.version,
    installationId: plan.installationId,
    accountId: plan.accountId,
    partition: plan.partition,
    region: plan.region,
    stackId: plan.stackId,
    stackName: plan.stackName,
    stackStatus: plan.stackStatus,
    stackExists: plan.stackExists,
    stackLastUpdatedTime: plan.stackLastUpdatedTime,
    domain: plan.domain,
    sshTarget: plan.sshTarget,
    remotePath: plan.remotePath,
    runtimeUserName: plan.runtimeUserName,
    runtimeAccessKeyId: plan.runtimeAccessKeyId,
    runtimeKeys: plan.runtimeKeys,
    runtimeKeyState: plan.runtimeKeyState,
    dlq: plan.dlq,
    stackResources: plan.stackResources,
    subscriptions: plan.subscriptions,
    alarms: plan.alarms,
    remote: plan.remote,
    retainedResources: plan.retainedResources,
    externalDkimRecords: plan.externalDkimRecords,
    creationProofFingerprint: plan.creationProofFingerprint,
    creationChangeSetArn: plan.creationChangeSetArn,
    plannedAt: plan.plannedAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** @param {Record<string, unknown> | undefined} checkpoint @param {ReturnType<typeof assertInitialStackCreationProof>} binding */
function isExactStackDeleteIntent(checkpoint, binding) {
  return Boolean(
    checkpoint &&
    checkpoint.stackId === binding.stackId &&
    checkpoint.stackName === binding.stackName &&
    checkpoint.accountId === binding.accountId &&
    checkpoint.partition === binding.partition &&
    checkpoint.region === binding.region,
  );
}

/** @param {Record<string, unknown> | undefined} checkpoint @param {string} keyId @param {string} userName @param {ReturnType<typeof assertInitialStackCreationProof>} binding */
function isExactKeyDeleteIntent(checkpoint, keyId, userName, binding) {
  return Boolean(
    checkpoint &&
    checkpoint.runtimeAccessKeyId === keyId &&
    checkpoint.runtimeUserName === userName &&
    checkpoint.stackId === binding.stackId &&
    checkpoint.accountId === binding.accountId &&
    checkpoint.region === binding.region,
  );
}

/** @param {SetupContext} ctx @param {SetupState} state @param {string} stackId */
async function listStackResources(ctx, state, stackId) {
  const result = await runAws(
    ctx,
    state,
    ["cloudformation", "list-stack-resources", "--stack-name", stackId, "--output", "json"],
    { allowNonZero: true },
  );
  if (result.exitCode !== 0) {
    if (/does not exist|not exist/iu.test(`${result.stdout}\n${result.stderr}`)) {
      return { absent: true, resources: [] };
    }
    throw new Error(
      `cloudformation list-stack-resources failed: ${result.stderr || result.stdout}`,
    );
  }
  const payload = parseJsonOutput(result.stdout, "cloudformation list-stack-resources");
  const summaries = Array.isArray(payload.StackResourceSummaries)
    ? payload.StackResourceSummaries
    : [];
  return {
    absent: false,
    resources: stableSort(
      summaries.map((item) => ({
        logicalId: String(item?.LogicalResourceId ?? ""),
        physicalId: String(item?.PhysicalResourceId ?? ""),
        type: String(item?.ResourceType ?? ""),
        status: String(item?.ResourceStatus ?? ""),
      })),
    ),
  };
}

/** @param {SetupContext} ctx @param {SetupState} state @param {string} userName */
async function listRuntimeKeys(ctx, state, userName) {
  const result = await runAws(
    ctx,
    state,
    ["iam", "list-access-keys", "--user-name", userName, "--output", "json"],
    { allowNonZero: true },
  );
  if (result.exitCode !== 0) {
    if (
      /NoSuchEntity|cannot be found|does not exist/iu.test(`${result.stdout}\n${result.stderr}`)
    ) {
      return { userExists: false, keys: [] };
    }
    throw new Error(`iam list-access-keys failed: ${result.stderr || result.stdout}`);
  }
  const payload = parseJsonOutput(result.stdout, "iam list-access-keys");
  if (!Array.isArray(payload.AccessKeyMetadata)) {
    throw new Error("IAM access-key inventory is malformed.");
  }
  return {
    userExists: true,
    keys: stableSort(
      payload.AccessKeyMetadata.map((key) => ({
        accessKeyId: String(key?.AccessKeyId ?? ""),
        status: String(key?.Status ?? "UNKNOWN"),
      })),
    ),
  };
}

/** @param {ReturnType<typeof listRuntimeKeys> extends Promise<infer T> ? T : never} inventory @param {string} recordedKeyId @param {boolean} missingAllowed */
function assertRuntimeKeyInventory(inventory, recordedKeyId, missingAllowed) {
  if (!recordedKeyId) throw new Error("Destroy is blocked: no runtime access-key ID is recorded.");
  const unknown = inventory.keys.filter((key) => key.accessKeyId !== recordedKeyId);
  if (unknown.length > 0) {
    throw new Error(
      `Destroy is blocked: runtime IAM user has ${unknown.length} unrecorded access key(s). Unknown keys are never deleted or inferred.`,
    );
  }
  const recorded = inventory.keys.filter((key) => key.accessKeyId === recordedKeyId);
  if (recorded.length > 1) throw new Error("IAM returned duplicate metadata for the recorded key.");
  if (recorded.length === 0 && !missingAllowed) {
    throw new Error(
      "Destroy is blocked: the recorded runtime key is missing without the exact prior delete-intent checkpoint.",
    );
  }
  return { present: recorded.length === 1, status: recorded[0]?.status ?? "absent" };
}

/** @param {SetupContext} ctx @param {SetupState} state @param {string} topicArn */
async function inventorySubscriptions(ctx, state, topicArn) {
  if (!topicArn) return [];
  const subscriptions = await listTopicSubscriptions(ctx, state, topicArn);
  const inventory = [];
  for (const item of subscriptions) {
    const pending = item.subscriptionArn.toLowerCase().includes("pending");
    let attributes = null;
    if (!pending) {
      // oxlint-disable-next-line no-await-in-loop -- exact subscription inventory is sequential and bounded.
      const result = await runAws(ctx, state, [
        "sns",
        "get-subscription-attributes",
        "--subscription-arn",
        item.subscriptionArn,
        "--output",
        "json",
      ]);
      attributes = parseSubscriptionAttributes(
        parseJsonOutput(result.stdout, "sns get-subscription-attributes"),
      );
    }
    inventory.push({
      subscriptionArn: item.subscriptionArn,
      protocol: item.protocol,
      endpoint: item.endpoint,
      owner: item.owner,
      pending,
      rawMessageDelivery: attributes?.rawMessageDelivery ?? null,
      redriveArn: attributes?.redriveArn ?? null,
    });
  }
  return stableSort(inventory);
}

/** @param {SetupContext} ctx @param {SetupState} state */
async function inventoryAlarms(ctx, state) {
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
  return stableSort(
    alarms.map((alarm) => ({
      name: String(alarm?.AlarmName ?? ""),
      state: String(alarm?.StateValue ?? "UNKNOWN"),
      actions: Array.isArray(alarm?.AlarmActions)
        ? alarm.AlarmActions.map(String).sort((left, right) => left.localeCompare(right))
        : [],
    })),
  );
}

/** @param {Record<string, unknown>[]} values */
function stableSort(values) {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

/** @param {unknown} raw */
function stackLastUpdatedTime(raw) {
  if (raw == null || typeof raw !== "object") return null;
  const value = String(/** @type {Record<string, unknown>} */ (raw).LastUpdatedTime ?? "").trim();
  return value || null;
}

/** @param {unknown} left @param {unknown} right */
function exactProviderInventoryMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Exact non-secret deploy evidence required before any remote stop can be reviewed. @param {SetupState} state */
function exactDeployEvidence(state) {
  const deploy = state.deploy;
  if (!deploy || typeof deploy !== "object") return null;
  const evidence = {
    sshTarget: String(deploy.sshTarget ?? ""),
    remotePath: String(deploy.remotePath ?? ""),
    domain: String(deploy.domain ?? ""),
    releaseTag: String(deploy.releaseTag ?? ""),
    commitSha: String(deploy.commitSha ?? ""),
  };
  if (
    evidence.sshTarget !== state.config.sshTarget ||
    evidence.remotePath !== state.config.remotePath ||
    evidence.domain !== state.config.domain ||
    evidence.releaseTag !== state.config.releaseTag
  ) {
    return null;
  }
  try {
    assertFullCommitSha(evidence.commitSha);
  } catch {
    return null;
  }
  return evidence;
}

/** Best-effort identity review: inability to prove the exact checkout never strands AWS cleanup. */
async function inspectTrustedRemote(ctx, state) {
  const evidence = exactDeployEvidence(state);
  if (!evidence) {
    return {
      reachable: null,
      status: "identity-unproven",
      stopReviewed: false,
      detail: "state.deploy does not contain exact target/path/domain/release/commit evidence",
    };
  }
  try {
    const checkout = await inspectExistingCheckout(
      ctx,
      state,
      evidence.remotePath,
      evidence.releaseTag,
      evidence.commitSha,
    );
    const result = await runSsh(
      ctx,
      state,
      `cd ${posixSingleQuote(evidence.remotePath)} && docker compose ps --format json`,
      { allowNonZero: true },
    );
    const lines = result.stdout.split(/\r?\n/u).filter((line) => line.trim());
    return {
      reachable: true,
      status: result.exitCode === 0 ? "inspected" : "unavailable",
      stopReviewed: true,
      evidence,
      checkout,
      ...(result.exitCode === 0
        ? { composeEntries: lines.length }
        : { detail: "docker compose ps failed" }),
    };
  } catch (error) {
    return {
      reachable: false,
      status: isSshUnreachable(error) ? "unreachable" : "identity-unproven",
      stopReviewed: false,
      evidence,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @param {unknown} error */
function isSshUnreachable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /timed? out|connection (?:refused|closed|reset)|no route to host|could not resolve hostname|network is unreachable|host is down/iu.test(
    message,
  );
}

/** @param {SetupState} state */
function externalDkimRecords(state) {
  if (state.config.route53HostedZoneId) return [];
  const outputs = state.aws?.stack?.outputs;
  if (!outputs || typeof outputs !== "object") return [];
  const records = [];
  for (let index = 1; index <= 3; index += 1) {
    const name = String(outputs[`DkimRecordName${index}`] ?? "");
    const value = String(outputs[`DkimRecordValue${index}`] ?? "");
    if (name && value) records.push({ type: "CNAME", name, value });
  }
  return records;
}

/** @param {SetupContext} ctx @param {SetupState} state @param {ReturnType<typeof assertInitialStackCreationProof>} binding */
async function assertCallerBinding(ctx, state, binding) {
  const caller = await resolveCallerContext(ctx, state);
  if (
    caller.accountId !== binding.accountId ||
    caller.region !== binding.region ||
    caller.partition !== binding.partition
  ) {
    throw new Error(
      "Destroy is blocked: caller account/region/partition differs from exact stack state.",
    );
  }
  return caller;
}

/** @param {(line: string) => void} log @param {Record<string, unknown>[]} dkim */
function reportRetained(log, dkim) {
  log("RETAINED — destroy will NOT remove these external/data resources:");
  for (const item of RETAINED_RESOURCES) log(`  - ${item}`);
  if (dkim.length > 0) {
    log("Manual external DNS cleanup after deletion (not performed by the coordinator):");
    for (const record of dkim) log(`  CNAME ${record.name} -> ${record.value}`);
  }
}

/** Read-only against AWS and VPS. The only mutation is the protected local reviewed-plan write. */
export async function runDestroyPlan(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);
  const binding = assertInitialStackCreationProof(state);
  await assertCallerBinding(ctx, state, binding);
  const previousApply = state.plans?.[DESTROY_PLAN_KEY]?.apply;
  const apply =
    previousApply && typeof previousApply === "object"
      ? /** @type {Record<string, unknown>} */ (previousApply)
      : {};
  const stackDeleteIntent =
    apply.stackDeleteIntent && typeof apply.stackDeleteIntent === "object"
      ? /** @type {Record<string, unknown>} */ (apply.stackDeleteIntent)
      : undefined;

  const live = await describeStack(ctx, state, binding.stackId);
  if (live.exists) {
    if (live.stackId !== binding.stackId) {
      throw new Error("Destroy is blocked: live stack ID differs from stored exact stack ID.");
    }
    if (isActiveStackStatus(live.status)) {
      throw new Error(`Destroy is blocked: stack operation is active (${live.status}).`);
    }
  } else if (!isExactStackDeleteIntent(stackDeleteIntent, binding)) {
    throw new Error(
      "Destroy is blocked: exact stack is unexpectedly missing without its durable deletion-request checkpoint.",
    );
  }

  const outputs = state.aws?.stack?.outputs;
  if (!outputs || typeof outputs !== "object") {
    throw new Error("Destroy is blocked: stored stack outputs are missing.");
  }
  const runtimeUserName = String(outputs.RuntimeUserName ?? "");
  const runtimeAccessKeyId = String(state.aws?.runtimeAccessKeyId ?? "");
  if (!runtimeUserName || !runtimeAccessKeyId) {
    throw new Error("Destroy is blocked: runtime user/key ownership state is incomplete.");
  }
  const keyDeleteIntent =
    apply.runtimeKeyDeleteIntent && typeof apply.runtimeKeyDeleteIntent === "object"
      ? /** @type {Record<string, unknown>} */ (apply.runtimeKeyDeleteIntent)
      : undefined;
  const keyInventory = await listRuntimeKeys(ctx, state, runtimeUserName);
  const keyState = assertRuntimeKeyInventory(
    keyInventory,
    runtimeAccessKeyId,
    isExactKeyDeleteIntent(keyDeleteIntent, runtimeAccessKeyId, runtimeUserName, binding),
  );

  const dlq = live.exists ? await readDlqCounters(ctx, state) : null;
  if (dlq) assertDlqEmpty(dlq);
  const resources = live.exists
    ? await listStackResources(ctx, state, binding.stackId)
    : { absent: true, resources: [] };
  const feedbackTopicArn = String(outputs.FeedbackTopicArn ?? "");
  const alarmTopicArn = String(outputs.AlarmTopicArn ?? "");
  const subscriptions = live.exists
    ? {
        feedback: await inventorySubscriptions(ctx, state, feedbackTopicArn),
        alarm: await inventorySubscriptions(ctx, state, alarmTopicArn),
      }
    : { feedback: [], alarm: [] };
  const alarms = live.exists ? await inventoryAlarms(ctx, state) : [];
  const remote = await inspectTrustedRemote(ctx, state);
  const dkim = externalDkimRecords(state);
  const plannedAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const plan = sanitizePlanMetadata({
    version: DESTROY_PLAN_VERSION,
    installationId,
    accountId: binding.accountId,
    partition: binding.partition,
    region: binding.region,
    stackId: binding.stackId,
    stackName: binding.stackName,
    stackStatus: live.status ?? "ABSENT_AFTER_CHECKPOINT",
    stackExists: live.exists,
    stackLastUpdatedTime: stackLastUpdatedTime(live.raw),
    domain: state.config.domain,
    sshTarget: state.config.sshTarget,
    remotePath: state.config.remotePath,
    runtimeUserName,
    runtimeAccessKeyId,
    runtimeKeys: keyInventory.keys,
    runtimeKeyState: keyState,
    dlq,
    stackResources: resources.resources,
    subscriptions,
    alarms,
    remote,
    retainedResources: [...RETAINED_RESOURCES],
    externalDkimRecords: dkim,
    creationProofFingerprint: String(binding.proof.fingerprint),
    creationChangeSetArn: String(binding.proof.changeSetArn),
    plannedAt,
    consumed: false,
    apply,
  });
  plan.fingerprint = fingerprintDestroyPlan(plan);

  await writeState(
    {
      ...state,
      updatedAt: plannedAt,
      plans: { ...state.plans, [DESTROY_PLAN_KEY]: plan },
    },
    ctx.env,
  );

  log(`Destroy plan for exact stack ID: ${binding.stackId}`);
  log(`  account=${binding.accountId} partition=${binding.partition} region=${binding.region}`);
  log(`  status=${plan.stackStatus} resources=${resources.resources.length}`);
  log(
    `  runtime key=${keyState.status}; subscriptions=${subscriptions.feedback.length + subscriptions.alarm.length}; alarms=${alarms.length}`,
  );
  log(
    `  DLQ=${dlq ? `visible=${dlq.visible}, notVisible=${dlq.notVisible}, delayed=${dlq.delayed}` : "already removed after checkpoint"}`,
  );
  log(
    `  VPS=${remote.status}${remote.stopReviewed ? " (exact checkout reviewed)" : " (remote stop skipped; AWS cleanup remains available)"}`,
  );
  log(`  fingerprint=${plan.fingerprint}`);
  reportRetained(log, dkim);
  log(`Type on apply: ${buildDestroyConfirmationPhrase(plan)}`);
  return plan;
}

/** @param {SetupContext} ctx @param {SetupState} state @param {Record<string, unknown>} plan @param {Record<string, unknown>} apply */
async function persistApply(ctx, state, plan, apply) {
  const now = new Date().toISOString();
  const latest = await loadState(state.installationId, ctx.env);
  const currentPlan = latest.plans?.[DESTROY_PLAN_KEY];
  if (!currentPlan || currentPlan.fingerprint !== plan.fingerprint) {
    throw new Error("Destroy plan changed while applying; refusing to continue.");
  }
  await writeState(
    {
      ...latest,
      updatedAt: now,
      plans: {
        ...latest.plans,
        [DESTROY_PLAN_KEY]: sanitizePlanMetadata({ ...currentPlan, apply, updatedAt: now }),
      },
    },
    ctx.env,
  );
  return loadState(state.installationId, ctx.env);
}

/** @param {SetupContext} ctx @param {SetupState} state @param {Record<string, string>} evidence */
async function stopRemoteCompose(ctx, state, evidence) {
  try {
    const result = await runSsh(
      ctx,
      state,
      `cd ${posixSingleQuote(evidence.remotePath)} && docker compose stop`,
      { allowNonZero: true },
    );
    // A returned result proves SSH reached and ran the remote command. Docker/Compose stderr can
    // contain transport-like phrases; only a thrown SSH transport error is treated as unreachable.
    return {
      reachable: true,
      stopped: result.exitCode === 0,
      exitCode: result.exitCode,
      command: "docker compose stop",
      volumesRemoved: false,
    };
  } catch (error) {
    if (!isSshUnreachable(error)) throw error;
    return {
      reachable: false,
      stopped: false,
      skipped: true,
      reason: "unreachable",
      command: "docker compose stop",
      volumesRemoved: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @param {Record<string, unknown>} remote @param {SetupState} state */
function reviewedRemoteEvidence(remote, state) {
  if (remote.stopReviewed !== true || !remote.evidence || typeof remote.evidence !== "object") {
    return null;
  }
  const planned = /** @type {Record<string, unknown>} */ (remote.evidence);
  const current = exactDeployEvidence(state);
  if (!current || !exactProviderInventoryMatches(planned, current)) return null;
  return current;
}

/** @param {SetupContext} ctx @param {SetupState} state @param {Record<string, unknown>} plan */
async function recheckReviewedRemote(ctx, state, plan) {
  const remote =
    plan.remote && typeof plan.remote === "object"
      ? /** @type {Record<string, unknown>} */ (plan.remote)
      : {};
  const evidence = reviewedRemoteEvidence(remote, state);
  if (!evidence) {
    return {
      trusted: false,
      outcome: {
        reachable: null,
        stopped: false,
        skipped: true,
        reason: "identity-not-reviewed-or-state-changed",
        command: "docker compose stop",
        volumesRemoved: false,
      },
    };
  }
  try {
    const checkout = await inspectExistingCheckout(
      ctx,
      state,
      evidence.remotePath,
      evidence.releaseTag,
      evidence.commitSha,
    );
    return { trusted: true, evidence, checkout };
  } catch (error) {
    return {
      trusted: false,
      outcome: {
        reachable: !isSshUnreachable(error),
        stopped: false,
        skipped: true,
        reason: isSshUnreachable(error) ? "unreachable" : "identity-unproven",
        command: "docker compose stop",
        volumesRemoved: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** @param {SetupContext} ctx @param {SetupState} state @param {string} stackId */
async function deletionFailureDiagnostics(ctx, state, stackId) {
  const result = await runAws(
    ctx,
    state,
    [
      "cloudformation",
      "describe-stack-events",
      "--stack-name",
      stackId,
      "--max-items",
      "30",
      "--output",
      "json",
    ],
    { allowNonZero: true },
  );
  if (result.exitCode !== 0) return "CloudFormation deletion diagnostics unavailable.";
  const payload = parseJsonOutput(result.stdout, "cloudformation describe-stack-events");
  const events = Array.isArray(payload.StackEvents) ? payload.StackEvents : [];
  const failures = events
    .filter((event) => String(event?.ResourceStatus ?? "") === "DELETE_FAILED")
    .slice(0, 10)
    .map(
      (event) =>
        `${String(event?.LogicalResourceId ?? "unknown")}: ${String(event?.ResourceStatusReason ?? "no reason returned")}`,
    );
  return failures.length > 0
    ? `Failed logical resource(s):\n${failures.map((line) => `- ${line}`).join("\n")}`
    : "No DELETE_FAILED logical-resource event was returned; inspect this exact stack ID.";
}

/** @param {SetupContext} ctx */
export async function runDestroyApply(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  let state = await loadState(installationId, ctx.env);
  const plan = state.plans?.[DESTROY_PLAN_KEY];
  if (!plan || typeof plan !== "object") {
    throw new Error("No reviewed destroy plan. Run `pnpm nusend:setup destroy plan` first.");
  }
  if (plan.consumed === true)
    throw new Error("Destroy plan is already consumed; stack deletion was verified.");
  if (plan.version !== DESTROY_PLAN_VERSION || fingerprintDestroyPlan(plan) !== plan.fingerprint) {
    throw new Error(
      "Stored destroy plan fingerprint is stale or mismatched. Run destroy plan again.",
    );
  }
  const binding = assertInitialStackCreationProof(state);
  await assertCallerBinding(ctx, state, binding);
  for (const [key, expected] of Object.entries({
    installationId,
    accountId: binding.accountId,
    partition: binding.partition,
    region: binding.region,
    stackId: binding.stackId,
    stackName: binding.stackName,
    domain: state.config.domain,
    sshTarget: state.config.sshTarget,
    remotePath: state.config.remotePath,
    creationProofFingerprint: String(binding.proof.fingerprint),
    creationChangeSetArn: String(binding.proof.changeSetArn),
  })) {
    if (plan[key] !== expected)
      throw new Error(`Stored destroy plan ${key} differs from current exact state.`);
  }

  /** @type {Record<string, unknown>} */
  let apply =
    plan.apply && typeof plan.apply === "object"
      ? { .../** @type {Record<string, unknown>} */ (plan.apply) }
      : {};
  const outputs = state.aws?.stack?.outputs;
  const runtimeUserName = String(outputs?.RuntimeUserName ?? "");
  const runtimeAccessKeyId = String(state.aws?.runtimeAccessKeyId ?? "");
  if (runtimeUserName !== plan.runtimeUserName || runtimeAccessKeyId !== plan.runtimeAccessKeyId) {
    throw new Error("Runtime key/user state differs from the reviewed destroy plan.");
  }

  let live = await describeStack(ctx, state, binding.stackId);
  if (live.exists && live.stackId !== binding.stackId) {
    throw new Error("Live stack differs from the exact reviewed stack ID.");
  }
  const resumingOwnDeletion =
    live.status === "DELETE_IN_PROGRESS" &&
    isExactStackDeleteIntent(/** @type {any} */ (apply.stackDeleteIntent), binding);
  if (live.exists && isActiveStackStatus(live.status) && !resumingOwnDeletion) {
    throw new Error(`Destroy is blocked: stack operation is active (${live.status}).`);
  }
  if (
    !live.exists &&
    !isExactStackDeleteIntent(/** @type {any} */ (apply.stackDeleteIntent), binding)
  ) {
    throw new Error(
      "Exact stack is unexplainedly missing; no matching deletion-request checkpoint exists.",
    );
  }

  const keyInventory = await listRuntimeKeys(ctx, state, runtimeUserName);
  assertRuntimeKeyInventory(
    keyInventory,
    runtimeAccessKeyId,
    isExactKeyDeleteIntent(
      /** @type {any} */ (apply.runtimeKeyDeleteIntent),
      runtimeAccessKeyId,
      runtimeUserName,
      binding,
    ),
  );
  if (live.exists) assertDlqEmpty(await readDlqCounters(ctx, state));

  // Before any prompt or mutation, reject provider state that differs from the reviewed plan.
  // Once our exact stack-delete intent exists, provider inventory is expected to be changing.
  if (
    live.exists &&
    !isExactStackDeleteIntent(/** @type {any} */ (apply.stackDeleteIntent), binding)
  ) {
    const refreshedResources = await listStackResources(ctx, state, binding.stackId);
    const feedbackTopicArn = String(outputs?.FeedbackTopicArn ?? "");
    const alarmTopicArn = String(outputs?.AlarmTopicArn ?? "");
    const refreshedSubscriptions = {
      feedback: await inventorySubscriptions(ctx, state, feedbackTopicArn),
      alarm: await inventorySubscriptions(ctx, state, alarmTopicArn),
    };
    const refreshedAlarms = await inventoryAlarms(ctx, state);
    const changed = [];
    const plannedLastUpdated =
      plan.stackLastUpdatedTime == null ? null : String(plan.stackLastUpdatedTime);
    if (stackLastUpdatedTime(live.raw) !== plannedLastUpdated) {
      changed.push("CloudFormation LastUpdatedTime");
    }
    if (!exactProviderInventoryMatches(plan.stackResources, refreshedResources.resources)) {
      changed.push("exact stack resources");
    }
    if (!exactProviderInventoryMatches(plan.subscriptions, refreshedSubscriptions)) {
      changed.push("feedback/alarm subscriptions");
    }
    if (!exactProviderInventoryMatches(plan.alarms, refreshedAlarms)) {
      changed.push("alarms");
    }
    if (changed.length > 0) {
      throw new Error(
        `Destroy plan provider inventory changed after planning (${changed.join(", ")}); run destroy plan again.`,
      );
    }
  }

  if (!apply.approved) {
    reportRetained(log, Array.isArray(plan.externalDkimRecords) ? plan.externalDkimRecords : []);
    const expected = buildDestroyConfirmationPhrase(plan);
    log(`Type exactly: ${expected}`);
    validateDestroyConfirmation(await ctx.io.prompt("Destroy confirmation: "), plan);
    apply.approved = {
      confirmedAt: new Date().toISOString(),
      accountId: binding.accountId,
      region: binding.region,
      stackId: binding.stackId,
      domain: state.config.domain,
      sshTarget: state.config.sshTarget,
    };
    state = await persistApply(ctx, state, plan, apply);
  }

  if (
    !apply.remoteStop ||
    (typeof apply.remoteStop === "object" &&
      apply.remoteStop != null &&
      /** @type {Record<string, unknown>} */ (apply.remoteStop).reachable === true &&
      /** @type {Record<string, unknown>} */ (apply.remoteStop).stopped !== true)
  ) {
    const rechecked = await recheckReviewedRemote(ctx, state, plan);
    if (!rechecked.trusted) {
      apply.remoteStop = { ...rechecked.outcome, checkedAt: new Date().toISOString() };
      state = await persistApply(ctx, state, plan, apply);
      log(
        "Remote stop skipped because the exact reviewed checkout identity could not be proven; continuing exact AWS cleanup without remote mutation.",
      );
    } else {
      apply.remoteStopIntent = {
        ...rechecked.evidence,
        command: "docker compose stop",
        volumesRemoved: false,
        recordedAt: new Date().toISOString(),
      };
      state = await persistApply(ctx, state, plan, apply);

      // The durable intent comes first; then identity is checked again immediately before mutation.
      const immediate = await recheckReviewedRemote(ctx, state, plan);
      if (!immediate.trusted) {
        apply.remoteStop = { ...immediate.outcome, checkedAt: new Date().toISOString() };
        state = await persistApply(ctx, state, plan, apply);
        log(
          "Remote stop skipped because the exact reviewed checkout identity could not be proven; continuing exact AWS cleanup without remote mutation.",
        );
      } else {
        const remoteStop = await stopRemoteCompose(
          ctx,
          state,
          /** @type {Record<string, string>} */ (immediate.evidence),
        );
        apply.remoteStop = { ...remoteStop, attemptedAt: new Date().toISOString() };
        state = await persistApply(ctx, state, plan, apply);
        if (remoteStop.reachable && !remoteStop.stopped) {
          throw new Error(
            "VPS is reachable but `docker compose stop` failed. Fix the remote Compose error and rerun; no AWS resource was deleted.",
          );
        }
        log(
          remoteStop.stopped
            ? "Remote Compose stopped without volume removal."
            : "VPS unreachable; continuing exact AWS cleanup. Checkout, .env, and volumes remain retained.",
        );
      }
    }
  }

  if (
    !isExactKeyDeleteIntent(
      /** @type {any} */ (apply.runtimeKeyDeleteIntent),
      runtimeAccessKeyId,
      runtimeUserName,
      binding,
    )
  ) {
    apply.runtimeKeyDeleteIntent = {
      runtimeAccessKeyId,
      runtimeUserName,
      stackId: binding.stackId,
      accountId: binding.accountId,
      region: binding.region,
      recordedAt: new Date().toISOString(),
    };
    state = await persistApply(ctx, state, plan, apply);
  }

  const liveKeys = await listRuntimeKeys(ctx, state, runtimeUserName);
  const keyState = assertRuntimeKeyInventory(liveKeys, runtimeAccessKeyId, true);
  if (keyState.present) {
    await runAws(ctx, state, [
      "iam",
      "delete-access-key",
      "--user-name",
      runtimeUserName,
      "--access-key-id",
      runtimeAccessKeyId,
    ]);
  }

  // This provider read is deliberately immediate and repeated after key deletion/absence handling.
  if (live.exists) {
    const finalDlq = await readDlqCounters(ctx, state);
    assertDlqEmpty(finalDlq);
    const finalKeys = await listRuntimeKeys(ctx, state, runtimeUserName);
    assertRuntimeKeyInventory(finalKeys, runtimeAccessKeyId, true);
    apply.runtimeKeyDeleted = {
      runtimeAccessKeyId,
      deletedOrAlreadyAbsent: true,
      checkedAt: new Date().toISOString(),
    };
    apply.finalDlqCheck = { ...finalDlq, checkedAt: new Date().toISOString() };
    state = await persistApply(ctx, state, plan, apply);
  }

  if (!isExactStackDeleteIntent(/** @type {any} */ (apply.stackDeleteIntent), binding)) {
    apply.stackDeleteIntent = {
      stackId: binding.stackId,
      stackName: binding.stackName,
      accountId: binding.accountId,
      partition: binding.partition,
      region: binding.region,
      requestedAt: new Date().toISOString(),
    };
    state = await persistApply(ctx, state, plan, apply);
  }

  if (live.exists) {
    if (!resumingOwnDeletion) {
      await runAws(ctx, state, ["cloudformation", "delete-stack", "--stack-name", binding.stackId]);
    } else {
      log("Resuming the coordinator-requested deletion of the same exact stack ID.");
    }
    const waited = await runAws(
      ctx,
      state,
      ["cloudformation", "wait", "stack-delete-complete", "--stack-name", binding.stackId],
      { allowNonZero: true },
    );
    live = await describeStack(ctx, state, binding.stackId);
    if (live.exists) {
      const diagnostics = await deletionFailureDiagnostics(ctx, state, binding.stackId);
      throw new Error(
        `Deletion of exact stack ${binding.stackId} did not complete (status=${live.status ?? "unknown"}, waiter=${waited.exitCode}). Rerun destroy apply to retry this same exact stack.\n${diagnostics}`,
      );
    }
  }

  // Independent absence check: both stack description and exact stack-resource inventory must say absent.
  const absentStack = await describeStack(ctx, state, binding.stackId);
  const absentResources = await listStackResources(ctx, state, binding.stackId);
  if (absentStack.exists || !absentResources.absent) {
    throw new Error("Independent exact stack/resource absence verification failed.");
  }
  apply.stackDeletionVerified = {
    stackId: binding.stackId,
    accountId: binding.accountId,
    region: binding.region,
    verifiedAbsentAt: new Date().toISOString(),
    describeStacksAbsent: true,
    listStackResourcesAbsent: true,
  };
  state = await persistApply(ctx, state, plan, apply);

  // Only verified stack deletion permits local credential removal. Atomic env replacement retains all data/provider values.
  const deployment = await loadDeploymentEnv(installationId, ctx.env);
  delete deployment.AWS_ACCESS_KEY_ID;
  delete deployment.AWS_SECRET_ACCESS_KEY;
  delete deployment.AWS_SESSION_TOKEN;
  await writeDeploymentEnv(installationId, deployment, ctx.env);

  apply.localCredentialsRemoved = { completedAt: new Date().toISOString() };
  apply.completed = {
    completedAt: new Date().toISOString(),
    exactStackId: binding.stackId,
    retainedResources: [...RETAINED_RESOURCES],
  };
  const now = new Date().toISOString();
  const latest = await loadState(installationId, ctx.env);
  await writeState(
    {
      ...latest,
      updatedAt: now,
      plans: {
        ...latest.plans,
        [DESTROY_PLAN_KEY]: sanitizePlanMetadata({
          ...latest.plans[DESTROY_PLAN_KEY],
          apply,
          consumed: true,
          consumedAt: now,
          tombstone: {
            exactStackId: binding.stackId,
            accountId: binding.accountId,
            partition: binding.partition,
            region: binding.region,
            verifiedDeletedAt: now,
          },
        }),
      },
    },
    ctx.env,
  );
  reportRetained(log, Array.isArray(plan.externalDkimRecords) ? plan.externalDkimRecords : []);
  log(
    `Verified deletion of exact stack ${binding.stackId}; local AWS runtime credentials removed.`,
  );
  return { verified: true, stackId: binding.stackId, retainedResources: [...RETAINED_RESOURCES] };
}
