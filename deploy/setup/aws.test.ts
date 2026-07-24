import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  APPLY_CHECKPOINT_LOCAL_FINALIZATION,
  APPLY_PHRASE_PREFIX,
  CREATE_RUNTIME_KEY_PHRASE,
  REQUEST_PRODUCTION_ACCESS_PHRASE,
  REQUIRED_CAPABILITY,
  assertHonestWebsiteUrl,
  awsArgv,
  buildApplyConfirmationPhrase,
  buildStackName,
  buildStackParameters,
  determinePhase,
  fingerprintTemplateAndParameters,
  formatDkimRecords,
  isActiveStackStatus,
  isDkimReady,
  isFabricatedPlaceholder,
  isHealthyTerminalStackStatus,
  isIdentityReady,
  isNoChangeChangeSet,
  mapStackOutputsToEnv,
  parseChangeSetArn,
  runAwsApply,
  runAwsCoreVerification,
  runAwsPlan,
  runCreateRuntimeKey,
  runProductionAccessRequest,
  summarizeChangeSet,
  summarizeFailedStackEvents,
  validateApplyConfirmation,
  validateProductionBrief,
} from "./aws.mjs";
import {
  loadDeploymentEnv,
  loadState,
  stateFilePath,
  writeCurrentPointer,
  writeDeploymentEnv,
  writeState,
} from "./state.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("aws pure helpers", () => {
  it("builds deterministic core/finalize parameters and phase", () => {
    const state = sampleState("prod");
    expect(determinePhase(state)).toBe("core");
    const core = buildStackParameters(state, "core");
    expect(core.find((p) => p.ParameterKey === "EnableWebhookSubscription")?.ParameterValue).toBe(
      "false",
    );
    expect(core.find((p) => p.ParameterKey === "InstallationName")?.ParameterValue).toBe("prod");
    expect(core.find((p) => p.ParameterKey === "EnableDeliveryEvents")?.ParameterValue).toBe(
      "true",
    );

    const withCore = {
      ...state,
      stages: {
        ...state.stages,
        aws_core: {
          status: "complete" as const,
          completedAt: "2026-01-02T00:00:00.000Z",
          evidence: { verified: true },
        },
      },
    };
    expect(determinePhase(withCore)).toBe("finalize");
    const finalize = buildStackParameters(withCore, "finalize");
    expect(
      finalize.find((p) => p.ParameterKey === "EnableWebhookSubscription")?.ParameterValue,
    ).toBe("true");
  });

  it("fingerprints template+parameters stably and changes with phase", () => {
    const state = sampleState("prod");
    const template = '{"Resources":{}}';
    const core = buildStackParameters(state, "core");
    const a = fingerprintTemplateAndParameters(template, core, {
      stackName: "nusend-prod",
      phase: "core",
    });
    const b = fingerprintTemplateAndParameters(template, core, {
      stackName: "nusend-prod",
      phase: "core",
    });
    const c = fingerprintTemplateAndParameters(template, buildStackParameters(state, "finalize"), {
      stackName: "nusend-prod",
      phase: "finalize",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires exact apply confirmation phrase with account/region/stack/phase", () => {
    const expected = {
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      phase: "core",
    };
    const phrase = buildApplyConfirmationPhrase(expected);
    expect(phrase).toBe("APPLY 123456789012 us-east-1 nusend-prod core");
    expect(phrase.startsWith(APPLY_PHRASE_PREFIX)).toBe(true);
    expect(() => validateApplyConfirmation(phrase, expected)).not.toThrow();
    expect(() => validateApplyConfirmation("APPLY wrong", expected)).toThrow(
      /Confirmation rejected/,
    );
  });

  it("rejects blank and fabricated production-access answers", () => {
    expect(isFabricatedPlaceholder("")).toBe(true);
    expect(isFabricatedPlaceholder("n/a")).toBe(true);
    expect(isFabricatedPlaceholder("TODO")).toBe(true);
    expect(isFabricatedPlaceholder("https://example.com")).toBe(true);
    expect(isFabricatedPlaceholder("xxx")).toBe(true);
    expect(isFabricatedPlaceholder("We send order receipts to paying customers only.")).toBe(false);

    const valid = validBrief();
    expect(validateProductionBrief(valid).mailType).toBe("TRANSACTIONAL");
    expect(validateProductionBrief(valid).website).toBe("https://shop.northwindtraders.com");
    expect(() => validateProductionBrief({ ...valid, website: "" })).toThrow(/website/);
    expect(() => validateProductionBrief({ ...valid, website: "https://example.com" })).toThrow(
      /fabricated|example/,
    );
    expect(() =>
      validateProductionBrief({ ...valid, website: "https://shop.contoso-mail.test" }),
    ).toThrow(/reserved|\.test/);
    expect(() => validateProductionBrief({ ...valid, website: "https://app.invalid" })).toThrow(
      /reserved|\.invalid/,
    );
    expect(() => validateProductionBrief({ ...valid, website: "https://app.localhost" })).toThrow(
      /localhost/,
    );
    expect(() => assertHonestWebsiteUrl("https://docs.example.org")).toThrow(/example/);
    expect(() => validateProductionBrief({ ...valid, useCase: "tbd" })).toThrow(/fabricated/);
    expect(() => validateProductionBrief({ ...valid, mailType: "OTHER" })).toThrow(/TRANSACTIONAL/);
  });

  it("parses change-set ARNs and classifies stack statuses", () => {
    const parsed = parseChangeSetArn(
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/abc",
    );
    expect(parsed).toMatchObject({
      partition: "aws",
      region: "us-east-1",
      accountId: "123456789012",
      changeSetName: "nusend-prod-core",
      changeSetUniqueId: "abc",
    });
    expect(() => parseChangeSetArn("not-an-arn")).toThrow(/malformed/);
    expect(isActiveStackStatus("UPDATE_IN_PROGRESS")).toBe(true);
    expect(isActiveStackStatus("REVIEW_IN_PROGRESS")).toBe(true);
    expect(isActiveStackStatus("CREATE_COMPLETE")).toBe(false);
    expect(isHealthyTerminalStackStatus("CREATE_COMPLETE")).toBe(true);
    expect(isHealthyTerminalStackStatus("UPDATE_ROLLBACK_COMPLETE")).toBe(false);
  });

  it("detects identity/DKIM readiness and no-change change sets", () => {
    expect(
      isIdentityReady({
        VerificationStatus: "SUCCESS",
        VerifiedForSendingStatus: true,
      }),
    ).toBe(true);
    expect(
      isIdentityReady({
        VerificationStatus: "PENDING",
        VerifiedForSendingStatus: true,
      }),
    ).toBe(false);
    expect(
      isDkimReady({
        DkimAttributes: { Status: "SUCCESS", SigningEnabled: true },
      }),
    ).toBe(true);
    expect(
      isDkimReady({
        DkimAttributes: { Status: "PENDING", SigningEnabled: true },
      }),
    ).toBe(false);
    expect(
      isNoChangeChangeSet({
        Status: "FAILED",
        StatusReason: "The submitted information didn't contain changes.",
        Changes: [],
      }),
    ).toBe(true);
  });

  it("summarizes change sets with replacement and IAM signals", () => {
    const summary = summarizeChangeSet({
      Status: "CREATE_COMPLETE",
      ChangeSetId: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/abc",
      StackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/nusend-prod/xyz",
      StackName: "nusend-prod",
      Capabilities: [REQUIRED_CAPABILITY],
      Changes: [
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
            Action: "Modify",
            LogicalResourceId: "FeedbackTopic",
            ResourceType: "AWS::SNS::Topic",
            Replacement: "True",
          },
        },
      ],
    });
    expect(summary.resourceCount).toBe(2);
    expect(summary.replacements).toBe(1);
    expect(summary.iamChanges).toBe(1);
    expect(summary.capabilities).toContain(REQUIRED_CAPABILITY);
  });

  it("maps known non-secret outputs into env and formats DKIM records", () => {
    const state = sampleState("prod");
    const outputs = {
      AwsRegion: "us-east-1",
      SesFromEmail: "sender@example.com",
      TransactionalConfigurationSetName: "nusend-prod-transactional",
      MarketingConfigurationSetName: "",
      FeedbackTopicArn: "arn:aws:sns:us-east-1:123456789012:topic",
      TrackingEvents: "",
      RuntimeUserName: "nusend-prod-runtime",
      DkimRecordName1: "token1._domainkey.example.com",
      DkimRecordValue1: "token1.dkim.amazonses.com",
      DkimRecordName2: "token2._domainkey.example.com",
      DkimRecordValue2: "token2.dkim.amazonses.com",
      DkimRecordName3: "token3._domainkey.example.com",
      DkimRecordValue3: "token3.dkim.amazonses.com",
    };
    expect(mapStackOutputsToEnv(outputs, state)).toEqual({
      AWS_REGION: "us-east-1",
      NUSEND_SES_FROM_EMAIL: "sender@example.com",
      NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "nusend-prod-transactional",
      NUSEND_SES_FEEDBACK_TOPIC_ARNS: "arn:aws:sns:us-east-1:123456789012:topic",
    });
    expect(formatDkimRecords(outputs)).toHaveLength(3);
  });

  it("bounds failed stack event diagnostics without env dumps", () => {
    const failed = summarizeFailedStackEvents({
      StackEvents: [
        {
          LogicalResourceId: "RuntimeUser",
          ResourceStatus: "CREATE_FAILED",
          ResourceStatusReason: "Limit exceeded",
        },
        {
          LogicalResourceId: "Stack",
          ResourceStatus: "CREATE_IN_PROGRESS",
          ResourceStatusReason: "ok",
        },
      ],
    });
    expect(failed).toEqual([
      {
        logicalId: "RuntimeUser",
        status: "CREATE_FAILED",
        reason: "Limit exceeded",
        timestamp: "",
      },
    ]);
  });

  it("builds argv arrays with explicit profile and region and no shell", () => {
    const state = sampleState("prod");
    const args = awsArgv(state, ["sts", "get-caller-identity", "--output", "json"]);
    expect(args).toEqual([
      "sts",
      "get-caller-identity",
      "--output",
      "json",
      "--profile",
      "nusend-provisioner",
      "--region",
      "us-east-1",
    ]);
    expect(args.every((part) => typeof part === "string")).toBe(true);
  });
});

