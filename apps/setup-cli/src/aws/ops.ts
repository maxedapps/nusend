import { readFile } from "node:fs/promises";

import { Cause, Effect, Option } from "effect";

import { AwsCli, type AwsCliService, type ResolvedCallerContext } from "../auth/aws-cli.ts";
import { revalidateStoredAuth } from "../auth/wizard.ts";
import {
  AwsAuthError,
  CancellationError,
  SetupCommandError,
  SetupStoreError,
  TerminalError,
} from "../errors.ts";
import type { ProcessResult } from "../process-runner.ts";
import type { SetupStoreService } from "../services/setup-store.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import { writeLine } from "../commands/prompts.ts";
import { defaultStackTemplatePath } from "./constants.ts";
import { AwsCommandError } from "./errors.ts";
import {
  formatPermissionHandoff,
  mapAccessDeniedToHandoff,
  AwsPermissionDeniedError,
  type PermissionHandoffInput,
} from "./permissions.ts";
import { ProvisioningPolicyError } from "./provisioning-policy.ts";
import {
  decodeAwsJson,
  ChangeSetDescriptionSchema,
  CreateChangeSetResultSchema,
  DescribeStacksResultSchema,
  IamCreateAccessKeySchema,
  IamListAccessKeysSchema,
  SesAccountSchema,
  SesEmailIdentitySchema,
  StackEventsResultSchema,
} from "./schemas.ts";
import {
  buildChangeSetName,
  isActiveStackStatus,
  parseChangeSetArn,
  summarizeFailedStackEvents,
  type ChangeSetSummary,
} from "./pure.ts";
import type { AwsCommandRunner } from "./subscription.ts";

export type WorkflowCaller = {
  readonly accountId: string;
  readonly arn: string;
  readonly partition: string;
  readonly region: string;
};

export type StackDescribe = {
  readonly exists: boolean;
  readonly stackId: string | null;
  readonly status: string | null;
  readonly raw: Record<string, unknown> | null;
};

export type AwsWorkflowError =
  | SetupCommandError
  | SetupStoreError
  | AwsCommandError
  | AwsAuthError
  | AwsPermissionDeniedError
  | ProvisioningPolicyError
  | CancellationError
  | TerminalError;

export type AwsWorkflowServices = SetupStoreService | AwsCliService | TerminalService;

export function makeStateRunner(
  state: SetupState,
): Effect.Effect<AwsCommandRunner, never, AwsCliService> {
  return Effect.gen(function* () {
    const aws = yield* AwsCli;
    const profile = state.config.awsProfile;
    const region = state.config.awsRegion;
    return (command, options) =>
      aws
        .runProfileCommand(profile, region, command, {
          allowNonZero: options?.allowNonZero,
        })
        .pipe(
          Effect.mapError((error): AwsCommandError => {
            if (error instanceof CancellationError) {
              return new AwsCommandError({
                message: error.message,
                reason: "cancelled",
                operation: command.join(" "),
                cause: error,
              });
            }
            return error;
          }),
        );
  });
}

export function loadStackTemplate(
  path: string = defaultStackTemplatePath(),
): Effect.Effect<{ readonly body: string; readonly path: string }, SetupCommandError> {
  return Effect.tryPromise({
    try: async () => {
      const body = await readFile(path, "utf8");
      JSON.parse(body);
      return { body, path };
    },
    catch: (cause) =>
      new SetupCommandError({
        message:
          cause instanceof Error
            ? `Failed to load CloudFormation template: ${cause.message}`
            : "Failed to load CloudFormation template.",
      }),
  });
}

/**
 * Enforce modern SSO binding before any AWS provider mutation/read path.
 * Requires schema v2 awsAuth, modern SSO profile provenance, exact account/role/partition
 * match, and one interactive sso login on recognized expiry only.
 */
