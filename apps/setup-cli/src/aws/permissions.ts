import { Clock, Data, Effect } from "effect";

import { isAccessDeniedText } from "../auth/sts.ts";
import { askBoolean, writeLine } from "../commands/prompts.ts";
import { CancellationError, SetupCommandError, SetupStoreError, TerminalError } from "../errors.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { PROVISIONER_POLICY_FILE_NAME } from "../state/constants.ts";
import { policyArtifactPath, type PathEnvironment } from "../state/paths.ts";
import type { AwsSsoAuth, SetupState, SetupStateV2 } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import {
  buildProvisionerPolicyRecord,
  buildStackName,
  ProvisioningPolicyError,
  renderProvisioningPolicyEffect,
  suggestedPermissionSetName,
  type ProvisionerPolicyRecord,
  type ProvisioningPolicyContext,
  type RenderedProvisioningPolicy,
} from "./provisioning-policy.ts";

/** Typed authorization denial for later AWS workflow (T5) handoff without consuming plans. */
export class AwsPermissionDeniedError extends Data.TaggedError("AwsPermissionDeniedError")<{
  readonly message: string;
  /** Safe high-level operation label (e.g. "cloudformation create-change-set"). */
  readonly operationHint: string | null;
  /** Safe IAM action hint extracted from AWS error text when identifiable. */
  readonly actionHint: string | null;
  readonly handoff: PermissionHandoffSummary;
}> {}

export type PermissionHandoffSummary = {
  readonly profileName: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly region: string;
  readonly partition: string;
  readonly installationId: string;
  readonly permissionSetName: string;
  readonly artifactPath: string;
  readonly artifactFileName: typeof PROVISIONER_POLICY_FILE_NAME;
  readonly fingerprintSha256: string;
  readonly dedicatedTemporaryAssignment: boolean | null;
  readonly operationHint: string | null;
  readonly actionHint: string | null;
};

export type PermissionHandoffInput = {
  readonly profileName: string;
  readonly accountId: string;
  readonly roleName: string;
  readonly region: string;
  readonly partition: string;
  readonly installationId: string;
  readonly artifactPath: string;
  readonly fingerprintSha256: string;
  readonly operationHint?: string | null;
  readonly actionHint?: string | null;
  readonly dedicatedTemporaryAssignment?: boolean | null;
  /** Only when independently known — otherwise placeholders are printed. */
  readonly instanceArn?: string | null;
  readonly permissionSetArn?: string | null;
};

const INSTANCE_ARN_PLACEHOLDER = "<IDENTITY_CENTER_INSTANCE_ARN>";
const PERMISSION_SET_ARN_PLACEHOLDER = "<PERMISSION_SET_ARN>";

/**
 * Extract a safe IAM action hint from AWS CLI error text.
 * Returns null when not confidently identifiable (never invents actions).
 */
export function extractActionHint(text: string): string | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const patterns = [
    /not authorized to perform:\s*([a-z0-9-]+:[A-Za-z0-9*]+)/iu,
    /is not authorized to perform:\s*([a-z0-9-]+:[A-Za-z0-9*]+)/iu,
    /User:\s*.*\s+is not authorized to perform:\s*([a-z0-9-]+:[A-Za-z0-9*]+)/iu,
    /Action\s+'([a-z0-9-]+:[A-Za-z0-9*]+)'/iu,
    /\b((?:sts|cloudformation|ses|sns|sqs|iam|cloudwatch|route53):[A-Za-z0-9]+)\b/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const action = match?.[1]?.trim();
    if (action && /^[a-z0-9-]+:[A-Za-z0-9*]+$/u.test(action)) {
      return action;
    }
  }
  return null;
}

export function isAwsAuthorizationDenialText(text: string): boolean {
  return isAccessDeniedText(text);
}

/**
 * Build structured handoff summary for AccessDenied / UnauthorizedOperation.
 * Does not mutate state — callers write the artifact separately when needed.
 */
export function buildPermissionHandoffSummary(
  input: PermissionHandoffInput,
): PermissionHandoffSummary {
  return {
    profileName: input.profileName,
    accountId: input.accountId,
    roleName: input.roleName,
    region: input.region,
    partition: input.partition,
    installationId: input.installationId,
    permissionSetName: suggestedPermissionSetName(input.installationId),
    artifactPath: input.artifactPath,
    artifactFileName: PROVISIONER_POLICY_FILE_NAME,
    fingerprintSha256: input.fingerprintSha256,
    dedicatedTemporaryAssignment: input.dedicatedTemporaryAssignment ?? null,
    operationHint: input.operationHint ?? null,
    actionHint: input.actionHint ?? null,
  };
}