describe("aws plan", () => {
  it("hard-fails on expected account mismatch and never creates a change set", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const calls: string[][] = [];
    await expect(
      runAwsPlan({
        env,
        io: testIo(),
        executor: async ({ command, args }) => {
          calls.push([command, ...args]);
          assertAwsProfileRegion(args);
          if (args[0] === "sts") {
            return ok(
              JSON.stringify({
                Account: "999999999999",
                Arn: "arn:aws:iam::999999999999:user/x",
              }),
            );
          }
          throw new Error(`unexpected: ${[command, ...args].join(" ")}`);
        },
      }),
    ).rejects.toThrow(/account mismatch/i);
    expect(calls.some((c) => c.includes("create-change-set"))).toBe(false);
  });

  it("plans CREATE, prints sanitized summary with IAM capability, and persists plan metadata only", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const logs: string[] = [];
    const calls: string[][] = [];
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/abc";

    await runAwsPlan({
      env,
      io: testIo({ log: (line) => logs.push(line) }),
      executor: fakeAwsExecutor({
        calls,
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
      }),
    });

    expect(calls.some((c) => c.includes("validate-template"))).toBe(true);
    expect(calls.some((c) => c.includes("create-change-set"))).toBe(true);
    expect(calls.some((c) => c.includes(REQUIRED_CAPABILITY))).toBe(true);
    expect(calls.some((c) => c.includes("CREATE"))).toBe(true);
    for (const call of calls.filter((c) => c[0] === "aws")) {
      assertAwsProfileRegion(call.slice(1));
      // argv array only — never a shell wrapper
      expect(call[0]).toBe("aws");
      expect(call.some((part) => part === "sh" || part === "bash" || part === "-c")).toBe(false);
    }

    const state = await loadState("prod", env);
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

    const logText = logs.join("\n");
    expect(logText).toMatch(/CAPABILITY_NAMED_IAM/);
    expect(logText).toMatch(/RuntimeUser/);
    expect(logText).not.toMatch(/SecretAccessKey/);
  });

  it("refuses a fresh same-name core stack collision before any change-set mutation", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const calls: string[][] = [];

    await expect(
      runAwsPlan({
        env,
        io: testIo(),
        executor: fakeAwsExecutor({ calls, stackExists: true }),
      }),
    ).rejects.toThrow(/collision|core CREATE provenance|Refusing to adopt/i);
    expect(calls.some((call) => call.includes("delete-change-set"))).toBe(false);
    expect(calls.some((call) => call.includes("create-change-set"))).toBe(false);
    expect((await loadState("prod", env)).plans.aws).toBeUndefined();
  });

  it("plans UPDATE for an existing core stack only with exact coordinator CREATE provenance", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const logs: string[] = [];
    const calls: string[][] = [];
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/upd";

    await runAwsPlan({
      env,
      io: testIo({ log: (line) => logs.push(line) }),
      executor: fakeAwsExecutor({
        calls,
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
      }),
    });

    expect(calls.some((c) => c.includes("UPDATE"))).toBe(true);
    expect(logs.join("\n")).toMatch(/replaced/i);
    const state = await loadState("prod", env);
    expect(state.plans.aws.changeSetType).toBe("UPDATE");
  });

  it("rejects mismatched immutable core CREATE provenance", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const state = await loadState("prod", env);
    await writeState(
      {
        ...state,
        aws: {
          ...state.aws,
          stackCreation: { ...state.aws?.stackCreation, region: "us-west-2" },
        },
      },
      env,
    );
    const calls: string[][] = [];
    await expect(
      runAwsPlan({
        env,
        io: testIo(),
        executor: fakeAwsExecutor({ calls, stackExists: true }),
      }),
    ).rejects.toThrow(/collision|exact coordinator core CREATE provenance/i);
    expect(calls.some((call) => call.includes("delete-change-set"))).toBe(false);
    expect(calls.some((call) => call.includes("create-change-set"))).toBe(false);
  });

  it("handles no-change change sets explicitly only for a proven existing stack", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const logs: string[] = [];
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/none";

    await runAwsPlan({
      env,
      io: testIo({ log: (line) => logs.push(line) }),
      executor: fakeAwsExecutor({
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
      }),
    });

    const state = await loadState("prod", env);
    expect(state.plans.aws.noChange).toBe(true);
    expect(logs.join("\n")).toMatch(/NO_CHANGES/);
  });

  it("deletes abandoned prior change sets on re-plan", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const priorArn = "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/old";
    const state = await loadState("prod", env);
    await writeState(
      {
        ...state,
        plans: {
          aws: {
            changeSetArn: priorArn,
            stackName: "nusend-prod",
            phase: "core",
          },
        },
      },
      env,
    );

    const calls: string[][] = [];
    const newArn = "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/new";
    await runAwsPlan({
      env,
      io: testIo(),
      executor: fakeAwsExecutor({
        calls,
        stackExists: false,
        changeSetArn: newArn,
        changeSet: createChangeSetDescription({
          changeSetArn: newArn,
          status: "CREATE_COMPLETE",
          changes: [],
        }),
      }),
    });

    const deletes = calls.filter((c) => c.includes("delete-change-set"));
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(deletes.some((c) => c.includes(priorArn) || c.includes("nusend-prod-core"))).toBe(true);
  });

  it("refuses planning while the stack has an active/nonstable status", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const calls: string[][] = [];
    await expect(
      runAwsPlan({
        env,
        io: testIo(),
        executor: fakeAwsExecutor({
          calls,
          stackExists: true,
          stackStatus: "UPDATE_IN_PROGRESS",
        }),
      }),
    ).rejects.toThrow(/UPDATE_IN_PROGRESS|in-progress/i);
    expect(calls.some((c) => c.includes("create-change-set"))).toBe(false);

    await expect(
      runAwsPlan({
        env,
        io: testIo(),
        executor: fakeAwsExecutor({
          stackExists: true,
          stackStatus: "REVIEW_IN_PROGRESS",
        }),
      }),
    ).rejects.toThrow(/REVIEW_IN_PROGRESS|in-progress/i);
  });
});

