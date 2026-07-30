import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect } from "effect";

import {
  AWS_ACCOUNT_ID_PATTERN,
  INSTALLATION_ID_PATTERN,
  PROVISIONER_POLICY_FILE_NAME,
  SECRET_ENV_KEY_SET,
} from "../state/constants.ts";
import type { ProvisionerPolicyRecord } from "../state/schema.ts";

/** Sample tokens embedded in the reviewed canonical template. */
export const SAMPLE_PARTITION = "aws" as const;
export const SAMPLE_REGION = "us-east-1" as const;
export const SAMPLE_ACCOUNT_ID = "123456789012" as const;
export const SAMPLE_INSTALLATION_SLUG = "demo" as const;
export const SAMPLE_RESOURCE_PREFIX = "nusend-demo" as const;
export const SAMPLE_HOSTED_ZONE_ID = "Z1234567890ABC" as const;
export const ROUTE53_STATEMENT_SID = "OptionalRoute53DkimRecords" as const;

// aws, aws-us-gov, aws-cn, aws-iso-b, …
const PARTITION_PATTERN = /^aws(?:-[a-z0-9]+)*$/u;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/u;
const HOSTED_ZONE_PATTERN = /^Z[A-Z0-9]+$/u;

const SECRETISH_KEY = /(password|secret|token|access_key|private|credential)/iu;

export type ProvisioningPolicyErrorReason =
  | "template"
  | "context"
  | "validation"
  | "unresolved-token"
  | "forbidden";

export class ProvisioningPolicyError extends Data.TaggedError("ProvisioningPolicyError")<{
  readonly message: string;
  readonly reason: ProvisioningPolicyErrorReason;
  readonly cause?: unknown;
}> {}

export type IamPolicyStatement = {
  readonly Sid?: string;
  readonly Effect?: string;
  readonly Action?: string | readonly string[];
  readonly Resource?: string | readonly string[];
  readonly [key: string]: unknown;
};

export type IamPolicyDocument = {
  readonly Version?: string;
  readonly Statement?: readonly IamPolicyStatement[];
  readonly [key: string]: unknown;
};

export type ProvisioningPolicyContext = {
  /** AWS partition (aws, aws-us-gov, aws-cn, …). */
  readonly partition: string;
  /** Workload region for CloudFormation/SNS/SQS/alarms. */
  readonly region: string;
  /** 12-digit account id. */
  readonly accountId: string;
  /** Installation id slug (stack name uses this). */
  readonly installationId: string;
  /**
   * CloudFormation InstallationName; defaults to installationId.
   * Resource names are `nusend-<installationName>-…`.
   */
  readonly installationName?: string;
  /** Optional Route 53 hosted zone; omit/null removes the Route 53 statement. */
  readonly route53HostedZoneId?: string | null;
};

export type RenderedProvisioningPolicy = {
  readonly document: IamPolicyDocument;
  /** Exact UTF-8 body written to the artifact (pretty JSON + trailing newline). */
  readonly json: string;
  readonly fingerprintSha256: string;
  readonly fileName: typeof PROVISIONER_POLICY_FILE_NAME;
  readonly stackName: string;
  readonly resourcePrefix: string;
  readonly runtimeUserName: string;
  readonly context: {
    readonly partition: string;
    readonly region: string;
    readonly accountId: string;
    readonly installationId: string;
    readonly installationName: string;
    readonly route53HostedZoneId: string | null;
  };
};

const EXPECTED_SIDS_REQUIRED = [
  "InspectProvisioningCaller",
  "ValidateCloudFormationTemplates",
  "ManageNusendCloudFormationStackLifecycle",
  "ListCloudFormationStacks",
  "ManageSesStackResources",
  "ManageSnsStackResources",
  "ManageSqsStackResources",
  "ManageRuntimeIamUserAndAccessKeys",
  "ManageCloudWatchAlarms",
] as const;