/**
 * Human-readable administrator handoff. Never claims complete preflight.
 * Explicitly prohibits editing AWSReservedSSO_* roles and wizard self-elevation.
 */
export function formatPermissionHandoff(input: PermissionHandoffInput): string {
  const permissionSetName = suggestedPermissionSetName(input.installationId);
  const instanceArn = input.instanceArn?.trim() || INSTANCE_ARN_PLACEHOLDER;
  const permissionSetArn = input.permissionSetArn?.trim() || PERMISSION_SET_ARN_PLACEHOLDER;
  const usingPlaceholders =
    instanceArn === INSTANCE_ARN_PLACEHOLDER || permissionSetArn === PERMISSION_SET_ARN_PLACEHOLDER;

  const lines: string[] = [
    "=== Nusend setup provisioner permission handoff ===",
    "",
    "Authenticated context:",
    `  profile:   ${input.profileName}`,
    `  account:   ${input.accountId}`,
    `  role:      ${input.roleName}`,
    `  region:    ${input.region} (workload)`,
    `  partition: ${input.partition}`,
    "",
  ];

  if (input.operationHint) {
    lines.push(`Denied or requested operation: ${input.operationHint}`);
  }
  if (input.actionHint) {
    lines.push(`Action hint (from AWS error, not a complete grant list): ${input.actionHint}`);
  }
  if (input.operationHint || input.actionHint) {
    lines.push("");
  }

  lines.push(
    "Honesty limits:",
    "  AWS has no universally available complete preflight for every write the coordinator performs.",
    "  Read/list probes are only partial evidence.",
    "  Write permissions are not fully verifiable before AWS evaluates the operation.",
    "  Do not rely on IAM policy simulation here; the first AWS denial remains authoritative.",
    "  Prior state and change-set checkpoints are preserved for resume after assignment update.",
    "",
    "Recommended approach:",
    "  Create a dedicated custom IAM Identity Center permission set named:",
    `    ${permissionSetName}`,
    "  Assign it only to the intended user or group for this installation.",
    "  Do NOT edit AWSReservedSSO_* managed roles directly — those names are AWS-reserved.",
    "  Assignment is administrator-controlled in Identity Center, not SSO/OAuth consent,",
    "  and not something this wizard can grant or elevate for itself.",
    "",
    "Importable policy artifact (identity policy for the setup tool, not the runtime user):",
    `  path:        ${input.artifactPath}`,
    `  fingerprint: sha256:${input.fingerprintSha256}`,
    "",
    "Identity Center console steps (administrator):",
    "  1. Open IAM Identity Center → Permission sets.",
    `  2. Create (or open) custom permission set "${permissionSetName}".`,
    "  3. Attach an inline policy using the artifact JSON (or paste its contents).",
    "  4. Assign that permission set to the intended user/group on this AWS account.",
    "  5. Ask the operator to reauthenticate (`pnpm nusend:setup aws auth`) so the new",
    "     assignment is reflected, then resume the same reviewed plan/stage.",
    "",
    "CLI example (administrator; does not run from Nusend):",
    usingPlaceholders
      ? "  # Replace the clearly marked placeholders with values from your Identity Center console."
      : "  # Instance and permission-set ARNs were supplied independently of Nusend.",
    "  aws sso-admin put-inline-policy-to-permission-set \\",
    `    --instance-arn ${instanceArn} \\`,
    `    --permission-set-arn ${permissionSetArn} \\`,
    `    --inline-policy file://${input.artifactPath}`,
    "",
    "Nusend never creates, updates, deletes, or logs out Identity Center permission sets",
    "or account assignments automatically.",
    "====================================================",
  );

  return lines.join("\n");
}

/**
 * Cleanup / removal guidance after final AWS mutation or before destroy reassignment.
 * Non-provider: operator attestation only; never deletes assignments.
 */