describe("aws apply", () => {
  it("rejects missing, stale account/region, and fingerprint-mismatched plans", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");

    await expect(
      runAwsApply({
        env,
        io: testIo(),
        executor: fakeAwsExecutor({}),
      }),
    ).rejects.toThrow(/No stored AWS plan/);

    const base = await loadState("prod", env);
    await writeState(
      {
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
      },
      env,
    );
    await expect(
      runAwsApply({
        env,
        io: testIo({ prompt: async () => "nope" }),
        executor: fakeAwsExecutor({}),
      }),
    ).rejects.toThrow(/region/i);

    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const params = buildStackParameters(base, "core");
    const fingerprint = fingerprintTemplateAndParameters(template, params, {
      stackName: "nusend-prod",
      phase: "core",
    });
    await writeState(
      {
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
      },
      env,
    );
    await expect(
      runAwsApply({
        env,
        io: testIo({
          prompt: async () =>
            buildApplyConfirmationPhrase({
              accountId: "123456789012",
              region: "us-east-1",
              stackName: "nusend-prod",
              phase: "core",
            }),
        }),
        executor: fakeAwsExecutor({}),
      }),
    ).rejects.toThrow(/fingerprint/i);
  });

  it("executes only the stored ARN after exact phrase and maps outputs into env", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/apply";
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const base = await loadState("prod", env);
    const params = buildStackParameters(base, "core");
    const fingerprint = fingerprintTemplateAndParameters(template, params, {
      stackName: "nusend-prod",
      phase: "core",
    });
    await writeState(
      {
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
      },
      env,
    );

    const calls: string[][] = [];
    const logs: string[] = [];
    await runAwsApply({
      env,
      io: testIo({
        log: (line) => logs.push(line),
        prompt: async () =>
          buildApplyConfirmationPhrase({
            accountId: "123456789012",
            region: "us-east-1",
            stackName: "nusend-prod",
            phase: "core",
          }),
      }),
      executor: fakeAwsExecutor({
        calls,
        stackExists: true,
        stackOutputs: sampleOutputs(),
        identity: readyIdentity(),
      }),
    });

    const execute = calls.find((c) => c.includes("execute-change-set"));
    expect(execute).toBeTruthy();
    expect(execute?.includes(changeSetArn)).toBe(true);
    expect(execute?.includes("--profile")).toBe(true);
    expect(execute?.includes("--region")).toBe(true);

    const deployment = await loadDeploymentEnv("prod", env);
    expect(deployment.NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET).toBe("nusend-prod-transactional");
    expect(deployment.NUSEND_SES_FEEDBACK_TOPIC_ARNS).toBe(
      "arn:aws:sns:us-east-1:123456789012:nusend-prod-ses-events",
    );
    expect(deployment.AWS_REGION).toBe("us-east-1");

    const state = await loadState("prod", env);
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
    expect(logs.join("\n")).toMatch(/DKIM CNAME/);
    expect(logs.join("\n")).toMatch(/token1\._domainkey\.example\.com/);
    expect(JSON.stringify(state)).not.toMatch(/SecretAccessKey|super-secret/);
  });

  it("skips execute on recorded no-change path and still refreshes ownership/outputs", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const base = await loadState("prod", env);
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/none";
    await writeState(
      {
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
      },
      env,
    );
    const calls: string[][] = [];
    await runAwsApply({
      env,
      io: testIo({
        prompt: async () =>
          buildApplyConfirmationPhrase({
            accountId: "123456789012",
            region: "us-east-1",
            stackName: "nusend-prod",
            phase: "core",
          }),
      }),
      executor: fakeAwsExecutor({
        calls,
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
      }),
    });
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    const state = await loadState("prod", env);
    expect(state.aws?.stack?.outputs).toMatchObject({
      RuntimeUserName: "nusend-prod-runtime",
    });
  });

  it("prints bounded rollback diagnostics without env contents or secrets on stack failure", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/fail";
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const base = await loadState("prod", env);
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    await writeState(
      {
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
      },
      env,
    );

    let message = "";
    try {
      await runAwsApply({
        env,
        io: testIo({
          prompt: async () =>
            buildApplyConfirmationPhrase({
              accountId: "123456789012",
              region: "us-east-1",
              stackName: "nusend-prod",
              phase: "core",
            }),
        }),
        executor: fakeAwsExecutor({
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
        }),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/RuntimeUser[\s\S]*CREATE_FAILED[\s\S]*Name already exists/);
    expect(message).not.toMatch(
      /BETTER_AUTH_SECRET|google-client-secret|SecretAccessKey|restic-password/i,
    );
  });

  it("rejects consumed plans immediately before prompt or provider mutation", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState("prod", env);
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    await writeState(
      {
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
      },
      env,
    );

    let prompted = 0;
    const calls: string[][] = [];
    await expect(
      runAwsApply({
        env,
        io: testIo({
          prompt: async () => {
            prompted += 1;
            return "should-not-run";
          },
        }),
        executor: fakeAwsExecutor({ calls }),
      }),
    ).rejects.toThrow(/already consumed/i);
    expect(prompted).toBe(0);
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
    expect(calls.some((c) => c.includes("describe-change-set"))).toBe(false);
  });

  it("rejects core/finalize phase mismatches against determinePhase(state)", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState("prod", env);
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const finalizeFingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "finalize"),
      { stackName: "nusend-prod", phase: "finalize" },
    );

    // finalize plan while aws_core is incomplete (current phase = core)
    await writeState(
      {
        ...base,
        plans: {
          aws: validApplyPlan({
            fingerprint: finalizeFingerprint,
            phase: "finalize",
          }),
        },
      },
      env,
    );
    await expect(
      runAwsApply({
        env,
        io: testIo({ prompt: async () => "nope" }),
        executor: fakeAwsExecutor({}),
      }),
    ).rejects.toThrow(/phase "finalize".*phase "core"/i);

    // core plan after aws_core complete (current phase = finalize)
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
    await writeState(
      {
        ...withCore,
        plans: {
          aws: validApplyPlan({
            fingerprint: coreFingerprint,
            phase: "core",
          }),
        },
      },
      env,
    );
    await expect(
      runAwsApply({
        env,
        io: testIo({ prompt: async () => "nope" }),
        executor: fakeAwsExecutor({}),
      }),
    ).rejects.toThrow(/phase "core".*phase "finalize"/i);
  });

  it("rejects stored account mismatch and change-set ARN/stack/status mismatches before execute", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState("prod", env);
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );

    await writeState(
      {
        ...base,
        plans: {
          aws: validApplyPlan({
            fingerprint,
            accountId: "111111111111",
            changeSetArn:
              "arn:aws:cloudformation:us-east-1:111111111111:changeSet/nusend-prod-core/x",
          }),
        },
      },
      env,
    );
    await expect(
      runAwsApply({
        env,
        io: testIo({ prompt: async () => "nope" }),
        executor: fakeAwsExecutor({}),
      }),
    ).rejects.toThrow(/account/i);

    const wrongAccountArn =
      "arn:aws:cloudformation:us-east-1:999999999999:changeSet/nusend-prod-core/x";
    await writeState(
      {
        ...base,
        plans: {
          aws: validApplyPlan({
            fingerprint,
            changeSetArn: wrongAccountArn,
          }),
        },
      },
      env,
    );
    let calls: string[][] = [];
    await expect(
      runAwsApply({
        env,
        io: testIo({
          prompt: async () =>
            buildApplyConfirmationPhrase({
              accountId: "123456789012",
              region: "us-east-1",
              stackName: "nusend-prod",
              phase: "core",
            }),
        }),
        executor: fakeAwsExecutor({ calls }),
      }),
    ).rejects.toThrow(/Change set ARN account/i);
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);

    const goodArn = "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/bind";
    await writeState(
      {
        ...base,
        plans: {
          aws: validApplyPlan({
            fingerprint,
            changeSetArn: goodArn,
            stackId: stackIdFor("nusend-prod"),
          }),
        },
      },
      env,
    );
    calls = [];
    await expect(
      runAwsApply({
        env,
        io: testIo({
          prompt: async () =>
            buildApplyConfirmationPhrase({
              accountId: "123456789012",
              region: "us-east-1",
              stackName: "nusend-prod",
              phase: "core",
            }),
        }),
        executor: fakeAwsExecutor({
          calls,
          changeSetArn: goodArn,
          changeSet: createChangeSetDescription({
            changeSetArn: goodArn,
            status: "CREATE_COMPLETE",
            changes: [],
            stackId: stackIdFor("nusend-prod-REPLACED"),
            stackName: "nusend-prod",
          }),
        }),
      }),
    ).rejects.toThrow(/stack id|same-name replacement/i);
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);

    calls = [];
    await expect(
      runAwsApply({
        env,
        io: testIo({
          prompt: async () =>
            buildApplyConfirmationPhrase({
              accountId: "123456789012",
              region: "us-east-1",
              stackName: "nusend-prod",
              phase: "core",
            }),
        }),
        executor: fakeAwsExecutor({
          calls,
          changeSetArn: goodArn,
          changeSet: createChangeSetDescription({
            changeSetArn: goodArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: "OBSOLETE",
          }),
        }),
      }),
    ).rejects.toThrow(/OBSOLETE/i);
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
  });

  it("executes AVAILABLE change sets and resumes EXECUTE_IN_PROGRESS / EXECUTE_COMPLETE without re-executing", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState("prod", env);
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const availableArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/available";
    await writeState(
      {
        ...base,
        plans: {
          aws: validApplyPlan({
            fingerprint,
            changeSetArn: availableArn,
          }),
        },
      },
      env,
    );

    const availableCalls: string[][] = [];
    await runAwsApply({
      env,
      io: testIo({
        prompt: async () =>
          buildApplyConfirmationPhrase({
            accountId: "123456789012",
            region: "us-east-1",
            stackName: "nusend-prod",
            phase: "core",
          }),
      }),
      executor: fakeAwsExecutor({
        calls: availableCalls,
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
      }),
    });
    expect(availableCalls.filter((c) => c.includes("execute-change-set")).length).toBe(1);

    await expectExecutionStatusResume("EXECUTE_IN_PROGRESS", fingerprint);
    await expectExecutionStatusResume("EXECUTE_COMPLETE", fingerprint);
  });

  it("rechecks finalize subscription absence before execution but resumes an executed change set", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const base = await loadState("prod", env);
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
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(finalizeState, "finalize"),
      { stackName: "nusend-prod", phase: "finalize" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-finalize/race";
    await writeState(
      {
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
      },
      env,
    );
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

    const raceCalls: string[][] = [];
    await expect(
      runAwsApply({
        env,
        io: testIo({ prompt: async () => phrase }),
        executor: fakeAwsExecutor({
          calls: raceCalls,
          changeSetArn,
          feedbackSubscriptions: [confirmed],
          changeSet: createChangeSetDescription({
            changeSetArn,
            status: "CREATE_COMPLETE",
            changes: [],
            executionStatus: "AVAILABLE",
          }),
        }),
      }),
    ).rejects.toThrow(/pre-existing HTTPS subscription/i);
    expect(raceCalls.some((call) => call.includes("list-subscriptions-by-topic"))).toBe(true);
    expect(raceCalls.some((call) => call.includes("execute-change-set"))).toBe(false);

    const resumeCalls: string[][] = [];
    await runAwsApply({
      env,
      io: testIo({ prompt: async () => phrase }),
      executor: fakeAwsExecutor({
        calls: resumeCalls,
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
      }),
    });
    expect(resumeCalls.some((call) => call.includes("execute-change-set"))).toBe(false);
    expect(resumeCalls.some((call) => call.includes("get-subscription-attributes"))).toBe(true);
    const finalized = await loadState("prod", env);
    expect(finalized.plans.aws.consumed).toBe(true);
    expect(finalized.aws?.stack?.changeSetType).toBe("UPDATE");
    expect(finalized.aws?.stackCreation).toMatchObject({
      provenance: "coordinator-reviewed-change-set",
      phase: "core",
      changeSetType: "CREATE",
      stackId: stackIdFor("nusend-prod"),
    });
  });

  it("recovers from ambiguous execute errors when live execution is already in progress/complete", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState("prod", env);
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/ambiguous";
    await writeState(
      {
        ...base,
        plans: {
          aws: validApplyPlan({
            fingerprint,
            changeSetArn,
          }),
        },
      },
      env,
    );

    const calls: string[][] = [];
    let describeCount = 0;
    await runAwsApply({
      env,
      io: testIo({
        prompt: async () =>
          buildApplyConfirmationPhrase({
            accountId: "123456789012",
            region: "us-east-1",
            stackName: "nusend-prod",
            phase: "core",
          }),
      }),
      executor: fakeAwsExecutor({
        calls,
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
      }),
    });
    expect(calls.some((c) => c.includes("execute-change-set"))).toBe(true);
    expect(describeCount).toBeGreaterThanOrEqual(2);
    const state = await loadState("prod", env);
    expect(state.plans.aws.consumed).toBe(true);
  });

  it("checkpoints after provider success so a local env failure can rerun without provider mutation", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    const base = await loadState("prod", env);
    const template = await readFile(join(process.cwd(), "deploy/aws/nusend-stack.json"), "utf8");
    const fingerprint = fingerprintTemplateAndParameters(
      template,
      buildStackParameters(base, "core"),
      { stackName: "nusend-prod", phase: "core" },
    );
    const changeSetArn =
      "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/durable";
    await writeState(
      {
        ...base,
        plans: {
          aws: validApplyPlan({
            fingerprint,
            changeSetArn,
          }),
        },
      },
      env,
    );

    const firstCalls: string[][] = [];
    await expect(
      runAwsApply({
        env,
        io: testIo({
          prompt: async () =>
            buildApplyConfirmationPhrase({
              accountId: "123456789012",
              region: "us-east-1",
              stackName: "nusend-prod",
              phase: "core",
            }),
        }),
        executor: fakeAwsExecutor({
          calls: firstCalls,
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
        }),
        afterProviderCheckpoint: async () => {
          throw new Error("simulated local env failure");
        },
      } as any),
    ).rejects.toThrow(/simulated local env failure/);

    expect(firstCalls.some((c) => c.includes("execute-change-set"))).toBe(true);
    const crashed = await loadState("prod", env);
    expect(crashed.plans.aws.consumed).not.toBe(true);
    expect(crashed.plans.aws.providerApplied).toBe(true);
    expect(crashed.plans.aws.applyCheckpoint).toBe(APPLY_CHECKPOINT_LOCAL_FINALIZATION);
    expect(crashed.aws?.stack?.stackId).toBe(stackIdFor("nusend-prod"));
    const crashedDeployment = await loadDeploymentEnv("prod", env);
    expect(crashedDeployment.NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET ?? "").toBe("");

    const resumeCalls: string[][] = [];
    await runAwsApply({
      env,
      io: testIo({
        prompt: async () => {
          throw new Error("prompt should not run on local-finalization resume");
        },
      }),
      executor: fakeAwsExecutor({
        calls: resumeCalls,
        stackExists: true,
        stackOutputs: sampleOutputs(),
        identity: readyIdentity(),
      }),
    });

    expect(resumeCalls.some((c) => c.includes("execute-change-set"))).toBe(false);
    const deployment = await loadDeploymentEnv("prod", env);
    expect(deployment.NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET).toBe("nusend-prod-transactional");
    const finished = await loadState("prod", env);
    expect(finished.plans.aws.consumed).toBe(true);
    expect(finished.aws?.stack?.stackId).toBe(stackIdFor("nusend-prod"));

    await expect(
      runAwsApply({
        env,
        io: testIo({ prompt: async () => "nope" }),
        executor: fakeAwsExecutor({}),
      }),
    ).rejects.toThrow(/already consumed/i);
  });
});

