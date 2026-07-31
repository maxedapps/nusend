import { readFile } from "node:fs/promises";

import { Cause, Effect, Exit, Option } from "effect";
import { unwrapEnvValue } from "../state/env.ts";
import { afterEach, describe, expect, it } from "vitest";

import { SetupStore, SetupStoreLive } from "../services/setup-store.ts";
import type { SetupState } from "../state/schema.ts";
import { runAwsApply } from "./apply.ts";
import {
  APPLY_CHECKPOINT_LOCAL_FINALIZATION,
  CREATE_RUNTIME_KEY_PHRASE,
  REQUEST_PRODUCTION_ACCESS_PHRASE,
  REQUIRED_CAPABILITY,
  defaultStackTemplatePath,
} from "./constants.ts";
import { runAwsCoreVerification } from "./core.ts";
import { requireNonActiveStack } from "./ops.ts";
import { AwsPermissionDeniedError } from "./permissions.ts";
import { runAwsPlan } from "./plan.ts";
import { runProductionAccessRequest } from "./production-access.ts";
import {
  buildApplyConfirmationPhrase,
  buildStackName,
  buildStackParameters,
  fingerprintTemplateAndParameters,
  mapStackOutputsToEnv,
} from "./pure.ts";
import { runCreateRuntimeKey } from "./runtime-key.ts";
import {
  cleanupTemps,
  createChangeSetDescription,
  pendingIdentity,
  readyIdentity,
  runWorkflow,
  runWorkflowExit,
  sampleOutputs,
  sampleState,
  stackIdFor,
  testEnv,
  validApplyPlan,
  validBrief,
  workflowLayer,
} from "./test-harness.ts";

afterEach(() => {
  cleanupTemps();
});