/** Actions that must never appear in a rendered provisioner policy. */
export const FORBIDDEN_PROVISIONING_ACTIONS = [
  "ses:PutAccountSuppressionAttributes",
  "iam:AttachUserPolicy",
  "iam:DetachUserPolicy",
  "iam:AttachRolePolicy",
  "iam:DetachRolePolicy",
  "iam:AttachGroupPolicy",
  "iam:PutRolePolicy",
  "iam:PassRole",
  "iam:CreateLoginProfile",
  "iam:UpdateLoginProfile",
  "iam:DeleteLoginProfile",
  "iam:AddUserToGroup",
  "iam:RemoveUserFromGroup",
  "iam:CreatePolicy",
  "iam:CreatePolicyVersion",
  "iam:CreateGroup",
  "iam:CreateRole",
  "secretsmanager:CreateSecret",
  "secretsmanager:DeleteSecret",
  "secretsmanager:GetSecretValue",
  "secretsmanager:PutSecretValue",
  "ssm:DeleteParameter",
  "ssm:PutParameter",
  "ssm:GetParameter",
  "kms:ScheduleKeyDeletion",
  "kms:DeleteAlias",
  "kms:DisableKey",
  "kms:PutKeyPolicy",
] as const;

const STAR_RESOURCE_SIDS = new Set([
  "InspectProvisioningCaller",
  "ValidateCloudFormationTemplates",
  "ListCloudFormationStacks",
  "ManageSesStackResources",
]);

export function defaultProvisioningPolicyTemplatePath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../deploy/aws/policies/provisioning-policy.example.json",
  );
}

export function loadCanonicalProvisioningPolicyTemplate(
  path: string = defaultProvisioningPolicyTemplatePath(),
): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new ProvisioningPolicyError({
      message: `Failed to read provisioning policy template at ${path}.`,
      reason: "template",
      cause,
    });
  }
}

export function buildStackName(installationId: string): string {
  return `nusend-${installationId}`;
}

export function buildResourcePrefix(installationName: string): string {
  return `nusend-${installationName}`;
}

export function buildRuntimeUserName(installationName: string): string {
  return `${buildResourcePrefix(installationName)}-runtime`;
}

export function suggestedPermissionSetName(installationId: string): string {
  return `NusendProvisioner-${installationId}`;
}

export function fingerprintProvisioningPolicyJson(jsonBody: string): string {
  return createHash("sha256").update(jsonBody, "utf8").digest("hex");
}