describe("DKIM, production access, runtime key, continue gates", () => {
  it("blocks aws core while DKIM/identity pending and passes when ready with runtime key", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");

    await expect(
      runAwsCoreVerification(
        {
          env,
          io: testIo(),
          executor: fakeAwsExecutor({
            stackExists: true,
            stackOutputs: sampleOutputs(),
            identity: pendingIdentity(),
          }),
        },
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/identity verification is not ready|DKIM is not ready/i);

    const logs: string[] = [];
    const secret = "runtime-secret-value-DO-NOT-LOG";
    const accessKeyId = "AKIAEXAMPLECORE0001";
    const evidence = await runAwsCoreVerification(
      {
        env,
        io: testIo({
          log: (line) => logs.push(line),
          prompt: async (message) => {
            if (message.includes(CREATE_RUNTIME_KEY_PHRASE)) return CREATE_RUNTIME_KEY_PHRASE;
            if (message.includes("production-access")) return "n";
            return "";
          },
        }),
        executor: fakeAwsExecutor({
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
        }),
      },
      await loadState("prod", env),
    );

    expect(evidence.verified).toBe(true);
    expect(evidence.runtimeAccessKeyId).toBe(accessKeyId);
    const deployment = await loadDeploymentEnv("prod", env);
    expect(deployment.AWS_ACCESS_KEY_ID).toBe(accessKeyId);
    expect(deployment.AWS_SECRET_ACCESS_KEY).toBe(secret);
    const stateText = await readFile(stateFilePath("prod", env), "utf8");
    expect(stateText).toContain(accessKeyId);
    expect(stateText).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain(accessKeyId);
  });

  it("refuses runtime key creation when any key already exists", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    await expect(
      runCreateRuntimeKey(
        {
          env,
          io: testIo({ prompt: async () => CREATE_RUNTIME_KEY_PHRASE }),
          executor: fakeAwsExecutor({
            stackExists: true,
            accessKeys: [{ AccessKeyId: "AKIAEXISTING", Status: "Active" }],
          }),
        },
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/already has .* access key/i);
  });

  it("requires exact CREATE-RUNTIME-KEY phrase and inserts id+secret atomically", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const secret = "atomic-runtime-secret-value";
    const accessKeyId = "AKIAEXAMPLEATOMIC01";

    await expect(
      runCreateRuntimeKey(
        {
          env,
          io: testIo({ prompt: async () => "WRONG" }),
          executor: fakeAwsExecutor({
            accessKeys: [],
            createdAccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: secret },
          }),
        },
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/Confirmation rejected/);

    await runCreateRuntimeKey(
      {
        env,
        io: testIo({ prompt: async () => CREATE_RUNTIME_KEY_PHRASE }),
        executor: fakeAwsExecutor({
          accessKeys: [],
          createdAccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: secret },
        }),
      },
      await loadState("prod", env),
    );

    const deployment = await loadDeploymentEnv("prod", env);
    expect(deployment.AWS_ACCESS_KEY_ID).toBe(accessKeyId);
    expect(deployment.AWS_SECRET_ACCESS_KEY).toBe(secret);
    const state = await loadState("prod", env);
    expect(state.aws?.runtimeAccessKeyId).toBe(accessKeyId);
    expect(JSON.stringify(state)).not.toContain(secret);

    await expect(
      runCreateRuntimeKey(
        {
          env,
          io: testIo({ prompt: async () => CREATE_RUNTIME_KEY_PHRASE }),
          executor: fakeAwsExecutor({ accessKeys: [] }),
        },
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/already recorded|manual rotation/i);
  });

  it("submits production access only with exact phrase, rejects blanks, and never resubmits pending", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod");
    await writeAppliedStackState(env, "prod");
    const calls: string[][] = [];

    await expect(
      runProductionAccessRequest(
        {
          env,
          io: testIo(),
          executor: fakeAwsExecutor({
            calls,
            account: {
              ProductionAccessEnabled: false,
              Details: { ReviewDetails: { Status: "NONE" } },
            },
          }),
        },
        await loadState("prod", env),
        {
          submitEnabled: true,
          brief: { ...validBrief(), website: "https://example.com" },
          confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE,
        },
      ),
    ).rejects.toThrow(/fabricated|website/i);
    expect(calls.some((c) => c.includes("put-account-details"))).toBe(false);

    await runProductionAccessRequest(
      {
        env,
        io: testIo(),
        executor: fakeAwsExecutor({
          calls,
          account: {
            ProductionAccessEnabled: false,
            Details: { ReviewDetails: { Status: "NONE" } },
          },
        }),
      },
      await loadState("prod", env),
      {
        submitEnabled: true,
        brief: validBrief(),
        confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE,
      },
    );
    expect(calls.some((c) => c.includes("put-account-details"))).toBe(true);
    expect(calls.some((c) => c.includes(REQUEST_PRODUCTION_ACCESS_PHRASE))).toBe(false);
    const put = calls.find((c) => c.includes("put-account-details"));
    assertAwsProfileRegion(put!.slice(1));

    const pendingCalls: string[][] = [];
    const pending = await runProductionAccessRequest(
      {
        env,
        io: testIo(),
        executor: fakeAwsExecutor({
          calls: pendingCalls,
          account: {
            ProductionAccessEnabled: false,
            Details: { ReviewDetails: { Status: "PENDING" } },
          },
        }),
      },
      await loadState("prod", env),
      { submitEnabled: true, brief: validBrief(), confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE },
    );
    expect(pending.status).toBe("pending");
    expect(pendingCalls.some((c) => c.includes("put-account-details"))).toBe(false);

    const approved = await runProductionAccessRequest(
      {
        env,
        io: testIo(),
        executor: fakeAwsExecutor({
          account: {
            ProductionAccessEnabled: true,
            Details: { ReviewDetails: { Status: "GRANTED" } },
          },
        }),
      },
      await loadState("prod", env),
      { submitEnabled: true, brief: validBrief(), confirmation: REQUEST_PRODUCTION_ACCESS_PHRASE },
    );
    expect(approved.status).toBe("approved");
  });
});