export function formatProvisionerCleanupGuidance(options: {
  readonly dedicatedTemporaryAssignment: boolean | null;
  readonly installationId: string;
  readonly permissionSetName?: string;
}): string {
  const name = options.permissionSetName ?? suggestedPermissionSetName(options.installationId);
  const lines: string[] = ["=== Provisioner access cleanup guidance ===", ""];

  if (options.dedicatedTemporaryAssignment === true) {
    lines.push(
      `You reported a dedicated temporary assignment for "${name}".`,
      "After setup validation (or after destroy completes), an administrator should:",
      "  1. Remove the account assignment for that permission set from the operator user/group, or",
      "  2. Delete the custom permission set if it is no longer needed for any account.",
      "Nusend does not call sso-admin to mutate or delete assignments, and never invokes global SSO logout.",
      "Confirm removal out-of-band; the wizard only records your attestation.",
    );
  } else if (options.dedicatedTemporaryAssignment === false) {
    lines.push(
      "You reported using a pre-existing user-managed role/permission set (not a dedicated temporary assignment).",
      "Nusend owns nothing to remove in Identity Center for this installation.",
      "If that role should be narrowed later, an administrator must do so outside this wizard.",
      "Nusend will not delete permission sets, assignments, or SSO sessions.",
    );
  } else {
    lines.push(
      "Dedicated vs pre-existing assignment was not recorded.",
      `If you created "${name}" only for this install, remove its account assignment when finished.`,
      "If you used a long-lived shared role, Nusend owns nothing to remove.",
      "Nusend never deletes Identity Center permission sets or assignments automatically.",
    );
  }

  lines.push(
    "",
    "For later AWS updates or destroy, regenerate the same fingerprinted policy",
    "(`pnpm nusend:setup aws permissions`) and temporarily reassign if needed,",
    "then remove the temporary assignment again after the mutation.",
    "==========================================",
  );
  return lines.join("\n");
}

/** Prompt copy for non-provider attestation that dedicated assignment was removed. */
export function formatDedicatedAssignmentAttestationPrompt(): string {
  return [
    "Attest that the dedicated temporary Identity Center assignment was removed",
    "(or was never created / not applicable). Nusend cannot verify this with AWS.",
    "Type yes only if an administrator removed the assignment or it does not apply.",
  ].join(" ");
}

export function contextFromSetupState(state: SetupState): ProvisioningPolicyContext {
  const partition =
    state.schemaVersion === 2 ? state.awsAuth.partition : inferPartitionFromConfig(state);
  const installationName = state.config.installationName ?? state.installationId;
  return {
    partition,
    region: state.config.awsRegion,
    accountId: state.config.awsAccountId,
    installationId: state.installationId,
    installationName,
    route53HostedZoneId: state.config.route53HostedZoneId,
  };
}

function inferPartitionFromConfig(state: SetupState): string {
  if (state.config.awsRegion.startsWith("us-gov-")) return "aws-us-gov";
  if (state.config.awsRegion.startsWith("cn-")) return "aws-cn";
  return "aws";
}

export function authFieldsFromState(state: SetupState): {
  profileName: string;
  accountId: string;
  roleName: string;
  region: string;
  partition: string;
} {
  if (state.schemaVersion === 2) {
    const auth: AwsSsoAuth = state.awsAuth;
    return {
      profileName: auth.profileName,
      accountId: auth.accountId,
      roleName: auth.roleName,
      region: state.config.awsRegion,
      partition: auth.partition,
    };
  }
  return {
    profileName: state.config.awsProfile,
    accountId: state.config.awsAccountId,
    roleName: "(unknown — bind SSO with aws auth)",
    region: state.config.awsRegion,
    partition: inferPartitionFromConfig(state),
  };
}

export type WritePolicyAndHandoffResult = {
  readonly rendered: RenderedProvisioningPolicy;
  readonly record: ProvisionerPolicyRecord;
  readonly state: SetupState;
  readonly artifactPath: string;
  readonly handoffText: string;
  readonly summary: PermissionHandoffSummary;
};

/**
 * Render policy, write mode-0600 artifact, record non-secret metadata in state.
 * Does not touch plans/change-set checkpoints.
 */