async function seedInstallation(env: NodeJS.ProcessEnv, installationId: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      yield* store.writeState(sampleState(installationId), env);
      yield* store.writeDeploymentEnv(
        installationId,
        {
          NUSEND_DOMAIN: "mail.example.com",
          NUSEND_INGRESS_MODE: "direct",
          NUSEND_OWNER_EMAIL: "owner@example.com",
          NUSEND_OWNER_NAME: "Owner",
          BETTER_AUTH_SECRET: "better-auth-secret-value-xxxxxxxx",
          GOOGLE_CLIENT_ID: "google-client-id",
          GOOGLE_CLIENT_SECRET: "google-client-secret-value",
          NUSEND_API_KEY_HASH_SECRET: "api-key-hash-secret-value-xxxxxx",
          NUSEND_UNSUBSCRIBE_SECRET: "unsubscribe-secret-value-xxxxxx",
          AWS_ACCESS_KEY_ID: "",
          AWS_SECRET_ACCESS_KEY: "",
          AWS_REGION: "us-east-1",
          NUSEND_SES_FROM_EMAIL: "sender@example.com",
          NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "",
          NUSEND_RESTIC_REPOSITORY: "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
          NUSEND_R2_ACCESS_KEY_ID: "r2-access",
          NUSEND_R2_SECRET_ACCESS_KEY: "r2-secret-value-xxxxxx",
          NUSEND_RESTIC_PASSWORD: "restic-password-value-xxxxxx",
        },
        env,
      );
      yield* store.writeCurrentPointer(installationId, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

async function writeAppliedStackState(env: NodeJS.ProcessEnv, installationId: string) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      const state = yield* store.loadState(installationId, env);
      yield* store.writeState(
        {
          ...state,
          aws: {
            stackCreation: {
              provenance: "coordinator-reviewed-change-set",
              phase: "core",
              changeSetType: "CREATE",
              stackId: stackIdFor(buildStackName(installationId)),
              stackName: buildStackName(installationId),
              accountId: "123456789012",
              partition: "aws",
              region: "us-east-1",
              changeSetArn:
                "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/create",
              fingerprint: "a".repeat(64),
              appliedAt: "2026-01-02T00:00:00.000Z",
            },
            stack: {
              stackId: stackIdFor(buildStackName(installationId)),
              stackName: buildStackName(installationId),
              accountId: "123456789012",
              partition: "aws",
              region: "us-east-1",
              phase: "core",
              status: "CREATE_COMPLETE",
              outputs: sampleOutputs(),
              appliedAt: "2026-01-02T00:00:00.000Z",
            },
          },
        },
        env,
      );
      const deployment = yield* store.loadDeploymentEnv(installationId, env);
      yield* store.writeDeploymentEnv(
        installationId,
        {
          ...deployment,
          ...mapStackOutputsToEnv(sampleOutputs(), state),
        },
        env,
      );
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

async function loadState(env: NodeJS.ProcessEnv, installationId: string): Promise<SetupState> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      return yield* store.loadState(installationId, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

async function writeState(env: NodeJS.ProcessEnv, state: SetupState): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      yield* store.writeState(state, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

async function loadDeploymentEnv(env: NodeJS.ProcessEnv, installationId: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      return yield* store.loadDeploymentEnv(installationId, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

function failMessage(exit: Exit.Exit<unknown, { message: string }>): string {
  if (Exit.isSuccess(exit)) return "";
  const err = Cause.findErrorOption(exit.cause);
  return Option.isSome(err) ? err.value.message : String(exit.cause);
}

describe("aws plan", () => {
  it("hard-fails on expected account mismatch and never creates a change set", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const { layer, calls } = workflowLayer(env, { stsAccount: "999999999999" });
    const exit = await runWorkflowExit(runAwsPlan(env), layer);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failMessage(exit)).toMatch(/account mismatch|does not match profile sso_account_id/i);
    expect(calls.some((c) => c.includes("create-change-set"))).toBe(false);
  });

  it("refuses AWS mutations without schema v2 SSO binding", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const state = await loadState(env, "prod");
    const { awsAuth: _awsAuth, ...rest } = state as typeof state & { awsAuth?: unknown };
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.writeState(
          {
            ...rest,
            schemaVersion: 1 as const,
          } as never,
          env,
        );
      }).pipe(Effect.provide(SetupStoreLive)),
    );
    const { layer, calls } = workflowLayer(env, {});
    const exit = await runWorkflowExit(runAwsPlan(env), layer);
    expect(failMessage(exit)).toMatch(/SSO binding|schema v1|aws auth/i);
    expect(calls.some((c) => c.includes("create-change-set"))).toBe(false);
  });

  it("plans CREATE, prints sanitized summary with IAM capability, and persists plan metadata only", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/abc";
    const { layer, calls, terminal } = workflowLayer(env, {
      stackExists: false,
      changeSetArn,
      changeSet: createChangeSetDescription({
        changeSetArn,
        status: "CREATE_COMPLETE",
        changes: [
          {
            ResourceChange: {
              Action: "Add",
              LogicalResourceId: "RuntimeUser",
              ResourceType: "AWS::IAM::User",
              Replacement: "False",
            },
          },
          {
            ResourceChange: {
              Action: "Add",
              LogicalResourceId: "FeedbackTopic",
              ResourceType: "AWS::SNS::Topic",
              Replacement: "False",
            },
          },
        ],
      }),
    });

    await runWorkflow(runAwsPlan(env), layer);

    expect(calls.some((c) => c.includes("validate-template"))).toBe(true);
    expect(calls.some((c) => c.includes("create-change-set"))).toBe(true);
    expect(calls.some((c) => c.includes(REQUIRED_CAPABILITY))).toBe(true);
    expect(calls.some((c) => c.includes("CREATE"))).toBe(true);
    for (const call of calls.filter((c) => c[0] === "aws")) {
      expect(call.some((part) => part === "sh" || part === "bash" || part === "-c")).toBe(false);
    }

    const state = await loadState(env, "prod");
    const plan = state.plans.aws;
    expect(plan.changeSetArn).toBe(changeSetArn);
    expect(plan.stackName).toBe("nusend-prod");
    expect(plan.phase).toBe("core");
    expect(plan.accountId).toBe("123456789012");
    expect(plan.partition).toBe("aws");
    expect(plan.region).toBe("us-east-1");
    expect(plan.noChange).toBe(false);
    expect(typeof plan.fingerprint).toBe("string");
    expect(JSON.stringify(plan)).not.toMatch(/Secret|password|BEGIN /i);

    const logText = terminal.state.stdout.join("");
    expect(logText).toMatch(/CAPABILITY_NAMED_IAM/);
    expect(logText).toMatch(/RuntimeUser/);
    expect(logText).not.toMatch(/SecretAccessKey/);
  });

  it("refuses a fresh same-name core stack collision before any change-set mutation", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const { layer, calls } = workflowLayer(env, { stackExists: true });
    const exit = await runWorkflowExit(runAwsPlan(env), layer);
    expect(failMessage(exit)).toMatch(/collision|core CREATE provenance|Refusing to adopt/i);
    expect(calls.some((call) => call.includes("delete-change-set"))).toBe(false);
    expect(calls.some((call) => call.includes("create-change-set"))).toBe(false);
    expect((await loadState(env, "prod")).plans.aws).toBeUndefined();
  });

  it("plans UPDATE for an existing core stack only with exact coordinator CREATE provenance", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/upd";
    const { layer, calls, terminal } = workflowLayer(env, {
      stackExists: true,
      changeSetArn,
      changeSet: createChangeSetDescription({
        changeSetArn,
        status: "CREATE_COMPLETE",
        changes: [
          {
            ResourceChange: {
              Action: "Modify",
              LogicalResourceId: "EmailIdentity",
              ResourceType: "AWS::SES::EmailIdentity",
              Replacement: "True",
            },
          },
        ],
      }),
    });
    await runWorkflow(runAwsPlan(env), layer);
    expect(calls.some((c) => c.includes("UPDATE"))).toBe(true);
    expect(terminal.state.stdout.join("")).toMatch(/replaced/i);
    const state = await loadState(env, "prod");
    expect(state.plans.aws.changeSetType).toBe("UPDATE");
  });

  it("rejects mismatched immutable core CREATE provenance", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const state = await loadState(env, "prod");
    await writeState(env, {
      ...state,
      aws: {
        ...state.aws,
        stackCreation: { ...state.aws?.stackCreation, region: "us-west-2" },
      },
    });
    const { layer, calls } = workflowLayer(env, { stackExists: true });
    const exit = await runWorkflowExit(runAwsPlan(env), layer);
    expect(failMessage(exit)).toMatch(/collision|exact coordinator core CREATE provenance/i);
    expect(calls.some((call) => call.includes("delete-change-set"))).toBe(false);
    expect(calls.some((call) => call.includes("create-change-set"))).toBe(false);
  });

  it("handles no-change change sets explicitly only for a proven existing stack", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/none";
    const { layer, terminal } = workflowLayer(env, {
      stackExists: true,
      changeSetArn,
      changeSet: {
        Status: "FAILED",
        StatusReason: "The submitted information didn't contain changes.",
        ChangeSetId: changeSetArn,
        StackId: stackIdFor("nusend-prod"),
        StackName: "nusend-prod",
        Changes: [],
        Capabilities: [REQUIRED_CAPABILITY],
      },
      waitChangeSetExitCode: 255,
    });
    await runWorkflow(runAwsPlan(env), layer);
    const state = await loadState(env, "prod");
    expect(state.plans.aws.noChange).toBe(true);
    expect(terminal.state.stdout.join("")).toMatch(/NO_CHANGES/);
  });

  it("deletes abandoned prior change sets on re-plan", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const priorArn = "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/old";
    const state = await loadState(env, "prod");
    await writeState(env, {
      ...state,
      plans: {
        aws: {
          changeSetArn: priorArn,
          stackName: "nusend-prod",
          phase: "core",
        },
      },
    });
    const newArn = "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/new";
    const { layer, calls } = workflowLayer(env, {
      stackExists: false,
      changeSetArn: newArn,
      changeSet: createChangeSetDescription({
        changeSetArn: newArn,
        status: "CREATE_COMPLETE",
        changes: [],
      }),
    });
    await runWorkflow(runAwsPlan(env), layer);
    const deletes = calls.filter((c) => c.includes("delete-change-set"));
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(deletes.some((c) => c.includes(priorArn) || c.includes("nusend-prod-core"))).toBe(true);
  });

  it("refuses planning while the stack has an active/nonstable status", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    {
      const { layer, calls } = workflowLayer(env, {
        stackExists: true,
        stackStatus: "UPDATE_IN_PROGRESS",
      });
      const exit = await runWorkflowExit(runAwsPlan(env), layer);
      expect(failMessage(exit)).toMatch(/UPDATE_IN_PROGRESS|in-progress/i);
      expect(calls.some((c) => c.includes("create-change-set"))).toBe(false);
    }
    {
      const { layer } = workflowLayer(env, {
        stackExists: true,
        stackStatus: "REVIEW_IN_PROGRESS",
      });
      const exit = await runWorkflowExit(runAwsPlan(env), layer);
      // REVIEW_IN_PROGRESS is not an active operation; planning proceeds past this
      // gate and is only stopped by the unrelated provenance guard.
      expect(failMessage(exit)).not.toMatch(/Wait for the in-progress/i);
    }
  });

  it.each([
    ["REVIEW_IN_PROGRESS", null],
    ["UPDATE_ROLLBACK_COMPLETE", null],
    ["CREATE_IN_PROGRESS", /Wait for the in-progress/i],
    ["ROLLBACK_COMPLETE", /Delete or repair/i],
    ["DELETE_FAILED", /Delete or repair/i],
  ])("gates planning for stack status %s", (status, expected) => {
    const exit = Effect.runSyncExit(requireNonActiveStack("nusend-prod", status));
    if (expected === null) {
      expect(Exit.isSuccess(exit)).toBe(true);
      return;
    }
    expect(failMessage(exit as Exit.Exit<unknown, { message: string }>)).toMatch(expected);
  });

  it("emits permission handoff on AccessDenied and preserves plans", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const prior = await loadState(env, "prod");
    await writeState(env, {
      ...prior,
      plans: {
        aws: {
          changeSetArn: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/keep/me",
          fingerprint: "keep-fp",
        },
      },
    });
    const { layer, terminal } = workflowLayer(env, {
      stackExists: false,
      accessDeniedOn: "create-change-set",
      changeSetArn: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/x/y",
    });
    // Need validate-template and describe to succeed; only create denied.
    // accessDeniedOn matches create-change-set after validate.
    const exit = await runWorkflowExit(runAwsPlan(env), layer);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(err) && err.value instanceof AwsPermissionDeniedError).toBe(true);
    }
    expect(terminal.state.stdout.join("")).toMatch(/permission handoff/i);
    const state = await loadState(env, "prod");
    expect(state.plans.aws.changeSetArn).toBe(
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/keep/me",
    );
    expect(state.plans.aws.fingerprint).toBe("keep-fp");
  });
});