// --- helpers ---

function testEnv() {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-aws-"));
  temporaryDirectories.push(directory);
  return { NUSEND_SETUP_HOME: directory, HOME: directory };
}

function testIo(
  overrides: {
    log?: (line: string) => void;
    error?: (line: string) => void;
    prompt?: (message: string) => Promise<string>;
    promptSecret?: (message: string) => Promise<string>;
  } = {},
) {
  return {
    prompt: overrides.prompt ?? (async () => ""),
    promptSecret: overrides.promptSecret ?? (async () => ""),
    log: overrides.log ?? (() => undefined),
    error: overrides.error ?? (() => undefined),
  };
}

function ok(stdout: string, exitCode = 0, stderr = "") {
  return {
    exitCode,
    signal: null as null,
    stdout,
    stderr,
    argv: [] as string[],
  };
}

function sampleState(installationId: string) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1 as const,
    installationId,
    createdAt: now,
    updatedAt: now,
    config: {
      releaseTag: "v0.1.1",
      domain: "mail.example.com",
      ingressMode: "direct" as const,
      ownerEmail: "owner@example.com",
      ownerName: "Owner",
      awsProfile: "nusend-provisioner",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesIdentity: "example.com",
      sesFromEmail: "sender@example.com",
      marketingEnabled: false,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      installationName: installationId,
    },
    stages: {
      init: {
        status: "complete" as const,
        completedAt: now,
        evidence: { verified: true, installationId },
      },
    },
    plans: {},
  };
}

