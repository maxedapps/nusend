import { createHash } from "node:crypto";

import type { SetupState } from "../state/schema.ts";
import {
  APPLY_PHRASE_PREFIX,
  CHANGE_SET_NAME_PREFIX,
  FABRICATED_PLACEHOLDERS,
  PRODUCTION_BRIEF_FIELDS,
  STACK_NAME_PREFIX,
  STACK_OUTPUT_ENV_MAP,
  type ProductionBriefField,
} from "./constants.ts";

export type StackParameter = {
  readonly ParameterKey: string;
  readonly ParameterValue: string;
};

export type ChangeSetResourceSummary = {
  readonly action: string;
  readonly logicalId: string;
  readonly type: string;
  readonly replacement: string;
};

export type ChangeSetSummary = {
  readonly status: string;
  readonly statusReason: string;
  readonly executionStatus: string;
  readonly changeSetId: string;
  readonly changeSetName: string;
  readonly stackId: string;
  readonly stackName: string;
  readonly capabilities: readonly string[];
  readonly resourceCount: number;
  readonly replacements: number;
  readonly iamChanges: number;
  readonly resources: readonly ChangeSetResourceSummary[];
  readonly noChange: boolean;
};

export type ParsedChangeSetArn = {
  readonly arn: string;
  readonly partition: string;
  readonly region: string;
  readonly accountId: string;
  readonly changeSetName: string;
  readonly changeSetUniqueId: string;
};

export type IdentitySummary = {
  readonly verificationStatus: string;
  readonly verifiedForSending: boolean;
  readonly dkimStatus: string;
  readonly dkimSigningEnabled: boolean;
};

export type ProductionAccessSummary = {
  readonly productionAccessEnabled: boolean;
  readonly reviewStatus: string;
  readonly sendingEnabled: boolean | null;
};

export type FailedStackEvent = {
  readonly logicalId: string;
  readonly status: string;
  readonly reason: string;
  readonly timestamp: string;
};

export function buildStackName(installationId: string): string {
  return `${STACK_NAME_PREFIX}${installationId}`;
}

export function buildChangeSetName(installationId: string, phase: "core" | "finalize"): string {
  return `${CHANGE_SET_NAME_PREFIX}${installationId}-${phase}`;
}

/**
 * Core until aws_core is complete; finalize once core is checkpointed.
 */
export function determinePhase(state: SetupState): "core" | "finalize" {
  return state.stages.aws_core?.status === "complete" ? "finalize" : "core";
}