export function writePolicyArtifactAndRecord(
  state: SetupState,
  options: {
    readonly env?: PathEnvironment;
    readonly dedicatedTemporaryAssignment?: boolean;
    readonly operationHint?: string | null;
    readonly actionHint?: string | null;
    readonly templateRaw?: string;
    readonly instanceArn?: string | null;
    readonly permissionSetArn?: string | null;
  } = {},
): Effect.Effect<
  WritePolicyAndHandoffResult,
  ProvisioningPolicyError | SetupStoreError,
  SetupStoreService
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const env = options.env ?? process.env;
    const rendered = yield* renderProvisioningPolicyEffect(
      contextFromSetupState(state),
      options.templateRaw,
    );
    yield* store.writePolicyArtifact(state.installationId, rendered.json, env);

    const nowMillis = yield* Clock.currentTimeMillis;
    const generatedAt = new Date(nowMillis).toISOString();
    const previousDedicated = state.provisionerPolicy?.dedicatedTemporaryAssignment;
    const dedicated = options.dedicatedTemporaryAssignment ?? previousDedicated;
    const record = buildProvisionerPolicyRecord(rendered, generatedAt, dedicated);

    // Preserve plans/stages/aws checkpoints; only attach non-secret policy metadata.
    const nextState: SetupState =
      state.schemaVersion === 2
        ? {
            ...state,
            updatedAt: generatedAt,
            provisionerPolicy: record,
            plans: state.plans,
            stages: state.stages,
          }
        : {
            ...state,
            updatedAt: generatedAt,
            provisionerPolicy: record,
            plans: state.plans,
            stages: state.stages,
          };

    const written = yield* store.writeState(nextState, env);
    const artifactPath = policyArtifactPath(state.installationId, env);
    const auth = authFieldsFromState(written);
    const handoffInput: PermissionHandoffInput = {
      profileName: auth.profileName,
      accountId: auth.accountId,
      roleName: auth.roleName,
      region: auth.region,
      partition: auth.partition,
      installationId: state.installationId,
      artifactPath,
      fingerprintSha256: rendered.fingerprintSha256,
      operationHint: options.operationHint ?? null,
      actionHint: options.actionHint ?? null,
      dedicatedTemporaryAssignment: record.dedicatedTemporaryAssignment ?? null,
      instanceArn: options.instanceArn ?? null,
      permissionSetArn: options.permissionSetArn ?? null,
    };
    const summary = buildPermissionHandoffSummary(handoffInput);
    return {
      rendered,
      record,
      state: written,
      artifactPath,
      handoffText: formatPermissionHandoff(handoffInput),
      summary,
    };
  });
}

/**
 * Map AccessDenied/UnauthorizedOperation into a typed handoff for T5.
 * Writes/updates the policy artifact, preserves plans, does not consume change sets.
 */
export function mapAccessDeniedToHandoff(
  state: SetupState,
  options: {
    readonly env?: PathEnvironment;
    readonly operationHint?: string | null;
    readonly errorText?: string | null;
    readonly templateRaw?: string;
  },
): Effect.Effect<
  AwsPermissionDeniedError,
  ProvisioningPolicyError | SetupStoreError,
  SetupStoreService
> {
  return Effect.gen(function* () {
    const actionHint = extractActionHint(options.errorText ?? "");
    const result = yield* writePolicyArtifactAndRecord(state, {
      env: options.env,
      operationHint: options.operationHint ?? null,
      actionHint,
      templateRaw: options.templateRaw,
    });
    const message = [
      "AWS authorization denied for the setup provisioner role.",
      options.operationHint ? `Operation: ${options.operationHint}.` : null,
      actionHint ? `Action hint: ${actionHint}.` : null,
      `Importable policy written to ${result.artifactPath} (sha256:${result.rendered.fingerprintSha256}).`,
      "Administrator must assign the policy; then reauthenticate and resume. Plans were not consumed.",
    ]
      .filter(Boolean)
      .join(" ");

    return new AwsPermissionDeniedError({
      message,
      operationHint: options.operationHint ?? null,
      actionHint,
      handoff: result.summary,
    });
  });
}

/**
 * Recovery command: `aws permissions`.
 * Renders artifact, records metadata, prints handoff + cleanup guidance.
 */
export function runAwsPermissionsCommand(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  WritePolicyAndHandoffResult,
  SetupCommandError | SetupStoreError | ProvisioningPolicyError | CancellationError | TerminalError,
  SetupStoreService | TerminalService
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);

    if (state.schemaVersion !== 2) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "aws permissions requires schema v2 with SSO binding. Run `pnpm nusend:setup aws auth` first.",
        }),
      );
    }

    yield* writeLine(
      `Rendering setup-provisioner policy for installation "${installationId}" (stack ${buildStackName(installationId)}).`,
    );

    const dedicated = yield* askBoolean(
      "Will an administrator use a dedicated temporary Identity Center permission set for this install?",
      true,
    );

    const result = yield* writePolicyArtifactAndRecord(state as SetupStateV2, {
      env,
      dedicatedTemporaryAssignment: dedicated,
    });

    yield* writeLine(result.handoffText);
    yield* writeLine("");
    yield* writeLine(
      formatProvisionerCleanupGuidance({
        dedicatedTemporaryAssignment: dedicated,
        installationId,
      }),
    );
    yield* writeLine("");
    yield* writeLine(
      "Recorded artifact metadata only (filename, AWS/install context, fingerprint, timestamp). Plans unchanged.",
    );

    return result;
  });
}