export function resolveCallerContext(
  state: SetupState,
  env: PathEnvironment = process.env,
): Effect.Effect<WorkflowCaller, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    if (state.schemaVersion !== 2) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "Installation has no SSO binding (schema v1). Run `pnpm nusend:setup aws auth` before AWS operations.",
        }),
      );
    }

    if (state.config.awsProfile !== state.awsAuth.profileName) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Config awsProfile "${state.config.awsProfile}" does not match bound SSO profile "${state.awsAuth.profileName}". Re-run aws auth.`,
        }),
      );
    }
    if (state.config.awsAccountId !== state.awsAuth.verifiedAccountId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Config awsAccountId ${state.config.awsAccountId} does not match bound SSO account ${state.awsAuth.verifiedAccountId}. Re-run aws auth.`,
        }),
      );
    }

    const authExit = yield* Effect.exit(revalidateStoredAuth(state, { promptForLogin: true }));
    if (authExit._tag === "Failure") {
      const typed = Cause.findErrorOption(authExit.cause);
      if (Option.isSome(typed)) {
        const error = typed.value;
        if (error instanceof AwsAuthError && error.reason === "access-denied") {
          return yield* mapAccessDeniedToHandoff(state, {
            env,
            operationHint: "sts get-caller-identity",
            errorText: error.message,
          }).pipe(Effect.flatMap((denied) => Effect.fail(denied)));
        }
        if (error instanceof AwsAuthError) {
          return yield* Effect.fail(new SetupCommandError({ message: error.message }));
        }
        if (error instanceof CancellationError || error instanceof TerminalError) {
          return yield* Effect.fail(error);
        }
      }
      return yield* Effect.fail(
        new SetupCommandError({
          message: "SSO authentication failed before AWS provider use.",
        }),
      );
    }
    const caller = authExit.value;

    if (caller.accountId !== state.config.awsAccountId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS account mismatch: expected ${state.config.awsAccountId}, caller is ${caller.accountId}. Refusing to plan or apply.`,
        }),
      );
    }
    if (caller.partition !== state.awsAuth.partition) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `AWS partition mismatch: expected ${state.awsAuth.partition}, caller is ${caller.partition}.`,
        }),
      );
    }

    return {
      accountId: caller.accountId,
      arn: caller.arn,
      partition: caller.partition,
      region: state.config.awsRegion,
    };
  });
}

export function describeStack(
  state: SetupState,
  stackName: string,
  env: PathEnvironment = process.env,
): Effect.Effect<StackDescribe, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const result = yield* run(
      ["cloudformation", "describe-stacks", "--stack-name", stackName, "--output", "json"],
      { allowNonZero: true },
    ).pipe(
      Effect.catch((error) =>
        liftProviderError(state, env, "cloudformation describe-stacks", error),
      ),
    );

    if (result.exitCode !== 0) {
      const text = `${result.stdout}\n${result.stderr}`;
      if (/does not exist/iu.test(text)) {
        return { exists: false, stackId: null, status: null, raw: null };
      }
      return yield* Effect.fail(
        new SetupCommandError({
          message: `cloudformation describe-stacks failed:\n${text}`,
        }),
      );
    }
    const payload = yield* decodeAwsJson(
      DescribeStacksResultSchema,
      result.stdout,
      "cloudformation describe-stacks",
    ).pipe(Effect.mapError((error) => toSetupCommand(error)));
    const stack = Array.isArray(payload.Stacks) ? payload.Stacks[0] : null;
    if (stack == null || typeof stack !== "object") {
      return { exists: false, stackId: null, status: null, raw: null };
    }
    const record = stack as Record<string, unknown>;
    return {
      exists: true,
      stackId: String(record.StackId ?? "") || null,
      status: String(record.StackStatus ?? "") || null,
      raw: record,
    };
  });
}

export function assertExistingCoreStackProvenance(
  state: SetupState,
  existing: { stackId: string | null },
  caller: WorkflowCaller,
  stackName: string,
): Effect.Effect<void, SetupCommandError> {
  return Effect.gen(function* () {
    const proof = state.aws?.stackCreation;
    const fail = () =>
      new SetupCommandError({
        message: `Stack name collision: ${stackName} already exists without exact coordinator core CREATE provenance for this stack id/account/partition/region. Refusing to adopt, plan changes, or mutate it.`,
      });
    if (!existing.stackId || proof == null || typeof proof !== "object" || Array.isArray(proof)) {
      return yield* Effect.fail(fail());
    }
    const record = proof as Record<string, unknown>;
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
      if (record[key] !== value) return yield* Effect.fail(fail());
    }
    if (
      typeof record.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.fingerprint) ||
      typeof record.appliedAt !== "string" ||
      !record.appliedAt
    ) {
      return yield* Effect.fail(fail());
    }
    try {
      const changeSet = parseChangeSetArn(String(record.changeSetArn ?? ""));
      if (
        changeSet.accountId !== caller.accountId ||
        changeSet.partition !== caller.partition ||
        changeSet.region !== caller.region ||
        changeSet.changeSetName !== buildChangeSetName(state.installationId, "core")
      ) {
        return yield* Effect.fail(fail());
      }
    } catch {
      return yield* Effect.fail(fail());
    }
  });
}

export function deleteAbandonedChangeSet(
  state: SetupState,
  stackName: string,
  changeSetName: string,
  previousPlan: Record<string, unknown> | undefined,
  env: PathEnvironment = process.env,
): Effect.Effect<void, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const targets = new Set<string>();
    if (
      previousPlan &&
      typeof previousPlan.changeSetArn === "string" &&
      previousPlan.changeSetArn
    ) {
      targets.add(previousPlan.changeSetArn);
    }
    targets.add(changeSetName);
    yield* Effect.forEach(
      [...targets],
      (target) =>
        run(
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
        ).pipe(
          Effect.catch((error) =>
            liftProviderError(state, env, "cloudformation delete-change-set", error),
          ),
          Effect.asVoid,
        ),
      { concurrency: "unbounded" },
    );
  });
}

export function describeChangeSet(
  state: SetupState,
  changeSetArn: string,
  env: PathEnvironment = process.env,
): Effect.Effect<Record<string, unknown>, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const described = yield* run([
      "cloudformation",
      "describe-change-set",
      "--change-set-name",
      changeSetArn,
      "--output",
      "json",
    ]).pipe(
      Effect.catch((error) =>
        liftProviderError(state, env, "cloudformation describe-change-set", error),
      ),
    );
    const payload = yield* decodeAwsJson(
      ChangeSetDescriptionSchema,
      described.stdout,
      "cloudformation describe-change-set",
    ).pipe(Effect.mapError((error) => toSetupCommand(error)));
    return payload as Record<string, unknown>;
  });
}

export function waitForChangeSet(
  state: SetupState,
  changeSetArn: string,
  env: PathEnvironment = process.env,
): Effect.Effect<Record<string, unknown>, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    yield* run(
      ["cloudformation", "wait", "change-set-create-complete", "--change-set-name", changeSetArn],
      { allowNonZero: true },
    ).pipe(
      Effect.catch((error) =>
        liftProviderError(state, env, "cloudformation wait change-set-create-complete", error),
      ),
    );
    return yield* describeChangeSet(state, changeSetArn, env);
  });
}

export function createChangeSet(
  state: SetupState,
  args: readonly string[],
  env: PathEnvironment = process.env,
): Effect.Effect<{ changeSetArn: string; raw: unknown }, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const created = yield* run(args).pipe(
      Effect.catch((error) =>
        liftProviderError(state, env, "cloudformation create-change-set", error),
      ),
    );
    const payload = yield* decodeAwsJson(
      CreateChangeSetResultSchema,
      created.stdout,
      "cloudformation create-change-set",
    ).pipe(Effect.mapError((error) => toSetupCommand(error)));
    const changeSetArn = String(payload.Id ?? payload.ChangeSetId ?? "");
    if (!changeSetArn) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "create-change-set did not return a change set ARN.",
        }),
      );
    }
    return { changeSetArn, raw: payload };
  });
}

export function collectStackFailureDiagnostics(
  state: SetupState,
  stackName: string,
  _env: PathEnvironment = process.env,
): Effect.Effect<string, never, AwsCliService> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const eventsResult = yield* run(
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
    ).pipe(
      Effect.catch(() =>
        Effect.succeed({
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "failed",
          argv: [],
        } satisfies ProcessResult),
      ),
    );
    if (eventsResult.exitCode !== 0) {
      return `Could not load stack events: ${eventsResult.stderr || eventsResult.stdout}`;
    }
    const payload = yield* decodeAwsJson(
      StackEventsResultSchema,
      eventsResult.stdout,
      "cloudformation describe-stack-events",
    ).pipe(Effect.catch(() => Effect.succeed({ StackEvents: [] })));
    const failed = summarizeFailedStackEvents(payload, 15);
    if (failed.length === 0) {
      return "No FAILED/ROLLBACK stack events were returned. Inspect the stack in CloudFormation.";
    }
    return failed
      .map(
        (event) =>
          `- ${event.logicalId}: ${event.status}${event.reason ? ` (${event.reason})` : ""}`,
      )
      .join("\n");
  });
}

export function getEmailIdentity(
  state: SetupState,
  env: PathEnvironment = process.env,
): Effect.Effect<unknown, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const result = yield* run([
      "sesv2",
      "get-email-identity",
      "--email-identity",
      state.config.sesIdentity,
      "--output",
      "json",
    ]).pipe(
      Effect.catch((error) => liftProviderError(state, env, "sesv2 get-email-identity", error)),
    );
    return yield* decodeAwsJson(
      SesEmailIdentitySchema,
      result.stdout,
      "sesv2 get-email-identity",
    ).pipe(Effect.mapError((error) => toSetupCommand(error)));
  });
}

export function getSesAccount(
  state: SetupState,
  env: PathEnvironment = process.env,
): Effect.Effect<unknown, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const result = yield* run(["sesv2", "get-account", "--output", "json"]).pipe(
      Effect.catch((error) => liftProviderError(state, env, "sesv2 get-account", error)),
    );
    return yield* decodeAwsJson(SesAccountSchema, result.stdout, "sesv2 get-account").pipe(
      Effect.mapError((error) => toSetupCommand(error)),
    );
  });
}

export function listAccessKeys(
  state: SetupState,
  userName: string,
  env: PathEnvironment = process.env,
): Effect.Effect<readonly unknown[], AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const listed = yield* run([
      "iam",
      "list-access-keys",
      "--user-name",
      userName,
      "--output",
      "json",
    ]).pipe(Effect.catch((error) => liftProviderError(state, env, "iam list-access-keys", error)));
    const payload = yield* decodeAwsJson(
      IamListAccessKeysSchema,
      listed.stdout,
      "iam list-access-keys",
    ).pipe(Effect.mapError((error) => toSetupCommand(error)));
    return Array.isArray(payload.AccessKeyMetadata) ? payload.AccessKeyMetadata : [];
  });
}

export function createAccessKey(
  state: SetupState,
  userName: string,
  env: PathEnvironment = process.env,
): Effect.Effect<
  { accessKeyId: string; secretAccessKey: string },
  AwsWorkflowError,
  AwsWorkflowServices
> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const created = yield* run([
      "iam",
      "create-access-key",
      "--user-name",
      userName,
      "--output",
      "json",
    ]).pipe(Effect.catch((error) => liftProviderError(state, env, "iam create-access-key", error)));
    // Decode then drop secret from any further diagnostics.
    const payload = yield* decodeAwsJson(
      IamCreateAccessKeySchema,
      created.stdout,
      "iam create-access-key",
    ).pipe(Effect.mapError((error) => toSetupCommand(error)));
    const accessKey = payload.AccessKey ?? payload;
    const accessKeyId = String((accessKey as { AccessKeyId?: unknown }).AccessKeyId ?? "");
    const secretAccessKey = String(
      (accessKey as { SecretAccessKey?: unknown }).SecretAccessKey ?? "",
    );
    if (!accessKeyId || !secretAccessKey) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "create-access-key did not return AccessKeyId/SecretAccessKey.",
        }),
      );
    }
    return { accessKeyId, secretAccessKey };
  });
}

export function putAccountDetails(
  state: SetupState,
  args: readonly string[],
  env: PathEnvironment = process.env,
): Effect.Effect<void, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    yield* run(args).pipe(
      Effect.catch((error) => liftProviderError(state, env, "sesv2 put-account-details", error)),
    );
  });
}

export function validateTemplate(
  state: SetupState,
  templatePath: string,
  env: PathEnvironment = process.env,
): Effect.Effect<void, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    yield* run([
      "cloudformation",
      "validate-template",
      "--template-body",
      `file://${templatePath}`,
      "--output",
      "json",
    ]).pipe(
      Effect.catch((error) =>
        liftProviderError(state, env, "cloudformation validate-template", error),
      ),
    );
  });
}