/** Serialize a validated policy document the same way the artifact is written. */
export function serializeProvisioningPolicyJson(document: IamPolicyDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function fail(reason: ProvisioningPolicyErrorReason, message: string): never {
  throw new ProvisioningPolicyError({ message, reason });
}

function normalizeContext(input: ProvisioningPolicyContext): RenderedProvisioningPolicy["context"] {
  const partition = input.partition.trim();
  const region = input.region.trim();
  const accountId = input.accountId.trim();
  const installationId = input.installationId.trim();
  const installationName = (input.installationName ?? input.installationId).trim();
  const zoneRaw = input.route53HostedZoneId;
  const route53HostedZoneId =
    zoneRaw == null || String(zoneRaw).trim() === "" ? null : String(zoneRaw).trim();

  if (!PARTITION_PATTERN.test(partition)) {
    fail("context", `Invalid AWS partition "${partition}".`);
  }
  if (!REGION_PATTERN.test(region)) {
    fail("context", `Invalid AWS region "${region}".`);
  }
  if (!AWS_ACCOUNT_ID_PATTERN.test(accountId)) {
    fail("context", "AWS account id must be exactly 12 digits.");
  }
  if (!INSTALLATION_ID_PATTERN.test(installationId)) {
    fail("context", `Invalid installation id "${installationId}".`);
  }
  if (!INSTALLATION_ID_PATTERN.test(installationName)) {
    fail("context", `Invalid installation name "${installationName}".`);
  }
  if (route53HostedZoneId !== null && !HOSTED_ZONE_PATTERN.test(route53HostedZoneId)) {
    fail(
      "context",
      `Invalid Route 53 hosted zone id "${route53HostedZoneId}". Expected Z followed by alphanumerics.`,
    );
  }

  return {
    partition,
    region,
    accountId,
    installationId,
    installationName,
    route53HostedZoneId,
  };
}

function actionsOf(statement: IamPolicyStatement): string[] {
  if (typeof statement.Action === "string") return [statement.Action];
  if (Array.isArray(statement.Action)) {
    return statement.Action.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function resourcesOf(statement: IamPolicyStatement): string[] {
  if (typeof statement.Resource === "string") return [statement.Resource];
  if (Array.isArray(statement.Resource)) {
    return statement.Resource.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function parseTemplate(raw: string): IamPolicyDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ProvisioningPolicyError({
      message: "Provisioning policy template is not valid JSON.",
      reason: "template",
      cause,
    });
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("template", "Provisioning policy template must be a JSON object.");
  }
  const document = parsed as IamPolicyDocument;
  if (document.Version !== "2012-10-17") {
    fail("template", 'Provisioning policy template Version must be "2012-10-17".');
  }
  if (!Array.isArray(document.Statement) || document.Statement.length === 0) {
    fail("template", "Provisioning policy template must declare a non-empty Statement array.");
  }
  return document;
}

function substituteSampleString(value: string, ctx: RenderedProvisioningPolicy["context"]): string {
  const resourcePrefix = buildResourcePrefix(ctx.installationName);
  let out = value;
  // Partition first so later checks see the real prefix.
  out = out.replaceAll(`arn:${SAMPLE_PARTITION}:`, `arn:${ctx.partition}:`);
  out = out.replaceAll(SAMPLE_REGION, ctx.region);
  out = out.replaceAll(SAMPLE_ACCOUNT_ID, ctx.accountId);
  out = out.replaceAll(SAMPLE_RESOURCE_PREFIX, resourcePrefix);
  if (ctx.route53HostedZoneId !== null) {
    out = out.replaceAll(SAMPLE_HOSTED_ZONE_ID, ctx.route53HostedZoneId);
  }
  return out;
}

function deepSubstitute(value: unknown, ctx: RenderedProvisioningPolicy["context"]): unknown {
  if (typeof value === "string") return substituteSampleString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => deepSubstitute(item, ctx));
  if (value != null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepSubstitute(nested, ctx);
    }
    return out;
  }
  return value;
}

function expectedResourcesForSid(
  sid: string,
  ctx: RenderedProvisioningPolicy["context"],
): string[] | "*" | null {
  const p = ctx.partition;
  const r = ctx.region;
  const a = ctx.accountId;
  const stackName = buildStackName(ctx.installationId);
  const prefix = buildResourcePrefix(ctx.installationName);

  switch (sid) {
    case "InspectProvisioningCaller":
    case "ValidateCloudFormationTemplates":
    case "ListCloudFormationStacks":
    case "ManageSesStackResources":
      return "*";
    case "ManageNusendCloudFormationStackLifecycle":
      return [
        `arn:${p}:cloudformation:${r}:${a}:stack/${stackName}/*`,
        `arn:${p}:cloudformation:${r}:${a}:changeSet/*`,
      ];
    case "ManageSnsStackResources":
      return [
        `arn:${p}:sns:${r}:${a}:${prefix}-ses-events`,
        `arn:${p}:sns:${r}:${a}:${prefix}-ops-alarms`,
        `arn:${p}:sns:${r}:${a}:${prefix}-ses-events:*`,
        `arn:${p}:sns:${r}:${a}:${prefix}-ops-alarms:*`,
      ];
    case "ManageSqsStackResources":
      return [`arn:${p}:sqs:${r}:${a}:${prefix}-ses-webhook-dlq`];
    case "ManageRuntimeIamUserAndAccessKeys":
      return [`arn:${p}:iam::${a}:user/${prefix}-runtime`];
    case "ManageCloudWatchAlarms":
      return [
        `arn:${p}:cloudwatch:${r}:${a}:alarm:${prefix}-sns-notifications-failed`,
        `arn:${p}:cloudwatch:${r}:${a}:alarm:${prefix}-sns-redriven-to-dlq`,
        `arn:${p}:cloudwatch:${r}:${a}:alarm:${prefix}-sns-redrive-failed`,
        `arn:${p}:cloudwatch:${r}:${a}:alarm:${prefix}-dlq-visible-messages`,
      ];
    case ROUTE53_STATEMENT_SID:
      if (ctx.route53HostedZoneId === null) return null;
      return [`arn:${p}:route53:::hostedzone/${ctx.route53HostedZoneId}`];
    default:
      return null;
  }
}

function assertNoSecretShapedFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretShapedFields(item, `${path}[${index}]`));
    return;
  }
  if (value == null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_ENV_KEY_SET.has(key) || SECRETISH_KEY.test(key)) {
      fail("forbidden", `Rendered policy must not contain secret-shaped field "${path}.${key}".`);
    }
    assertNoSecretShapedFields(nested, path === "" ? key : `${path}.${key}`);
  }
}