describe("aws apply", () => {
  it("rejects missing, stale account/region, and fingerprint-mismatched plans", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");

    {
      const { layer } = workflowLayer(env, {});
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/No stored AWS plan/);
    }

    const base = await loadState(env, "prod");
    await writeState(env, {
      ...base,
      plans: {
        aws: {
          changeSetArn: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/x/y",
          stackName: "nusend-prod",
          phase: "core",
          fingerprint: "deadbeef",
          accountId: "123456789012",
          partition: "aws",
          region: "eu-west-1",
          noChange: false,
          changeSetType: "CREATE",
        },
      },
    });
    {
      const { layer } = workflowLayer(env, {}, ["nope"]);
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/region/i);
    }

    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const params = buildStackParameters(base, "core");
    const fingerprint = fingerprintTemplateAndParameters(template, params, {
      stackName: "nusend-prod",
      phase: "core",
    });
    await writeState(env, {
      ...base,
      plans: {
        aws: {
          changeSetArn: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/x/y",
          stackName: "nusend-prod",
          phase: "core",
          fingerprint: `${fingerprint.slice(0, -1)}0`,
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          noChange: false,
          changeSetType: "CREATE",
        },
      },
    });
    {
      const phrase = buildApplyConfirmationPhrase({
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        phase: "core",
      });
      const { layer } = workflowLayer(env, {}, [phrase]);
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/fingerprint/i);
    }
  });

  it("executes only the stored ARN after exact phrase and maps outputs into env", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/apply";
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const base = await loadState(env, "prod");
    const params = buildStackParameters(base, "core");
    const fingerprint = fingerprintTemplateAndParameters(template, params, {
      stackName: "nusend-prod",
      phase: "core",
    });
    await writeState(env, {
      ...base,
      plans: {
        aws: {
          changeSetArn,
          changeSetName: "nusend-prod-core",
          stackName: "nusend-prod",
          stackId: null,
          phase: "core",
          changeSetType: "CREATE",
          fingerprint,
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          noChange: false,
        },
      },
    });

    const phrase = buildApplyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    });
    const { layer, calls, terminal } = workflowLayer(
      env,
      {
        stackExists: true,
        stackOutputs: sampleOutputs(),
        identity: readyIdentity(),
      },
      [phrase],
    );
    await runWorkflow(runAwsApply(env), layer);

    const execute = calls.find((c) => c.includes("execute-change-set"));
    expect(execute).toBeTruthy();
    expect(execute?.includes(changeSetArn)).toBe(true);
    expect(execute?.includes("--profile")).toBe(true);
    expect(execute?.includes("--region")).toBe(true);

    const deployment = await loadDeploymentEnv(env, "prod");
    expect(deployment.NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET).toBe("nusend-prod-transactional");
    expect(deployment.NUSEND_SES_FEEDBACK_TOPIC_ARNS).toBe(
      "arn:aws:sns:us-east-1:123456789012:nusend-prod-ses-events",
    );
    expect(deployment.AWS_REGION).toBe("us-east-1");

    const state = await loadState(env, "prod");
    expect(state.aws?.stack?.stackName).toBe("nusend-prod");
    expect(state.aws?.stack?.stackId).toBe(stackIdFor("nusend-prod"));
    expect(state.aws?.stackCreation).toMatchObject({
      provenance: "coordinator-reviewed-change-set",
      phase: "core",
      changeSetType: "CREATE",
      stackId: stackIdFor("nusend-prod"),
      changeSetArn,
      fingerprint,
    });
    expect(state.plans.aws.consumed).toBe(true);
    expect(terminal.state.stdout.join("")).toMatch(/DKIM CNAME/);
    expect(terminal.state.stdout.join("")).toMatch(/token1\._domainkey\.example\.com/);
    expect(JSON.stringify(state)).not.toMatch(/SecretAccessKey|super-secret/);
  });

  it("skips execute on recorded no-change path and still refreshes ownership/outputs", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const base = await loadState(env, "prod");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/none";
    await writeState(env, {
      ...base,
      plans: {
        aws: {
          changeSetArn,
          stackName: "nusend-prod",
          stackId: stackIdFor("nusend-prod"),
          phase: "core",
          changeSetType: "UPDATE",
          fingerprint,
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          noChange: true,
        },
      },
    });
    const phrase = buildApplyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    });
    const { layer, calls } = workflowLayer(
      env,
      {
        stackExists: true,
        stackOutputs: sampleOutputs(),
        identity: readyIdentity(),
        changeSetArn,
        changeSet: {
          Status: "FAILED",
          StatusReason: "The submitted information didn't contain changes.",
          ExecutionStatus: "UNAVAILABLE",
          ChangeSetId: changeSetArn,
          StackId: stackIdFor("nusend-prod"),
          StackName: "nusend-prod",
          Changes: [],
          Capabilities: [REQUIRED_CAPABILITY],
        },
      },
      [phrase],
    );
    await runWorkflow(runAwsApply(env), layer);
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    const state = await loadState(env, "prod");
    expect(state.aws?.stack?.outputs).toMatchObject({
      RuntimeUserName: "nusend-prod-runtime",
    });
  });

  it("prints bounded rollback diagnostics without env contents or secrets on stack failure", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/fail";
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const base = await loadState(env, "prod");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    await writeState(env, {
      ...base,
      plans: {
        aws: {
          changeSetArn,
          stackName: "nusend-prod",
          stackId: stackIdFor("nusend-prod"),
          phase: "core",
          changeSetType: "CREATE",
          fingerprint,
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          noChange: false,
        },
      },
    });
    const phrase = buildApplyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    });
    const { layer } = workflowLayer(
      env,
      {
        stackExists: true,
        stackStatus: "ROLLBACK_COMPLETE",
        stackOutputs: sampleOutputs(),
        waitStackExitCode: 255,
        stackEvents: {
          StackEvents: [
            {
              LogicalResourceId: "RuntimeUser",
              ResourceStatus: "CREATE_FAILED",
              ResourceStatusReason: "Name already exists",
            },
          ],
        },
      },
      [phrase],
    );
    const exit = await runWorkflowExit(runAwsApply(env), layer);
    const message = failMessage(exit);
    expect(message).toMatch(/RuntimeUser[\s\S]*CREATE_FAILED[\s\S]*Name already exists/);
    expect(message).not.toMatch(
      /BETTER_AUTH_SECRET|google-client-secret|SecretAccessKey|restic-password/i,
    );
  });

  it("rejects consumed plans immediately before prompt or provider mutation", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState(env, "prod");
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    await writeState(env, {
      ...base,
      plans: {
        aws: {
          changeSetArn:
            "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/done",
          stackName: "nusend-prod",
          stackId: stackIdFor("nusend-prod"),
          phase: "core",
          changeSetType: "CREATE",
          fingerprint,
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          noChange: false,
          consumed: true,
          consumedAt: "2026-01-03T00:00:00.000Z",
        },
      },
    });
    const { layer, calls, terminal } = workflowLayer(env, {}, ["should-not-run"]);
    const exit = await runWorkflowExit(runAwsApply(env), layer);
    expect(failMessage(exit)).toMatch(/already consumed/i);
    expect(terminal.state.prompts.length).toBe(0);
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    expect(calls.some((c) => c.includes("describe-change-set"))).toBe(false);
  });

  it("rejects core/finalize phase mismatches against determinePhase(state)", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState(env, "prod");
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const finalizeFingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "finalize"),
      { stackName: "nusend-prod", phase: "finalize" },
    );
    await writeState(env, {
      ...base,
      plans: {
        aws: validApplyPlan({
          fingerprint: finalizeFingerprint,
          phase: "finalize",
        }),
      },
    });
    {
      const { layer } = workflowLayer(env, {}, ["nope"]);
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/phase "finalize".*phase "core"/i);
    }

    const withCore = {
      ...base,
      stages: {
        ...base.stages,
        aws_core: {
          status: "complete" as const,
          completedAt: "2026-01-02T00:00:00.000Z",
          evidence: { verified: true },
        },
      },
    };
    const coreFingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(withCore, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    await writeState(env, {
      ...withCore,
      plans: {
        aws: validApplyPlan({
          fingerprint: coreFingerprint,
          phase: "core",
        }),
      },
    });
    {
      const { layer } = workflowLayer(env, {}, ["nope"]);
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/phase "core".*phase "finalize"/i);
    }
  });

  it("rejects stored account mismatch and change-set ARN/stack/status mismatches before execute", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState(env, "prod");
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );

    await writeState(env, {
      ...base,
      plans: {
        aws: validApplyPlan({
          fingerprint,
          accountId: "111111111111",
          changeSetArn:
            "arn:aws:cloudformation:us-east-1:111111111111:changeSet/nusend-prod-core/x",
        }),
      },
    });
    {
      const { layer } = workflowLayer(env, {}, ["nope"]);
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/account/i);
    }

    const wrongAccountArn =
      "arn:aws:cloudformation:us-east-1:999999999999:changeSet/nusend-prod-core/x";
    await writeState(env, {
      ...base,
      plans: {
        aws: validApplyPlan({
          fingerprint,
          changeSetArn: wrongAccountArn,
        }),
      },
    });
    {
      const phrase = buildApplyConfirmationPhrase({
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        phase: "core",
      });
      const { layer, calls } = workflowLayer(env, {}, [phrase]);
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/Change set ARN account/i);
      expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    }

    const goodArn = "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/bind";
    await writeState(env, {
      ...base,
      plans: {
        aws: validApplyPlan({
          fingerprint,
          changeSetArn: goodArn,
          stackId: stackIdFor("nusend-prod"),
        }),
      },
    });
    {
      const phrase = buildApplyConfirmationPhrase({
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        phase: "core",
      });
      const { layer, calls } = workflowLayer(
        env,
        {
          changeSetArn: goodArn,
          changeSet: createChangeSetDescription({
            changeSetArn: goodArn,
            status: "CREATE_COMPLETE",
            changes: [],
            stackId: stackIdFor("nusend-prod-REPLACED"),
            stackName: "nusend-prod",
          }),
        },
        [phrase],
      );
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/stack id|same-name replacement/i);
      expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    }

    {
      const phrase = buildApplyConfirmationPhrase({
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        phase: "core",
      });
      const { layer, calls } = workflowLayer(
        env,
        {
          changeSetArn: goodArn,
          changeSet: createChangeSetDescription({
            changeSetArn: goodArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: "OBSOLETE",
          }),
        },
        [phrase],
      );
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/OBSOLETE/i);
      expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    }
  });

  it("executes AVAILABLE change sets and resumes EXECUTE_IN_PROGRESS / EXECUTE_COMPLETE without re-executing", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState(env, "prod");
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const availableArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/available";
    await writeState(env, {
      ...base,
      plans: {
        aws: validApplyPlan({
          fingerprint,
          changeSetArn: availableArn,
        }),
      },
    });
    const phrase = buildApplyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    });
    {
      const { layer, calls } = workflowLayer(
        env,
        {
          stackExists: true,
          stackOutputs: sampleOutputs(),
          changeSetArn: availableArn,
          changeSet: createChangeSetDescription({
            changeSetArn: availableArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: "AVAILABLE",
          }),
          identity: readyIdentity(),
        },
        [phrase],
      );
      await runWorkflow(runAwsApply(env), layer);
      expect(calls.filter((c) => c.includes("execute-change-set")).length).toBe(1);
    }

    for (const executionStatus of ["EXECUTE_IN_PROGRESS", "EXECUTE_COMPLETE"] as const) {
      const resumeEnv = testEnv();
      await seedInstallation(resumeEnv, "prod");
      const resumeBase = await loadState(resumeEnv, "prod");
      const resumeArn = `arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/${executionStatus.toLowerCase()}`;
      await writeState(resumeEnv, {
        ...resumeBase,
        plans: {
          aws: validApplyPlan({
            fingerprint,
            changeSetArn: resumeArn,
          }),
        },
      });
      const { layer, calls } = workflowLayer(
        resumeEnv,
        {
          stackExists: true,
          stackOutputs: sampleOutputs(),
          changeSetArn: resumeArn,
          changeSet: createChangeSetDescription({
            changeSetArn: resumeArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus,
          }),
          identity: readyIdentity(),
        },
        [phrase],
      );
      await runWorkflow(runAwsApply(resumeEnv), layer);
      expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
      expect(calls.some((c) => c.includes("describe-change-set"))).toBe(true);
      const state = await loadState(resumeEnv, "prod");
      expect(state.plans.aws.consumed).toBe(true);
      expect(state.aws?.stack?.stackId).toBe(stackIdFor("nusend-prod"));
    }
  });

  it("rechecks finalize subscription absence before execution but resumes an executed change set", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const base = await loadState(env, "prod");
    const finalizeState = {
      ...base,
      stages: {
        ...base.stages,
        aws_core: {
          status: "complete" as const,
          completedAt: "2026-01-02T00:00:00.000Z",
          evidence: { verified: true },
        },
        human_gates: {
          status: "complete" as const,
          completedAt: "2026-01-02T00:00:00.000Z",
          evidence: { verified: true },
        },
        deploy: {
          status: "complete" as const,
          completedAt: "2026-01-02T00:00:00.000Z",
          evidence: { verified: true },
        },
      },
    };
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(finalizeState, "finalize"),
      { stackName: "nusend-prod", phase: "finalize" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-finalize/race";
    await writeState(env, {
      ...finalizeState,
      plans: {
        ...finalizeState.plans,
        aws: validApplyPlan({
          changeSetArn,
          changeSetName: "nusend-prod-finalize",
          changeSetType: "UPDATE",
          phase: "finalize",
          fingerprint,
        }),
      },
    });
    const confirmed = {
      Protocol: "https",
      Endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
      SubscriptionArn: "arn:aws:sns:us-east-1:123456789012:nusend-prod-ses-events:subscription-id",
      Owner: "123456789012",
    };
    const phrase = buildApplyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "finalize",
    });

    {
      const { layer, calls } = workflowLayer(
        env,
        {
          changeSetArn,
          feedbackSubscriptions: [confirmed],
          changeSet: createChangeSetDescription({
            changeSetArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: "AVAILABLE",
          }),
        },
        [phrase],
      );
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/pre-existing HTTPS subscription/i);
      expect(calls.some((call) => call.includes("list-subscriptions-by-topic"))).toBe(true);
      expect(calls.some((call) => call.includes("execute-change-set"))).toBe(false);
    }

    {
      const { layer, calls } = workflowLayer(
        env,
        {
          stackExists: true,
          stackStatus: "UPDATE_COMPLETE",
          stackOutputs: sampleOutputs(),
          changeSetArn,
          feedbackSubscriptions: [confirmed],
          changeSet: createChangeSetDescription({
            changeSetArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: "EXECUTE_COMPLETE",
          }),
          identity: readyIdentity(),
        },
        [phrase],
      );
      await runWorkflow(runAwsApply(env), layer);
      expect(calls.some((call) => call.includes("execute-change-set"))).toBe(false);
      expect(calls.some((call) => call.includes("get-subscription-attributes"))).toBe(true);
      const finalized = await loadState(env, "prod");
      expect(finalized.plans.aws.consumed).toBe(true);
      expect(finalized.aws?.stack?.changeSetType).toBe("UPDATE");
      expect(finalized.aws?.stackCreation).toMatchObject({
        provenance: "coordinator-reviewed-change-set",
        phase: "core",
        changeSetType: "CREATE",
        stackId: stackIdFor("nusend-prod"),
      });
    }
  });

  it("recovers from ambiguous execute errors when live execution is already in progress/complete", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState(env, "prod");
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/ambiguous";
    await writeState(env, {
      ...base,
      plans: {
        aws: validApplyPlan({
          fingerprint,
          changeSetArn,
        }),
      },
    });
    let describeCount = 0;
    const phrase = buildApplyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    });
    const { layer, calls } = workflowLayer(
      env,
      {
        stackExists: true,
        stackOutputs: sampleOutputs(),
        changeSetArn,
        executeExitCode: 255,
        executeStderr: "Rate exceeded",
        identity: readyIdentity(),
        changeSetFactory: () => {
          describeCount += 1;
          return createChangeSetDescription({
            changeSetArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: describeCount === 1 ? "AVAILABLE" : "EXECUTE_IN_PROGRESS",
          });
        },
      },
      [phrase],
    );
    await runWorkflow(runAwsApply(env), layer);
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(true);
    expect(describeCount).toBeGreaterThanOrEqual(2);
    const state = await loadState(env, "prod");
    expect(state.plans.aws.consumed).toBe(true);
  });

  it("checkpoints after provider success so a local env failure can rerun without provider mutation", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState(env, "prod");
    const template = await readFile(defaultStackTemplatePath(), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/durable";
    await writeState(env, {
      ...base,
      plans: {
        aws: validApplyPlan({
          fingerprint,
          changeSetArn,
        }),
      },
    });
    const phrase = buildApplyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    });

    {
      const { SetupCommandError } = await import("../errors.ts");
      const { layer, calls } = workflowLayer(
        env,
        {
          stackExists: true,
          stackOutputs: sampleOutputs(),
          changeSetArn,
          changeSet: createChangeSetDescription({
            changeSetArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: "AVAILABLE",
          }),
          identity: readyIdentity(),
        },
        [phrase],
      );
      const exit = await runWorkflowExit(
        runAwsApply(env, {
          afterProviderCheckpoint: () =>
            Effect.fail(new SetupCommandError({ message: "simulated local env failure" })),
        }),
        layer,
      );
      expect(failMessage(exit)).toMatch(/simulated local env failure/);
      expect(calls.some((c) => c.includes("execute-change-set"))).toBe(true);
      const crashed = await loadState(env, "prod");
      expect(crashed.plans.aws.consumed).not.toBe(true);
      expect(crashed.plans.aws.providerApplied).toBe(true);
      expect(crashed.plans.aws.applyCheckpoint).toBe(APPLY_CHECKPOINT_LOCAL_FINALIZATION);
      expect(crashed.aws?.stack?.stackId).toBe(stackIdFor("nusend-prod"));
      const crashedDeployment = await loadDeploymentEnv(env, "prod");
      expect(crashedDeployment.NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET ?? "").toBe("");
    }

    {
      const { layer, calls } = workflowLayer(
        env,
        {
          stackExists: true,
          stackOutputs: sampleOutputs(),
          identity: readyIdentity(),
        },
        [],
      );
      await runWorkflow(runAwsApply(env), layer);
      expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
      const deployment = await loadDeploymentEnv(env, "prod");
      expect(deployment.NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET).toBe(
        "nusend-prod-transactional",
      );
      const finished = await loadState(env, "prod");
      expect(finished.plans.aws.consumed).toBe(true);
      expect(finished.aws?.stack?.stackId).toBe(stackIdFor("nusend-prod"));
    }

    {
      const { layer } = workflowLayer(env, {}, ["nope"]);
      const exit = await runWorkflowExit(runAwsApply(env), layer);
      expect(failMessage(exit)).toMatch(/already consumed/i);
    }
  });
});