export function executeChangeSet(
  state: SetupState,
  changeSetArn: string,
  env: PathEnvironment = process.env,
): Effect.Effect<ProcessResult, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    return yield* run(
      [
        "cloudformation",
        "execute-change-set",
        "--change-set-name",
        changeSetArn,
        "--output",
        "json",
      ],
      { allowNonZero: true },
    ).pipe(
      Effect.catch((error) =>
        liftProviderError(state, env, "cloudformation execute-change-set", error),
      ),
    );
  });
}

export function waitStackComplete(
  state: SetupState,
  stackName: string,
  changeSetType: string,
  env: PathEnvironment = process.env,
): Effect.Effect<ProcessResult, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const run = yield* makeStateRunner(state);
    const waitName = changeSetType === "UPDATE" ? "stack-update-complete" : "stack-create-complete";
    return yield* run(["cloudformation", "wait", waitName, "--stack-name", stackName], {
      allowNonZero: true,
    }).pipe(
      Effect.catch((error) =>
        liftProviderError(state, env, `cloudformation wait ${waitName}`, error),
      ),
    );
  });
}

export function stackCreationProofForApply(
  state: SetupState,
  plan: Record<string, unknown>,
  binding: {
    stackId: string;
    stackName: string;
    accountId: string;
    partition: string;
    region: string;
    fingerprint: string;
    appliedAt: string;
  },
): Effect.Effect<Record<string, unknown> | undefined, SetupCommandError> {
  return Effect.gen(function* () {
    const existing = state.aws?.stackCreation;
    if (existing != null) {
      if (typeof existing !== "object" || Array.isArray(existing)) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: "Stored initial stack creation proof is malformed.",
          }),
        );
      }
      const proof = existing as Record<string, unknown>;
      for (const [key, expected] of Object.entries({
        stackId: binding.stackId,
        stackName: binding.stackName,
        accountId: binding.accountId,
        partition: binding.partition,
        region: binding.region,
      })) {
        if (proof[key] !== expected) {
          return yield* Effect.fail(
            new SetupCommandError({
              message: `Stored initial stack creation proof ${key} does not match the exact live stack binding.`,
            }),
          );
        }
      }
      if (
        proof.provenance !== "coordinator-reviewed-change-set" ||
        proof.phase !== "core" ||
        proof.changeSetType !== "CREATE"
      ) {
        return yield* Effect.fail(
          new SetupCommandError({
            message: "Stored initial stack creation proof is not a coordinator core CREATE.",
          }),
        );
      }
      return proof;
    }

    if (plan.phase !== "core" || plan.changeSetType !== "CREATE" || plan.noChange === true) {
      return undefined;
    }
    const changeSetArn = String(plan.changeSetArn ?? "");
    if (!changeSetArn.startsWith("arn:")) {
      return yield* Effect.fail(
        new SetupCommandError({
          message:
            "Cannot record initial stack creation proof without the reviewed change set ARN.",
        }),
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
  });
}