function assertNoUnresolvedSamples(blob: string, ctx: RenderedProvisioningPolicy["context"]): void {
  // Only treat sample tokens as unresolved when they are not the operator's real values.
  if (ctx.partition !== SAMPLE_PARTITION && blob.includes(`arn:${SAMPLE_PARTITION}:`)) {
    fail(
      "unresolved-token",
      `Unresolved sample partition token "arn:${SAMPLE_PARTITION}:" remains.`,
    );
  }
  if (ctx.region !== SAMPLE_REGION && blob.includes(SAMPLE_REGION)) {
    fail("unresolved-token", `Unresolved sample region token "${SAMPLE_REGION}" remains.`);
  }
  if (ctx.accountId !== SAMPLE_ACCOUNT_ID && blob.includes(SAMPLE_ACCOUNT_ID)) {
    fail("unresolved-token", `Unresolved sample account token "${SAMPLE_ACCOUNT_ID}" remains.`);
  }
  if (
    buildResourcePrefix(ctx.installationName) !== SAMPLE_RESOURCE_PREFIX &&
    blob.includes(SAMPLE_RESOURCE_PREFIX)
  ) {
    fail(
      "unresolved-token",
      `Unresolved sample installation token "${SAMPLE_RESOURCE_PREFIX}" remains.`,
    );
  }
  if (ctx.route53HostedZoneId !== SAMPLE_HOSTED_ZONE_ID && blob.includes(SAMPLE_HOSTED_ZONE_ID)) {
    fail(
      "unresolved-token",
      `Unresolved sample hosted-zone token "${SAMPLE_HOSTED_ZONE_ID}" remains.`,
    );
  }
}

function assertValidArnOrStar(resource: string, sid: string): void {
  if (resource === "*") {
    if (!STAR_RESOURCE_SIDS.has(sid)) {
      fail(
        "forbidden",
        `Statement ${sid} must not use Resource "*" (over-broad for this reviewed boundary).`,
      );
    }
    return;
  }
  if (!resource.startsWith("arn:")) {
    fail("validation", `Statement ${sid} has invalid resource (not an ARN): ${resource}`);
  }
  // Reject account-wide or service-wide wildcards beyond reviewed suffixes.
  if (resource === "arn:*" || /arn:[^:]+:\*:\*:\*:?\*?$/u.test(resource)) {
    fail("forbidden", `Statement ${sid} resource is over-broad: ${resource}`);
  }
  if (resource.includes(":::*") && !resource.includes(":route53:::hostedzone/")) {
    fail(
      "forbidden",
      `Statement ${sid} resource uses unexpected triple-colon wildcard: ${resource}`,
    );
  }
}

