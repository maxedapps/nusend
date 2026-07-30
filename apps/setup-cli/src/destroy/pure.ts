import { createHash } from "node:crypto";

import { parseChangeSetArn } from "../aws/pure.ts";
import { assertFullCommitSha } from "../deploy/pure.ts";
import type { SetupState } from "../state/schema.ts";

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

export function parseStackId(stackId: string): {
  stackId: string;
  partition: string;
  region: string;
  accountId: string;
  stackName: string;
  uniqueId: string;
} {
  const value = String(stackId ?? "").trim();
  const match = /^arn:([^:]+):cloudformation:([^:]+):(\d{12}):stack\/([^/]+)\/([^/]+)$/u.exec(
    value,
  );
  if (!match) throw new Error(`Stored CloudFormation stack ID is malformed: ${value}`);
  return {
    stackId: value,
    partition: match[1]!,
    region: match[2]!,
    accountId: match[3]!,
    stackName: match[4]!,
    uniqueId: match[5]!,
  };
}

export type StackCreationBinding = {
  stackId: string;
  stackName: string;
  accountId: string;
  partition: string;
  region: string;
  proof: Record<string, unknown>;
};

export function assertInitialStackCreationProof(state: SetupState): StackCreationBinding {
  const stack = state.aws?.stack as Record<string, unknown> | undefined;
  const proof = state.aws?.stackCreation as Record<string, unknown> | undefined;
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
    !String(proof.changeSetArn).startsWith("arn:") ||
    typeof proof.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(String(proof.fingerprint))
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
  const changeSet = parseChangeSetArn(String(proof.changeSetArn));
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
  return { ...expected, proof };
}

export function buildDestroyConfirmationPhrase(input: {
  accountId: string;
  region: string;
  stackName: string;
  domain: string;
  sshTarget: string;
}): string {
  return `${DESTROY_PHRASE_PREFIX} ${input.accountId} ${input.region} ${input.stackName} ${input.domain} ${input.sshTarget}`;
}

export function validateDestroyConfirmation(
  answer: string,
  expected: {
    accountId: string;
    region: string;
    stackName: string;
    domain: string;
    sshTarget: string;
  },
): string {
  const phrase = buildDestroyConfirmationPhrase(expected);
  if (String(answer ?? "").trim() !== phrase) {
    throw new Error(`Confirmation rejected. Type exactly: ${phrase}`);
  }
  return phrase;
}

export function fingerprintDestroyPlan(plan: Record<string, unknown>): string {
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

export function isExactStackDeleteIntent(
  checkpoint: Record<string, unknown> | undefined,
  binding: StackCreationBinding,
): boolean {
  return Boolean(
    checkpoint &&
    checkpoint.stackId === binding.stackId &&
    checkpoint.stackName === binding.stackName &&
    checkpoint.accountId === binding.accountId &&
    checkpoint.partition === binding.partition &&
    checkpoint.region === binding.region,
  );
}

export function isExactKeyDeleteIntent(
  checkpoint: Record<string, unknown> | undefined,
  keyId: string,
  userName: string,
  binding: StackCreationBinding,
): boolean {
  return Boolean(
    checkpoint &&
    checkpoint.runtimeAccessKeyId === keyId &&
    checkpoint.runtimeUserName === userName &&
    checkpoint.stackId === binding.stackId &&
    checkpoint.accountId === binding.accountId &&
    checkpoint.region === binding.region,
  );
}

export function stableSort<T extends Record<string, unknown>>(values: T[]): T[] {
  return [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

export function stackLastUpdatedTime(raw: unknown): string | null {
  if (raw == null || typeof raw !== "object") return null;
  const value = String((raw as Record<string, unknown>).LastUpdatedTime ?? "").trim();
  return value || null;
}

export function exactProviderInventoryMatches(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function exactDeployEvidence(state: SetupState): {
  sshTarget: string;
  remotePath: string;
  domain: string;
  releaseTag: string;
  commitSha: string;
} | null {
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

export function isSshUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed? out|connection (?:refused|closed|reset)|no route to host|could not resolve hostname|network is unreachable|host is down/iu.test(
    message,
  );
}

export function externalDkimRecords(
  state: SetupState,
): Array<{ type: "CNAME"; name: string; value: string }> {
  if (state.config.route53HostedZoneId) return [];
  const outputs = state.aws?.stack?.outputs as Record<string, unknown> | undefined;
  if (!outputs || typeof outputs !== "object") return [];
  const records: Array<{ type: "CNAME"; name: string; value: string }> = [];
  for (let index = 1; index <= 3; index += 1) {
    const name = String(outputs[`DkimRecordName${index}`] ?? "");
    const value = String(outputs[`DkimRecordValue${index}`] ?? "");
    if (name && value) records.push({ type: "CNAME", name, value });
  }
  return records;
}

export function assertRuntimeKeyInventory(
  inventory: { keys: Array<{ accessKeyId: string; status: string }> },
  recordedKeyId: string,
  missingAllowed: boolean,
): { present: boolean; status: string } {
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

export function reviewedRemoteEvidence(
  remote: Record<string, unknown>,
  state: SetupState,
): {
  sshTarget: string;
  remotePath: string;
  domain: string;
  releaseTag: string;
  commitSha: string;
} | null {
  if (remote.stopReviewed !== true || !remote.evidence || typeof remote.evidence !== "object") {
    return null;
  }
  const planned = remote.evidence as Record<string, unknown>;
  const current = exactDeployEvidence(state);
  if (!current || !exactProviderInventoryMatches(planned, current)) return null;
  return current;
}