describe("DKIM, production access, runtime key, continue gates", () => {
  it("blocks aws core while DKIM/identity pending and passes when ready with runtime key", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");

    {
      const { layer } = workflowLayer(env, {
        stackExists: true,
        stackOutputs: sampleOutputs(),
        identity: pendingIdentity(),
      });
      const exit = await runWorkflowExit(
        runAwsCoreVerification(env, await loadState(env, "prod")),
        layer,
      );
      expect(failMessage(exit)).toMatch(/identity verification is not ready|DKIM is not ready/i);
    }

    const secret = "runtime-secret-value-DO-NOT-LOG";
    const accessKeyId = "AKIAEXAMPLECORE0001";
    const { layer, terminal } = workflowLayer(
      env,
      {
        stackExists: true,
        stackOutputs: sampleOutputs(),
        identity: readyIdentity(),
        accessKeys: [],
        createdAccessKey: {
          AccessKeyId: accessKeyId,
          SecretAccessKey: secret,
        },
        account: {
          ProductionAccessEnabled: false,
          Details: { ReviewDetails: { Status: "NONE" } },
        },
      },
      [CREATE_RUNTIME_KEY_PHRASE, "n"],
    );
    const evidence = await runWorkflow(
      runAwsCoreVerification(env, await loadState(env, "prod")),
      layer,
    );
    expect(evidence.verified).toBe(true);
    expect(evidence.runtimeAccessKeyId).toBe(accessKeyId);
    const deployment = await loadDeploymentEnv(env, "prod");
    expect(deployment.AWS_ACCESS_KEY_ID).toBe(accessKeyId);
    expect(unwrapEnvValue(deployment.AWS_SECRET_ACCESS_KEY!)).toBe(secret);
    const state = await loadState(env, "prod");
    expect(JSON.stringify(state)).toContain(accessKeyId);
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(terminal.state.stdout.join("")).not.toContain(secret);
    expect(terminal.state.stdout.join("")).not.toContain(accessKeyId);
  });

  it("refuses runtime key creation when any key already exists", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const { layer } = workflowLayer(
      env,
      {
        stackExists: true,
        accessKeys: [{ AccessKeyId: "AKIAEXISTING", Status: "Active" }],
      },
      [CREATE_RUNTIME_KEY_PHRASE],
    );
    const exit = await runWorkflowExit(
      runCreateRuntimeKey(env, { existingState: await loadState(env, "prod") }),
      layer,
    );
    expect(failMessage(exit)).toMatch(/already has .* access key/i);
  });

  it("requires exact CREATE-RUNTIME-KEY phrase and inserts id+secret atomically", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const secret = "atomic-runtime-secret-value";
    const accessKeyId = "AKIAEXAMPLEATOMIC01";

    {
      const { layer } = workflowLayer(
        env,
        {
          accessKeys: [],
          createdAccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: secret },
        },
        ["WRONG"],
      );
      const exit = await runWorkflowExit(
        runCreateRuntimeKey(env, { existingState: await loadState(env, "prod") }),
        layer,
      );
      expect(failMessage(exit)).toMatch(/Confirmation rejected/);
    }

    {
      const { layer } = workflowLayer(
        env,
        {
          accessKeys: [],
          createdAccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: secret },
        },
        [CREATE_RUNTIME_KEY_PHRASE],
      );
      await runWorkflow(
        runCreateRuntimeKey(env, { existingState: await loadState(env, "prod") }),
        layer,
      );
      const deployment = await loadDeploymentEnv(env, "prod");
      expect(deployment.AWS_ACCESS_KEY_ID).toBe(accessKeyId);
      expect(unwrapEnvValue(deployment.AWS_SECRET_ACCESS_KEY!)).toBe(secret);
      const state = await loadState(env, "prod");
      expect(state.aws?.runtimeAccessKeyId).toBe(accessKeyId);
      expect(JSON.stringify(state)).not.toContain(secret);
    }

    {
      const { layer } = workflowLayer(env, { accessKeys: [] }, [CREATE_RUNTIME_KEY_PHRASE]);
      const exit = await runWorkflowExit(
        runCreateRuntimeKey(env, { existingState: await loadState(env, "prod") }),
        layer,
      );
      expect(failMessage(exit)).toMatch(/already recorded|manual rotation/i);
    }
  });

  it("submits production access only with exact phrase, rejects blanks, and never resubmits pending", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");

    {
      const { layer, calls } = workflowLayer(env, {
        account: {
          ProductionAccessEnabled: false,
          Details: { ReviewDetails: { Status: "NONE" } },
        },
      });
      const exit = await runWorkflowExit(
        runProductionAccessRequest(env, {
          existingState: await loadState(env, "prod"),
          submitEnabled: true,
          brief: { ...validBrief(), website: "https://example.com" },
          confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE,
        }),
        layer,
      );
      expect(failMessage(exit)).toMatch(/fabricated|website/i);
      expect(calls.some((c) => c.includes("put-account-details"))).toBe(false);
    }

    {
      const { layer, calls } = workflowLayer(env, {
        account: {
          ProductionAccessEnabled: false,
          Details: { ReviewDetails: { Status: "NONE" } },
        },
      });
      await runWorkflow(
        runProductionAccessRequest(env, {
          existingState: await loadState(env, "prod"),
          submitEnabled: true,
          brief: validBrief(),
          confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE,
        }),
        layer,
      );
      expect(calls.some((c) => c.includes("put-account-details"))).toBe(true);
      expect(calls.some((c) => c.includes(REQUEST_PRODUCTION_ACCESS_PHRASE))).toBe(false);
      const put = calls.find((c) => c.includes("put-account-details"));
      expect(put?.includes("--profile")).toBe(true);
      expect(put?.includes("--region")).toBe(true);
    }

    {
      const { layer, calls } = workflowLayer(env, {
        account: {
          ProductionAccessEnabled: false,
          Details: { ReviewDetails: { Status: "PENDING" } },
        },
      });
      const pending = await runWorkflow(
        runProductionAccessRequest(env, {
          existingState: await loadState(env, "prod"),
          submitEnabled: true,
          brief: validBrief(),
          confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE,
        }),
        layer,
      );
      expect(pending.status).toBe("pending");
      expect(calls.some((c) => c.includes("put-account-details"))).toBe(false);
    }

    {
      const { layer } = workflowLayer(env, {
        account: {
          ProductionAccessEnabled: true,
          Details: { ReviewDetails: { Status: "GRANTED" } },
        },
      });
      const approved = await runWorkflow(
        runProductionAccessRequest(env, {
          existingState: await loadState(env, "prod"),
          submitEnabled: true,
          brief: validBrief(),
          confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE,
        }),
        layer,
      );
      expect(approved.status).toBe("approved");
    }
  });
});