function validateRenderedDocument(
  document: IamPolicyDocument,
  ctx: RenderedProvisioningPolicy["context"],
  templateActionsBySid: Map<string, ReadonlySet<string>>,
): void {
  assertNoSecretShapedFields(document, "policy");

  if (document.Version !== "2012-10-17") {
    fail("validation", 'Rendered policy Version must be "2012-10-17".');
  }
  const statements = document.Statement;
  if (!Array.isArray(statements) || statements.length === 0) {
    fail("validation", "Rendered policy must declare a non-empty Statement array.");
  }

  const sids = statements.map((statement) => statement.Sid);
  for (const required of EXPECTED_SIDS_REQUIRED) {
    if (!sids.includes(required)) {
      fail("validation", `Rendered policy missing required statement Sid "${required}".`);
    }
  }
  if (ctx.route53HostedZoneId === null && sids.includes(ROUTE53_STATEMENT_SID)) {
    fail("validation", "Route 53 statement must be omitted when no hosted zone is selected.");
  }
  if (ctx.route53HostedZoneId !== null && !sids.includes(ROUTE53_STATEMENT_SID)) {
    fail("validation", "Route 53 statement must be present when a hosted zone is selected.");
  }

  const allowedSids = new Set<string>([...EXPECTED_SIDS_REQUIRED, ROUTE53_STATEMENT_SID]);
  const seen = new Set<string>();

  for (const statement of statements) {
    const sid = statement.Sid;
    if (typeof sid !== "string" || sid.trim() === "") {
      fail("validation", "Every policy statement must have a Sid.");
    }
    if (!allowedSids.has(sid)) {
      fail("validation", `Unexpected policy statement Sid "${sid}".`);
    }
    if (seen.has(sid)) {
      fail("validation", `Duplicate policy statement Sid "${sid}".`);
    }
    seen.add(sid);

    if (statement.Effect !== "Allow") {
      fail("validation", `Statement ${sid} must use Effect "Allow".`);
    }

    const actions = actionsOf(statement);
    if (actions.length === 0) {
      fail("validation", `Statement ${sid} has no actions.`);
    }
    const templateActions = templateActionsBySid.get(sid);
    if (!templateActions) {
      fail("validation", `Statement ${sid} is not present in the canonical template.`);
    }
    for (const action of actions) {
      if (!templateActions.has(action)) {
        fail("forbidden", `Statement ${sid} contains unexpected action "${action}".`);
      }
      if ((FORBIDDEN_PROVISIONING_ACTIONS as readonly string[]).includes(action)) {
        fail("forbidden", `Statement ${sid} contains forbidden action "${action}".`);
      }
      if (action.endsWith(":*") || action === "*") {
        fail("forbidden", `Statement ${sid} contains over-broad action "${action}".`);
      }
      if (
        action.startsWith("secretsmanager:") ||
        action.startsWith("ssm:") ||
        action.startsWith("kms:")
      ) {
        fail("forbidden", `Statement ${sid} contains forbidden service action "${action}".`);
      }
    }

    const resources = resourcesOf(statement);
    if (resources.length === 0) {
      fail("validation", `Statement ${sid} has no resources.`);
    }
    const expected = expectedResourcesForSid(sid, ctx);
    if (expected === null) {
      fail("validation", `Statement ${sid} is not allowed for this context.`);
    }
    if (expected === "*") {
      if (resources.length !== 1 || resources[0] !== "*") {
        fail("validation", `Statement ${sid} must use Resource "*".`);
      }
    } else {
      if (resources.length !== expected.length) {
        fail(
          "validation",
          `Statement ${sid} resource count mismatch (got ${resources.length}, expected ${expected.length}).`,
        );
      }
      for (let i = 0; i < expected.length; i += 1) {
        if (resources[i] !== expected[i]) {
          fail(
            "validation",
            `Statement ${sid} resource[${i}] mismatch.\n  got: ${resources[i]}\n  expected: ${expected[i]}`,
          );
        }
      }
    }
    for (const resource of resources) {
      assertValidArnOrStar(resource, sid);
      if (resource !== "*" && !resource.startsWith(`arn:${ctx.partition}:`)) {
        fail("validation", `Statement ${sid} resource partition mismatch: ${resource}`);
      }
    }
  }

  // Stack ARN must use installationId-based stack name even if installationName differs.
  const stackStatement = statements.find(
    (statement) => statement.Sid === "ManageNusendCloudFormationStackLifecycle",
  );
  const stackResources = stackStatement ? resourcesOf(stackStatement) : [];
  const expectedStack = `arn:${ctx.partition}:cloudformation:${ctx.region}:${ctx.accountId}:stack/${buildStackName(ctx.installationId)}/*`;
  if (!stackResources.includes(expectedStack)) {
    fail("validation", `CloudFormation stack resource must be exactly ${expectedStack}.`);
  }

  const blob = JSON.stringify(document);
  assertNoUnresolvedSamples(blob, ctx);
}

/**
 * Pure renderer: substitute reviewed sample tokens, drop Route 53 when unused,
 * validate structure/actions/resources, and fingerprint the canonical JSON body.
 */