export function buildStackParameters(
  state: SetupState,
  phase: "core" | "finalize",
): readonly StackParameter[] {
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

export function fingerprintTemplateAndParameters(
  templateBody: string,
  parameters: readonly StackParameter[],
  meta: { stackName: string; phase: string },
): string {
  const canonical = JSON.stringify({
    stackName: meta.stackName,
    phase: meta.phase,
    template: templateBody,
    parameters: parameters.map((entry) => [entry.ParameterKey, entry.ParameterValue]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildApplyConfirmationPhrase(input: {
  accountId: string;
  region: string;
  stackName: string;
  phase: string;
}): string {
  return `${APPLY_PHRASE_PREFIX} ${input.accountId} ${input.region} ${input.stackName} ${input.phase}`;
}

export function validateApplyConfirmation(
  answer: string,
  expected: { accountId: string; region: string; stackName: string; phase: string },
): string {
  const phrase = buildApplyConfirmationPhrase(expected);
  const trimmed = String(answer ?? "").trim();
  if (trimmed !== phrase) {
    throw new Error(`Confirmation rejected. Type exactly: ${phrase}`);
  }
  return phrase;
}

export function isFabricatedPlaceholder(value: unknown): boolean {
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

export function assertHonestWebsiteUrl(website: string): string {
  const value = String(website ?? "").trim();
  if (!/^https:\/\//iu.test(value)) {
    throw new Error('Production-access brief field "website" must be an https:// URL.');
  }
  let parsed: URL;
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

export function validateProductionBrief(
  brief: Record<string, unknown>,
): Record<ProductionBriefField, string> {
  if (brief == null || typeof brief !== "object" || Array.isArray(brief)) {
    throw new Error("Production-access brief must be an object.");
  }
  const out = {} as Record<ProductionBriefField, string>;
  for (const field of PRODUCTION_BRIEF_FIELDS) {
    const raw = brief[field];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`Production-access brief field "${field}" must be a non-empty string.`);
    }
    const value = raw.trim();
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

export function isActiveStackStatus(status: string | null | undefined): boolean {
  if (status == null || status === "") return false;
  const value = String(status);
  return value === "REVIEW_IN_PROGRESS" || /_IN_PROGRESS$/u.test(value);
}

export function isHealthyTerminalStackStatus(status: string | null | undefined): boolean {
  if (status == null || status === "") return false;
  const value = String(status);
  return /_COMPLETE$/u.test(value) && !/ROLLBACK|FAILED/u.test(value);
}

export function parseChangeSetArn(arn: string): ParsedChangeSetArn {
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
    partition: match[1]!,
    region,
    accountId: match[3]!,
    changeSetName: match[4]!,
    changeSetUniqueId: match[5]!,
  };
}

export function buildUseCaseDescription(brief: Record<string, string>): string {
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

export function isIdentityReady(identity: unknown): boolean {
  if (identity == null || typeof identity !== "object") return false;
  const raw = identity as Record<string, unknown>;
  const verification = String(raw.VerificationStatus ?? raw.verificationStatus ?? "");
  const verifiedForSending = raw.VerifiedForSendingStatus ?? raw.verifiedForSending;
  return verification === "SUCCESS" && verifiedForSending === true;
}

export function isDkimReady(identity: unknown): boolean {
  if (identity == null || typeof identity !== "object") return false;
  const raw = identity as Record<string, unknown>;
  const dkim =
    raw.DkimAttributes && typeof raw.DkimAttributes === "object"
      ? (raw.DkimAttributes as Record<string, unknown>)
      : raw;
  const status = String(dkim.Status ?? dkim.dkimStatus ?? "");
  const enabled = dkim.SigningEnabled ?? dkim.dkimSigningEnabled;
  return status === "SUCCESS" && enabled === true;
}

export function summarizeProductionAccessStatus(account: unknown): ProductionAccessSummary {
  if (account == null || typeof account !== "object") {
    return {
      productionAccessEnabled: false,
      reviewStatus: "UNKNOWN",
      sendingEnabled: null,
    };
  }
  const raw = account as Record<string, unknown>;
  const details =
    raw.Details && typeof raw.Details === "object" ? (raw.Details as Record<string, unknown>) : {};
  const review =
    details.ReviewDetails && typeof details.ReviewDetails === "object"
      ? (details.ReviewDetails as Record<string, unknown>)
      : {};
  return {
    productionAccessEnabled: raw.ProductionAccessEnabled === true,
    reviewStatus: String(review.Status ?? "NONE"),
    sendingEnabled: raw.SendingEnabled === undefined ? null : raw.SendingEnabled === true,
  };
}

export function isNoChangeChangeSet(changeSet: unknown): boolean {
  if (changeSet == null || typeof changeSet !== "object") return false;
  const raw = changeSet as Record<string, unknown>;
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

export function summarizeChangeSet(changeSet: unknown): ChangeSetSummary {
  if (changeSet == null || typeof changeSet !== "object") {
    throw new Error("Change set description must be an object.");
  }
  const raw = changeSet as Record<string, unknown>;
  const changes = Array.isArray(raw.Changes) ? raw.Changes : [];
  const resources: ChangeSetResourceSummary[] = [];
  let replacements = 0;
  let iamChanges = 0;
  for (const entry of changes) {
    if (entry == null || typeof entry !== "object") continue;
    const change = entry as Record<string, unknown>;
    const resourceChange =
      change.ResourceChange && typeof change.ResourceChange === "object"
        ? (change.ResourceChange as Record<string, unknown>)
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

export function parseStackOutputs(outputs: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const list = Array.isArray(outputs)
    ? outputs
    : outputs &&
        typeof outputs === "object" &&
        Array.isArray((outputs as { Outputs?: unknown }).Outputs)
      ? (outputs as { Outputs: unknown[] }).Outputs
      : [];
  for (const entry of list) {
    if (entry == null || typeof entry !== "object") continue;
    const key = String((entry as { OutputKey?: unknown }).OutputKey ?? "");
    const value = (entry as { OutputValue?: unknown }).OutputValue;
    if (!key || value == null) continue;
    map[key] = String(value);
  }
  return map;
}

export function mapStackOutputsToEnv(
  outputs: Record<string, string>,
  state: SetupState,
): Record<string, string> {
  const patch: Record<string, string> = {};
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

export function summarizeFailedStackEvents(
  eventsPayload: unknown,
  limit = 15,
): readonly FailedStackEvent[] {
  const events = Array.isArray(eventsPayload)
    ? eventsPayload
    : eventsPayload &&
        typeof eventsPayload === "object" &&
        Array.isArray((eventsPayload as { StackEvents?: unknown }).StackEvents)
      ? (eventsPayload as { StackEvents: unknown[] }).StackEvents
      : [];
  const failed: FailedStackEvent[] = [];
  for (const event of events) {
    if (event == null || typeof event !== "object") continue;
    const status = String((event as { ResourceStatus?: unknown }).ResourceStatus ?? "");
    if (!/(FAILED|ROLLBACK)/u.test(status)) continue;
    failed.push({
      logicalId: String((event as { LogicalResourceId?: unknown }).LogicalResourceId ?? ""),
      status,
      reason: String((event as { ResourceStatusReason?: unknown }).ResourceStatusReason ?? ""),
      timestamp: String((event as { Timestamp?: unknown }).Timestamp ?? ""),
    });
    if (failed.length >= limit) break;
  }
  return failed;
}

export function summarizeIdentity(identityJson: unknown): IdentitySummary {
  if (identityJson == null || typeof identityJson !== "object") {
    throw new Error("SES identity payload must be an object.");
  }
  const raw = identityJson as Record<string, unknown>;
  const dkim =
    raw.DkimAttributes && typeof raw.DkimAttributes === "object"
      ? (raw.DkimAttributes as Record<string, unknown>)
      : {};
  return {
    verificationStatus: String(raw.VerificationStatus ?? ""),
    verifiedForSending: raw.VerifiedForSendingStatus === true,
    dkimStatus: String(dkim.Status ?? ""),
    dkimSigningEnabled: dkim.SigningEnabled === true,
  };
}

export function formatDkimRecords(
  outputs: Record<string, string>,
): readonly { name: string; value: string }[] {
  const records: { name: string; value: string }[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const name = outputs[`DkimRecordName${index}`];
    const value = outputs[`DkimRecordValue${index}`];
    if (name && value) records.push({ name, value });
  }
  return records;
}

/**
 * Build AWS CLI argv with explicit profile and region (no shell).
 */
export function awsArgv(state: SetupState, command: readonly string[]): readonly string[] {
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

export function isLocalFinalizationCheckpoint(plan: Record<string, unknown>): boolean {
  return plan.providerApplied === true || plan.applyCheckpoint === "local-finalization";
}

export function expectedStackIdFromPlan(
  plan: Record<string, unknown>,
  state: SetupState,
): string | null {
  const fromPlan = typeof plan.stackId === "string" && plan.stackId ? plan.stackId : "";
  if (fromPlan) return fromPlan;
  const owned =
    state.aws?.stack && typeof state.aws.stack === "object"
      ? (state.aws.stack as Record<string, unknown>).stackId
      : null;
  return typeof owned === "string" && owned ? owned : null;
}