async function seedInstallation(env: { NUSEND_SETUP_HOME: string }, installationId: string) {
  await writeState(sampleState(installationId), env);
  await writeDeploymentEnv(
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
  await writeCurrentPointer(installationId, env);
}

async function writeAppliedStackState(env: { NUSEND_SETUP_HOME: string }, installationId: string) {
  const state = await loadState(installationId, env);
  await writeState(
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
  const deployment = await loadDeploymentEnv(installationId, env);
  await writeDeploymentEnv(
    installationId,
    {
      ...deployment,
      ...mapStackOutputsToEnv(sampleOutputs(), state),
    },
    env,
  );
}

function stackIdFor(stackName: string) {
  return `arn:aws:cloudformation:us-east-1:123456789012:stack/${stackName}/00000000-0000-0000-0000-000000000001`;
}

function sampleOutputs() {
  return {
    AwsRegion: "us-east-1",
    SesFromEmail: "sender@example.com",
    TransactionalConfigurationSetName: "nusend-prod-transactional",
    MarketingConfigurationSetName: "",
    FeedbackTopicArn: "arn:aws:sns:us-east-1:123456789012:nusend-prod-ses-events",
    TrackingEvents: "",
    RuntimeUserName: "nusend-prod-runtime",
    DlqUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/dlq",
    DlqArn: "arn:aws:sqs:us-east-1:123456789012:dlq",
    DlqName: "nusend-prod-ses-webhook-dlq",
    AlarmTopicArn: "arn:aws:sns:us-east-1:123456789012:alarms",
    DkimRecordName1: "token1._domainkey.example.com",
    DkimRecordValue1: "token1.dkim.amazonses.com",
    DkimRecordName2: "token2._domainkey.example.com",
    DkimRecordValue2: "token2.dkim.amazonses.com",
    DkimRecordName3: "token3._domainkey.example.com",
    DkimRecordValue3: "token3.dkim.amazonses.com",
  };
}

function readyIdentity() {
  return {
    VerificationStatus: "SUCCESS",
    VerifiedForSendingStatus: true,
    DkimAttributes: {
      Status: "SUCCESS",
      SigningEnabled: true,
    },
  };
}

function pendingIdentity() {
  return {
    VerificationStatus: "PENDING",
    VerifiedForSendingStatus: false,
    DkimAttributes: {
      Status: "PENDING",
      SigningEnabled: true,
    },
  };
}

function validBrief() {
  return {
    website: "https://shop.northwindtraders.com",
    useCase: "Transactional order receipts and password resets for paying customers.",
    mailType: "TRANSACTIONAL",
    expectedVolume: "about 20_000 messages per month",
    frequency: "continuous low-volume transactional bursts",
    recipientConsent: "Collected at checkout with explicit order-notification consent.",
    unsubscribe: "One-click List-Unsubscribe plus account preference center.",
    bounceComplaintHandling: "SNS webhook into Nusend suppressions within minutes.",
    formAbuseControls: "Authenticated API only; no public unauthenticated send forms.",
    monitoring: "CloudWatch alarms plus daily complaint rate review.",
    contactLanguage: "EN",
  };
}

function validApplyPlan(overrides: Record<string, unknown> = {}) {
  return {
    changeSetArn: "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/apply",
    changeSetName: "nusend-prod-core",
    stackName: "nusend-prod",
    stackId: stackIdFor("nusend-prod"),
    phase: "core",
    changeSetType: "CREATE",
    accountId: "123456789012",
    partition: "aws",
    region: "us-east-1",
    noChange: false,
    ...overrides,
  };
}

async function expectExecutionStatusResume(
  executionStatus: "EXECUTE_IN_PROGRESS" | "EXECUTE_COMPLETE",
  fingerprint: string,
) {
  const resumeEnv = testEnv();
  await seedInstallation(resumeEnv, "prod");
  const resumeBase = await loadState("prod", resumeEnv);
  const resumeArn = `arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/${executionStatus.toLowerCase()}`;
  await writeState(
    {
      ...resumeBase,
      plans: {
        aws: validApplyPlan({
          fingerprint,
          changeSetArn: resumeArn,
        }),
      },
    },
    resumeEnv,
  );
  const calls: string[][] = [];
  await runAwsApply({
    env: resumeEnv,
    io: testIo({
      prompt: async () =>
        buildApplyConfirmationPhrase({
          accountId: "123456789012",
          region: "us-east-1",
          stackName: "nusend-prod",
          phase: "core",
        }),
    }),
    executor: fakeAwsExecutor({
      calls,
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
    }),
  });
  expect(calls.some((c) => c.includes("execute-change-set"))).toBe(false);
  expect(calls.some((c) => c.includes("describe-change-set"))).toBe(true);
  const state = await loadState("prod", resumeEnv);
  expect(state.plans.aws.consumed).toBe(true);
  expect(state.aws?.stack?.stackId).toBe(stackIdFor("nusend-prod"));
}

function createChangeSetDescription(input: {
  changeSetArn: string;
  status: string;
  changes: unknown[];
  statusReason?: string;
  executionStatus?: string;
  stackId?: string;
  stackName?: string;
}) {
  return {
    Status: input.status,
    StatusReason: input.statusReason ?? "",
    ExecutionStatus: input.executionStatus ?? "AVAILABLE",
    ChangeSetId: input.changeSetArn,
    ChangeSetName: "nusend-prod-core",
    StackId: input.stackId ?? stackIdFor("nusend-prod"),
    StackName: input.stackName ?? "nusend-prod",
    Capabilities: [REQUIRED_CAPABILITY],
    Changes: input.changes,
  };
}

function assertAwsProfileRegion(args: string[]) {
  const profileIdx = args.indexOf("--profile");
  const regionIdx = args.indexOf("--region");
  expect(profileIdx).toBeGreaterThan(-1);
  expect(regionIdx).toBeGreaterThan(-1);
  expect(args[profileIdx + 1]).toBe("nusend-provisioner");
  expect(args[regionIdx + 1]).toBe("us-east-1");
}

function fakeAwsExecutor(options: {
  calls?: string[][];
  stackExists?: boolean;
  stackStatus?: string;
  stackId?: string;
  stackOutputs?: Record<string, string>;
  changeSetArn?: string;
  changeSet?: Record<string, unknown>;
  changeSetFactory?: () => Record<string, unknown>;
  waitChangeSetExitCode?: number;
  waitStackExitCode?: number;
  executeExitCode?: number;
  executeStderr?: string;
  stackEvents?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  account?: Record<string, unknown>;
  accessKeys?: unknown[];
  createdAccessKey?: { AccessKeyId: string; SecretAccessKey: string };
  feedbackSubscriptions?: Record<string, unknown>[];
}) {
  const calls = options.calls ?? [];
  return async ({ command, args }: { command: string; args: readonly string[] }) => {
    const argv = [command, ...args];
    calls.push(argv);
    if (command !== "aws") {
      throw new Error(`unexpected command ${command}`);
    }
    assertAwsProfileRegion([...args]);

    if (args[0] === "sts" && args[1] === "get-caller-identity") {
      return ok(
        JSON.stringify({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/provisioner",
        }),
      );
    }

    if (args[0] === "cloudformation" && args[1] === "validate-template") {
      return ok(JSON.stringify({ Parameters: [], Description: "ok" }));
    }

    if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
      if (!options.stackExists) {
        return ok("", 255, "Stack with id nusend-prod does not exist");
      }
      const outputs = Object.entries(options.stackOutputs ?? sampleOutputs()).map(
        ([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }),
      );
      return ok(
        JSON.stringify({
          Stacks: [
            {
              StackId: options.stackId ?? stackIdFor("nusend-prod"),
              StackName: "nusend-prod",
              StackStatus: options.stackStatus ?? "CREATE_COMPLETE",
              Outputs: outputs,
            },
          ],
        }),
      );
    }

    if (args[0] === "cloudformation" && args[1] === "delete-change-set") {
      return ok("{}", 0);
    }

    if (args[0] === "cloudformation" && args[1] === "create-change-set") {
      expect(args).toContain(REQUIRED_CAPABILITY);
      expect(args).toContain("--profile");
      expect(args).toContain("--region");
      return ok(JSON.stringify({ Id: options.changeSetArn, StackId: stackIdFor("nusend-prod") }));
    }

    if (
      args[0] === "cloudformation" &&
      args[1] === "wait" &&
      args[2] === "change-set-create-complete"
    ) {
      return ok("", options.waitChangeSetExitCode ?? 0);
    }

    if (args[0] === "cloudformation" && args[1] === "describe-change-set") {
      const requestedArnIdx = args.indexOf("--change-set-name");
      const requestedArn = requestedArnIdx >= 0 ? String(args[requestedArnIdx + 1] ?? "") : "";
      if (options.changeSetFactory) {
        return ok(JSON.stringify(options.changeSetFactory()));
      }
      if (options.changeSet) {
        return ok(JSON.stringify(options.changeSet));
      }
      return ok(
        JSON.stringify(
          createChangeSetDescription({
            changeSetArn:
              options.changeSetArn ||
              requestedArn ||
              "arn:aws:cloudformation:us-east-1:123456789012:changeSet/x/y",
            status: "CREATE_COMPLETE",
            changes: [],
          }),
        ),
      );
    }

    if (args[0] === "cloudformation" && args[1] === "execute-change-set") {
      return ok("{}", options.executeExitCode ?? 0, options.executeStderr ?? "");
    }

    if (
      args[0] === "cloudformation" &&
      args[1] === "wait" &&
      (args[2] === "stack-create-complete" || args[2] === "stack-update-complete")
    ) {
      return ok("", options.waitStackExitCode ?? 0);
    }

    if (args[0] === "cloudformation" && args[1] === "describe-stack-events") {
      return ok(JSON.stringify(options.stackEvents ?? { StackEvents: [] }));
    }

    if (args[0] === "sns" && args[1] === "list-subscriptions-by-topic") {
      return ok(JSON.stringify({ Subscriptions: options.feedbackSubscriptions ?? [] }));
    }

    if (args[0] === "sns" && args[1] === "get-subscription-attributes") {
      return ok(
        JSON.stringify({
          Attributes: {
            Endpoint: "https://mail.example.com/api/webhooks/aws/sns/ses",
            Protocol: "https",
            PendingConfirmation: "false",
            RawMessageDelivery: "false",
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: sampleOutputs().DlqArn,
            }),
          },
        }),
      );
    }

    if (args[0] === "sesv2" && args[1] === "get-email-identity") {
      return ok(JSON.stringify(options.identity ?? readyIdentity()));
    }

    if (args[0] === "sesv2" && args[1] === "get-account") {
      return ok(
        JSON.stringify(
          options.account ?? {
            ProductionAccessEnabled: false,
            Details: { ReviewDetails: { Status: "NONE" } },
          },
        ),
      );
    }

    if (args[0] === "sesv2" && args[1] === "put-account-details") {
      return ok("{}");
    }

    if (args[0] === "iam" && args[1] === "list-access-keys") {
      return ok(JSON.stringify({ AccessKeyMetadata: options.accessKeys ?? [] }));
    }

    if (args[0] === "iam" && args[1] === "create-access-key") {
      const key = options.createdAccessKey ?? {
        AccessKeyId: "AKIADEFAULT00000000",
        SecretAccessKey: "default-secret",
      };
      return ok(JSON.stringify({ AccessKey: key }));
    }

    throw new Error(`unexpected aws argv: ${argv.join(" ")}`);
  };
}