export function renderProvisioningPolicy(
  input: ProvisioningPolicyContext,
  templateRaw?: string,
): RenderedProvisioningPolicy {
  const ctx = normalizeContext(input);
  const raw = templateRaw ?? loadCanonicalProvisioningPolicyTemplate();
  const template = parseTemplate(raw);
  // Reject secret-shaped keys on the template before the allowlisted rebuild strips them.
  assertNoSecretShapedFields(template, "template");

  const templateActionsBySid = new Map<string, ReadonlySet<string>>();
  for (const statement of template.Statement ?? []) {
    if (typeof statement.Sid === "string") {
      templateActionsBySid.set(statement.Sid, new Set(actionsOf(statement)));
    }
  }

  const substituted = deepSubstitute(template, ctx) as IamPolicyDocument;
  let statements = [...(substituted.Statement ?? [])] as IamPolicyStatement[];

  if (ctx.route53HostedZoneId === null) {
    statements = statements.filter((statement) => statement.Sid !== ROUTE53_STATEMENT_SID);
  }

  // Stack name is always nusend-<installationId>; resource names use installationName.
  // Sample substitution uses installationName, so rewrite the stack ARN explicitly.
  const stackName = buildStackName(ctx.installationId);
  const stackArn = `arn:${ctx.partition}:cloudformation:${ctx.region}:${ctx.accountId}:stack/${stackName}/*`;
  const changeSetArn = `arn:${ctx.partition}:cloudformation:${ctx.region}:${ctx.accountId}:changeSet/*`;
  statements = statements.map((statement) => {
    if (statement.Sid !== "ManageNusendCloudFormationStackLifecycle") return statement;
    return {
      ...statement,
      Resource: [stackArn, changeSetArn],
    };
  });

  // Rebuild with only known top-level keys so unexpected template keys cannot sneak secrets.
  const document: IamPolicyDocument = {
    Version: "2012-10-17",
    Statement: statements.map((statement) => {
      const out: IamPolicyStatement = {
        Sid: statement.Sid,
        Effect: statement.Effect,
        Action: statement.Action,
        Resource: statement.Resource,
      };
      return out;
    }),
  };

  validateRenderedDocument(document, ctx, templateActionsBySid);

  const json = serializeProvisioningPolicyJson(document);
  // Round-trip importability.
  try {
    JSON.parse(json);
  } catch (cause) {
    throw new ProvisioningPolicyError({
      message: "Rendered policy is not importable JSON.",
      reason: "validation",
      cause,
    });
  }

  return {
    document,
    json,
    fingerprintSha256: fingerprintProvisioningPolicyJson(json),
    fileName: PROVISIONER_POLICY_FILE_NAME,
    stackName: buildStackName(ctx.installationId),
    resourcePrefix: buildResourcePrefix(ctx.installationName),
    runtimeUserName: buildRuntimeUserName(ctx.installationName),
    context: ctx,
  };
}

export function renderProvisioningPolicyEffect(
  input: ProvisioningPolicyContext,
  templateRaw?: string,
): Effect.Effect<RenderedProvisioningPolicy, ProvisioningPolicyError> {
  return Effect.try({
    try: () => renderProvisioningPolicy(input, templateRaw),
    catch: (error) =>
      error instanceof ProvisioningPolicyError
        ? error
        : new ProvisioningPolicyError({
            message: error instanceof Error ? error.message : String(error),
            reason: "validation",
            cause: error,
          }),
  });
}

export type { ProvisionerPolicyRecord };

export function buildProvisionerPolicyRecord(
  rendered: RenderedProvisioningPolicy,
  generatedAt: string,
  dedicatedTemporaryAssignment?: boolean,
): ProvisionerPolicyRecord {
  return {
    fileName: rendered.fileName,
    fingerprintSha256: rendered.fingerprintSha256,
    generatedAt,
    partition: rendered.context.partition,
    accountId: rendered.context.accountId,
    region: rendered.context.region,
    installationId: rendered.context.installationId,
    installationName: rendered.context.installationName,
    stackName: rendered.stackName,
    route53HostedZoneId: rendered.context.route53HostedZoneId,
    ...(dedicatedTemporaryAssignment === undefined ? {} : { dedicatedTemporaryAssignment }),
  };
}