export function sanitizeAwsState(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizePlanMetadata(input);
}

function toSetupCommand(error: AwsCommandError): SetupCommandError {
  return new SetupCommandError({ message: error.message });
}

/**
 * Map provider errors: AccessDenied → T4 handoff (state intact);
 * expired session stays typed; other failures become SetupCommandError.
 */
export function liftProviderError(
  state: SetupState,
  env: PathEnvironment,
  operation: string,
  error: AwsCommandError | CancellationError | AwsAuthError,
): Effect.Effect<never, AwsWorkflowError, SetupStoreService | TerminalService> {
  return Effect.gen(function* () {
    if (error instanceof CancellationError) {
      return yield* Effect.fail(error);
    }
    if (error instanceof AwsAuthError) {
      if (error.reason === "access-denied") {
        return yield* emitPermissionHandoff(state, env, operation, error.message);
      }
      if (error.reason === "expired-session") {
        return yield* Effect.fail(
          new AwsCommandError({
            message: error.message,
            reason: "expired-session",
            operation,
            cause: error,
          }),
        );
      }
      return yield* Effect.fail(new SetupCommandError({ message: error.message }));
    }

    if (error.reason === "access-denied") {
      const text = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}`;
      return yield* emitPermissionHandoff(state, env, operation, text);
    }
    if (error.reason === "expired-session") {
      return yield* Effect.fail(error);
    }
    if (error.reason === "throttling" || error.reason === "timeout") {
      // No silent retry at this boundary — surface for operator; callers may retry only documented waits.
      return yield* Effect.fail(
        new SetupCommandError({
          message: `${operation} failed (${error.reason}): ${error.message}`,
        }),
      );
    }
    return yield* Effect.fail(
      new SetupCommandError({
        message: error.message,
      }),
    );
  });
}

function emitPermissionHandoff(
  state: SetupState,
  env: PathEnvironment,
  operation: string,
  errorText: string,
): Effect.Effect<never, AwsWorkflowError, SetupStoreService | TerminalService> {
  return Effect.gen(function* () {
    const denied = yield* mapAccessDeniedToHandoff(state, {
      env,
      operationHint: operation,
      errorText,
    });
    const handoffInput: PermissionHandoffInput = {
      profileName: denied.handoff.profileName,
      accountId: denied.handoff.accountId,
      roleName: denied.handoff.roleName,
      region: denied.handoff.region,
      partition: denied.handoff.partition,
      installationId: denied.handoff.installationId,
      artifactPath: denied.handoff.artifactPath,
      fingerprintSha256: denied.handoff.fingerprintSha256,
      operationHint: denied.operationHint,
      actionHint: denied.actionHint,
      dedicatedTemporaryAssignment: denied.handoff.dedicatedTemporaryAssignment,
    };
    yield* writeLine(formatPermissionHandoff(handoffInput));
    return yield* Effect.fail(denied);
  });
}

export type { ChangeSetSummary, ResolvedCallerContext };

export function requireNonActiveStack(
  stackName: string,
  status: string | null,
): Effect.Effect<void, SetupCommandError> {
  // REVIEW_IN_PROGRESS means a CREATE change set exists but nothing is running —
  // typically one this wizard itself created — so it stays plannable.
  if (status && status !== "REVIEW_IN_PROGRESS" && isActiveStackStatus(status)) {
    return Effect.fail(
      new SetupCommandError({
        message: `Stack ${stackName} is ${status}. Wait for the in-progress CloudFormation operation to finish, then re-run \`pnpm nusend:setup aws plan\`.`,
      }),
    );
  }
  if (status && /^(ROLLBACK_COMPLETE|DELETE_FAILED|UPDATE_ROLLBACK_FAILED)$/u.test(status)) {
    return Effect.fail(
      new SetupCommandError({
        message: `Stack ${stackName} is in ${status}. Delete or repair it before planning.`,
      }),
    );
  }
  return Effect.void;
}

export function asCommandError(error: unknown): SetupCommandError {
  if (error instanceof SetupCommandError) return error;
  return new SetupCommandError({
    message: error instanceof Error ? error.message : String(error),
  });
}
