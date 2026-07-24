import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RETAINED_RESOURCES,
  assertInitialStackCreationProof,
  buildDestroyConfirmationPhrase,
  fingerprintDestroyPlan,
  runDestroyApply,
  runDestroyPlan,
  validateDestroyConfirmation,
} from "./destroy.mjs";
import { runSetup } from "./main.mjs";
import {
  loadDeploymentEnv,
  loadState,
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

describe("destroy ownership, phrase, and fingerprint", () => {
  it("accepts only immutable coordinator core CREATE proof and exact confirmation", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const state = await loadState("prod", env);
    expect(assertInitialStackCreationProof(state)).toMatchObject({
      stackId: STACK_ID,
      stackName: "nusend-prod",
      accountId: "123456789012",
      partition: "aws",
      region: "us-east-1",
    });

    const phrase = buildDestroyConfirmationPhrase({
      accountId: "123456789012",
      region: "us-east-1",
      stackName: "nusend-prod",
      domain: "mail.example.com",
      sshTarget: "root@203.0.113.10",
    });
    expect(phrase).toBe(
      "DESTROY 123456789012 us-east-1 nusend-prod mail.example.com root@203.0.113.10",
    );
    expect(() =>
      validateDestroyConfirmation(phrase, {
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        domain: "mail.example.com",
        sshTarget: "root@203.0.113.10",
      }),
    ).not.toThrow();
    expect(() =>
      validateDestroyConfirmation("DESTROY wrong", {
        accountId: "123456789012",
        region: "us-east-1",
        stackName: "nusend-prod",
        domain: "mail.example.com",
        sshTarget: "root@203.0.113.10",
      }),
    ).toThrow(/Confirmation rejected/);

    await writeState(
      {
        ...state,
        aws: { ...state.aws, stackCreation: undefined } as any,
      },
      env,
    );
    const withoutProof = await loadState("prod", env);
    expect(() => assertInitialStackCreationProof(withoutProof)).toThrow(/unproven|CREATE proof/i);
  });

  it("fingerprints all reviewed plan evidence and rejects stale mutation", () => {
    const plan = {
      version: 2,
      installationId: "prod",
      accountId: "123456789012",
      partition: "aws",
      region: "us-east-1",
      stackId: STACK_ID,
      stackName: "nusend-prod",
      stackStatus: "UPDATE_COMPLETE",
      stackExists: true,
      stackLastUpdatedTime: "2026-01-01T00:00:00.000Z",
      domain: "mail.example.com",
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      runtimeUserName: "nusend-prod-runtime",
      runtimeAccessKeyId: KEY_ID,
      runtimeKeys: [{ accessKeyId: KEY_ID, status: "Active" }],
      dlq: { visible: 0, notVisible: 0, delayed: 0 },
      stackResources: [],
      subscriptions: { feedback: [], alarm: [] },
      alarms: [],
      remote: { reachable: true, status: "inspected" },
      retainedResources: [...RETAINED_RESOURCES],
      externalDkimRecords: [],
      creationProofFingerprint: "a".repeat(64),
      plannedAt: "2026-01-01T00:00:00.000Z",
    };
    const fingerprint = fingerprintDestroyPlan(plan);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDestroyPlan(plan)).toBe(fingerprint);
    expect(fingerprintDestroyPlan({ ...plan, region: "eu-west-1" })).not.toBe(fingerprint);
  });
});

describe("destroy plan", () => {
  it("is provider-read-only, exact-ID bound, inventories state, and prominently reports retention/DKIM", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: string[][] = [];
    const logs: string[] = [];
    const provider = fakeProvider({ calls });
    const plan = await runDestroyPlan(context(env, provider, { log: (line) => logs.push(line) }));

    expect(plan.stackId).toBe(STACK_ID);
    expect(plan.stackLastUpdatedTime).toBe("2026-01-01T00:00:00.000Z");
    expect(plan.runtimeKeys).toEqual([{ accessKeyId: KEY_ID, status: "Active" }]);
    expect(plan.dlq).toEqual({ visible: 0, notVisible: 0, delayed: 0 });
    expect((plan.stackResources as unknown[]).length).toBe(2);
    expect((plan.subscriptions as any).feedback).toHaveLength(1);
    expect((plan.alarms as unknown[]).length).toBe(1);
    expect(plan.remote).toMatchObject({
      reachable: true,
      status: "inspected",
      stopReviewed: true,
      evidence: { commitSha: DEPLOY_SHA, releaseTag: "v0.1.1" },
    });
    expect(plan.externalDkimRecords).toHaveLength(3);
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const mutationWords = [
      "delete-stack",
      "delete-access-key",
      "execute-change-set",
      "create-change-set",
      "docker compose stop",
    ];
    expect(calls.some((call) => mutationWords.some((word) => call.join(" ").includes(word)))).toBe(
      false,
    );
    expect(calls.find((call) => call.includes("list-stack-resources"))).toContain(STACK_ID);
    expect(logs.join("\n")).toMatch(/RETAINED.*NOT remove/i);
    for (const retained of RETAINED_RESOURCES) expect(logs.join("\n")).toContain(retained);
    expect(logs.join("\n")).toContain("token1._domainkey.example.com");
  });

  it("blocks wrong caller context, active stack operation, unproven ownership, and unknown keys", async () => {
    for (const scenario of ["wrong-account", "active", "unknown-key"] as const) {
      const env = testEnv();
      // oxlint-disable-next-line no-await-in-loop -- scenarios need isolated protected setup homes.
      await seedInstallation(env);
      const options: ProviderOptions = {};
      if (scenario === "wrong-account") options.accountId = "999999999999";
      if (scenario === "active") options.stackStatus = "UPDATE_IN_PROGRESS";
      if (scenario === "unknown-key") {
        options.keys = [
          { AccessKeyId: KEY_ID, Status: "Active" },
          { AccessKeyId: "AKIAUNKNOWN000000001", Status: "Active" },
        ];
      }
      // oxlint-disable-next-line no-await-in-loop -- each isolated scenario is asserted before cleanup.
      await expect(runDestroyPlan(context(env, fakeProvider(options)))).rejects.toThrow(
        scenario === "wrong-account"
          ? /account mismatch|caller/i
          : scenario === "active"
            ? /active|IN_PROGRESS/i
            : /unrecorded access key|Unknown keys/i,
      );
    }

    const env = testEnv();
    await seedInstallation(env);
    const state = await loadState("prod", env);
    await writeState({ ...state, aws: { ...state.aws, stackCreation: undefined } as any }, env);
    await expect(runDestroyPlan(context(env, fakeProvider()))).rejects.toThrow(
      /unproven|CREATE proof/i,
    );
  });

  it.each([
    ["visible", { visible: 1, notVisible: 0, delayed: 0 }],
    ["notVisible", { visible: 0, notVisible: 1, delayed: 0 }],
    ["delayed", { visible: 0, notVisible: 0, delayed: 1 }],
  ])("blocks a nonzero %s DLQ counter", async (_name, counters) => {
    const env = testEnv();
    await seedInstallation(env);
    await expect(
      runDestroyPlan(context(env, fakeProvider({ dlqCounters: counters }))),
    ).rejects.toThrow(/DLQ is not empty/);
  });

  it("accepts a missing recorded key only with the exact durable key-delete checkpoint", async () => {
    const env = testEnv();
    await seedInstallation(env);
    await expect(runDestroyPlan(context(env, fakeProvider({ keys: [] })))).rejects.toThrow(
      /missing without.*checkpoint/i,
    );

    const state = await loadState("prod", env);
    await writeState(
      {
        ...state,
        plans: {
          destroy: {
            apply: {
              runtimeKeyDeleteIntent: exactKeyIntent(),
            },
          },
        },
      },
      env,
    );
    const plan = await runDestroyPlan(context(env, fakeProvider({ keys: [] })));
    expect(plan.runtimeKeyState).toMatchObject({ present: false, status: "absent" });
  });

  it("reports an unreachable VPS and still permits exact AWS cleanup", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const logs: string[] = [];
    const provider = fakeProvider({ sshUnreachable: true });
    const plan = await runDestroyPlan(context(env, provider, { log: (line) => logs.push(line) }));
    expect(plan.remote).toMatchObject({ reachable: false, status: "unreachable" });
    expect(logs.join("\n")).toMatch(/AWS cleanup remains available/);
    await runDestroyApply(
      context(env, provider, {
        log: (line) => logs.push(line),
        prompt: async () => buildDestroyConfirmationPhrase(plan as any),
      }),
    );
    expect(logs.join("\n")).toMatch(/Remote stop skipped.*continuing exact AWS cleanup/i);
    expect((await loadState("prod", env)).plans.destroy.consumed).toBe(true);
  });
});

describe("destroy apply and resume", () => {
  it("rejects stale fingerprint and confirmation mismatch before deletes", async () => {
    const env = testEnv();
    await seedInstallation(env);
    await runDestroyPlan(context(env, fakeProvider()));
    let state = await loadState("prod", env);
    await writeState(
      {
        ...state,
        plans: {
          ...state.plans,
          destroy: { ...state.plans.destroy, stackStatus: "tampered" },
        },
      },
      env,
    );
    await expect(runDestroyApply(context(env, fakeProvider()))).rejects.toThrow(/fingerprint/i);

    await runDestroyPlan(context(env, fakeProvider()));
    state = await loadState("prod", env);
    const calls: string[][] = [];
    await expect(
      runDestroyApply(
        context(env, fakeProvider({ calls }), { prompt: async () => "DESTROY wrong" }),
      ),
    ).rejects.toThrow(/Confirmation rejected/);
    expect(calls.some((call) => call.includes("delete-access-key"))).toBe(false);
    expect((await loadState("prod", env)).plans.destroy.apply?.approved).toBeUndefined();
  });

  it.each([
    [
      "CloudFormation LastUpdatedTime",
      () => ({
        providerState: {
          ...providerStateDefaults(),
          stackLastUpdatedTime: "2026-01-02T00:00:00.000Z",
        },
      }),
    ],
    [
      "exact stack resources",
      () => ({
        resources: [
          {
            LogicalResourceId: "ReplacementTopic",
            PhysicalResourceId: "replacement-topic",
            ResourceType: "AWS::SNS::Topic",
            ResourceStatus: "CREATE_COMPLETE",
          },
        ],
      }),
    ],
    ["feedback subscription", () => ({ feedbackEndpoint: "https://other.example/webhook" })],
    ["alarm subscription", () => ({ alarmEndpoint: "other@example.com" })],
    ["alarm inventory", () => ({ alarmState: "ALARM" })],
  ])("rejects provider-changed-after-plan %s before prompt or mutation", async (_name, changed) => {
    const env = testEnv();
    await seedInstallation(env);
    await runDestroyPlan(context(env, fakeProvider()));
    const calls: string[][] = [];
    let prompted = false;
    await expect(
      runDestroyApply(
        context(env, fakeProvider({ ...changed(), calls }), {
          prompt: async () => {
            prompted = true;
            return "";
          },
        }),
      ),
    ).rejects.toThrow(/provider inventory changed after planning/i);
    expect(prompted).toBe(false);
    expect(calls.some((call) => call.join(" ").includes("docker compose stop"))).toBe(false);
    expect(calls.some((call) => call.includes("delete-access-key"))).toBe(false);
    expect(calls.some((call) => call.includes("delete-stack"))).toBe(false);
  });

  it("normalizes provider array ordering before exact comparison", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const plan = await runDestroyPlan(context(env, fakeProvider()));
    await expect(
      runDestroyApply(
        context(env, fakeProvider({ reverseProviderArrays: true }), {
          prompt: async () => buildDestroyConfirmationPhrase(plan as any),
        }),
      ),
    ).resolves.toMatchObject({ verified: true });
  });

  it("stops without volumes, deletes key before repeated queue check and exact stack, verifies absence, then removes only AWS credentials", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: string[][] = [];
    const provider = fakeProvider({ calls });
    const plan = await runDestroyPlan(context(env, provider));
    const result = await runDestroyApply(
      context(env, provider, { prompt: async () => buildDestroyConfirmationPhrase(plan as any) }),
    );
    expect(result.verified).toBe(true);

    const strings = calls.map((call) => call.join(" "));
    const stopIndex = strings.findIndex((call) => call.includes("docker compose stop"));
    const keyDeleteIndex = strings.findIndex((call) => call.includes("delete-access-key"));
    const queueIndices = strings
      .map((call, index) => (call.includes("get-queue-attributes") ? index : -1))
      .filter((index) => index >= 0);
    const stackDeleteIndex = strings.findIndex((call) => call.includes("delete-stack"));
    expect(stopIndex).toBeGreaterThan(-1);
    expect(strings[stopIndex]).not.toMatch(/\bdown\b|-v|--volumes/);
    expect(keyDeleteIndex).toBeGreaterThan(stopIndex);
    expect(queueIndices).toHaveLength(3); // plan, pre-apply guard, immediate post-key-delete guard
    expect(queueIndices.at(-1)).toBeGreaterThan(keyDeleteIndex);
    expect(stackDeleteIndex).toBeGreaterThan(queueIndices.at(-1)!);
    expect(strings[stackDeleteIndex]).toContain(STACK_ID);
    expect(
      strings.filter((call) => call.includes("describe-stacks") && call.includes(STACK_ID)).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      strings.filter((call) => call.includes("list-stack-resources") && call.includes(STACK_ID))
        .length,
    ).toBeGreaterThanOrEqual(2);

    const deployment = await loadDeploymentEnv("prod", env);
    expect(deployment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(deployment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(deployment.AWS_REGION).toBe("us-east-1");
    expect(deployment.NUSEND_RESTIC_REPOSITORY).toContain("r2.cloudflarestorage.com");
    const finished = await loadState("prod", env);
    expect(finished.plans.destroy.consumed).toBe(true);
    expect(finished.plans.destroy.tombstone).toMatchObject({ exactStackId: STACK_ID });
    expect(finished.aws?.stackCreation?.changeSetType).toBe("CREATE");
  });

  it.each([
    [
      "origin",
      (providerState: ProviderState) => {
        providerState.remoteOrigin = "https://github.com/other/unrelated-project.git";
      },
    ],
    [
      "commit",
      (providerState: ProviderState) => {
        providerState.remoteHead = "c".repeat(40);
      },
    ],
  ])(
    "skips remote mutation when the reviewed checkout path has a replaced %s identity before apply",
    async (_name, replaceIdentity) => {
      const env = testEnv();
      await seedInstallation(env);
      const providerState = providerStateDefaults();
      const calls: string[][] = [];
      const planProvider = fakeProvider({ providerState });
      const plan = await runDestroyPlan(context(env, planProvider));
      expect(plan.remote).toMatchObject({ stopReviewed: true });

      replaceIdentity(providerState);
      await runDestroyApply(
        context(env, fakeProvider({ providerState, calls }), {
          prompt: async () => buildDestroyConfirmationPhrase(plan as any),
        }),
      );

      expect(calls.some((call) => call.join(" ").includes("docker compose stop"))).toBe(false);
      expect(calls.some((call) => call.includes("delete-stack"))).toBe(true);
      expect((await loadState("prod", env)).plans.destroy.apply.remoteStop).toMatchObject({
        skipped: true,
        reason: "identity-unproven",
      });
    },
  );

  it("does not opportunistically stop when trusted remote identity was not reviewed in the plan", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    providerState.remoteOrigin = "https://github.com/other/unrelated-project.git";
    const plan = await runDestroyPlan(context(env, fakeProvider({ providerState })));
    expect(plan.remote).toMatchObject({ status: "identity-unproven", stopReviewed: false });

    providerState.remoteOrigin = "https://github.com/maxedapps/nusend.git";
    const calls: string[][] = [];
    await runDestroyApply(
      context(env, fakeProvider({ providerState, calls }), {
        prompt: async () => buildDestroyConfirmationPhrase(plan as any),
      }),
    );

    expect(calls.some((call) => call.join(" ").includes("docker compose stop"))).toBe(false);
    expect((await loadState("prod", env)).plans.destroy.apply.remoteStop).toMatchObject({
      skipped: true,
      reason: "identity-not-reviewed-or-state-changed",
    });
  });

  it("persists exact remote-stop intent before an interruption and safely retries stop", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: string[][] = [];
    const provider = fakeProvider({ calls, interruptStopOnce: true });
    const plan = await runDestroyPlan(context(env, provider));
    await expect(
      runDestroyApply(
        context(env, provider, {
          prompt: async () => buildDestroyConfirmationPhrase(plan as any),
        }),
      ),
    ).rejects.toThrow(/simulated stop interruption/);

    let interrupted = await loadState("prod", env);
    expect(interrupted.plans.destroy.apply.remoteStopIntent).toMatchObject({
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      domain: "mail.example.com",
      releaseTag: "v0.1.1",
      commitSha: DEPLOY_SHA,
      command: "docker compose stop",
    });
    expect(interrupted.plans.destroy.apply.remoteStop).toBeUndefined();
    expect(interrupted.plans.destroy.apply.runtimeKeyDeleteIntent).toBeUndefined();

    await runDestroyApply(
      context(env, provider, {
        prompt: async () => {
          throw new Error("resume must not prompt");
        },
      }),
    );
    expect(calls.filter((call) => call.join(" ").includes("docker compose stop"))).toHaveLength(2);
    interrupted = await loadState("prod", env);
    expect(interrupted.plans.destroy.apply.remoteStop).toMatchObject({
      reachable: true,
      stopped: true,
      exitCode: 0,
    });
  });

  it("persists a reachable nonzero stop outcome and blocks AWS mutation", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: string[][] = [];
    const provider = fakeProvider({
      calls,
      stopExitCode: 17,
      stopMessage: "docker daemon connection refused: network is unreachable",
    });
    const plan = await runDestroyPlan(context(env, provider));
    await expect(
      runDestroyApply(
        context(env, provider, {
          prompt: async () => buildDestroyConfirmationPhrase(plan as any),
        }),
      ),
    ).rejects.toThrow(/docker compose stop.*failed/i);

    const interrupted = await loadState("prod", env);
    expect(interrupted.plans.destroy.apply.remoteStopIntent).toMatchObject({
      commitSha: DEPLOY_SHA,
      command: "docker compose stop",
    });
    expect(interrupted.plans.destroy.apply.remoteStop).toMatchObject({
      reachable: true,
      stopped: false,
      exitCode: 17,
    });
    expect(calls.some((call) => call.includes("delete-access-key"))).toBe(false);
    expect(calls.some((call) => call.includes("delete-stack"))).toBe(false);
  });

  it("resumes after runtime key provider deletion using exact prior intent", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    const first = fakeProvider({
      providerState,
      failQueueReadNumber: 3,
    });
    const plan = await runDestroyPlan(context(env, first));
    await expect(
      runDestroyApply(
        context(env, first, { prompt: async () => buildDestroyConfirmationPhrase(plan as any) }),
      ),
    ).rejects.toThrow(/simulated queue interruption/);
    expect(providerState.keyPresent).toBe(false);
    let interrupted = await loadState("prod", env);
    expect(interrupted.plans.destroy.apply.runtimeKeyDeleteIntent).toMatchObject({
      runtimeAccessKeyId: KEY_ID,
      stackId: STACK_ID,
    });
    expect(interrupted.plans.destroy.apply.stackDeleteIntent).toBeUndefined();

    const resumeCalls: string[][] = [];
    await runDestroyApply(
      context(env, fakeProvider({ providerState, calls: resumeCalls }), {
        prompt: async () => {
          throw new Error("resume must not prompt");
        },
      }),
    );
    expect(resumeCalls.some((call) => call.includes("delete-access-key"))).toBe(false);
    expect((await loadState("prod", env)).plans.destroy.consumed).toBe(true);
  });

  it("accepts exact stack absence after interruption only with deletion-request checkpoint", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    const first = fakeProvider({ providerState, failDescribeAfterDeleteOnce: true });
    const plan = await runDestroyPlan(context(env, first));
    await expect(
      runDestroyApply(
        context(env, first, { prompt: async () => buildDestroyConfirmationPhrase(plan as any) }),
      ),
    ).rejects.toThrow(/simulated post-delete interruption/);
    expect(providerState.stackExists).toBe(false);
    const interrupted = await loadState("prod", env);
    expect(interrupted.plans.destroy.apply.stackDeleteIntent).toMatchObject({ stackId: STACK_ID });
    const deploymentBeforeResume = await loadDeploymentEnv("prod", env);
    expect(deploymentBeforeResume.AWS_ACCESS_KEY_ID).toBe(KEY_ID);

    await runDestroyApply(
      context(env, fakeProvider({ providerState }), {
        prompt: async () => {
          throw new Error("resume must not prompt");
        },
      }),
    );
    expect((await loadDeploymentEnv("prod", env)).AWS_ACCESS_KEY_ID).toBeUndefined();

    const unexplainedEnv = testEnv();
    await seedInstallation(unexplainedEnv);
    await expect(
      runDestroyPlan(context(unexplainedEnv, fakeProvider({ stackExists: false }))),
    ).rejects.toThrow(/unexpectedly missing|deletion-request checkpoint/i);
  });

  it("reports failed logical resource and retries DELETE_FAILED on the same exact stack", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    const calls: string[][] = [];
    const first = fakeProvider({ providerState, calls, deleteFails: true });
    const plan = await runDestroyPlan(context(env, first));
    await expect(
      runDestroyApply(
        context(env, first, { prompt: async () => buildDestroyConfirmationPhrase(plan as any) }),
      ),
    ).rejects.toThrow(/WebhookSubscription.*endpoint still deleting|Failed logical resource/i);
    expect(providerState.stackStatus).toBe("DELETE_FAILED");

    const second = fakeProvider({ providerState, calls });
    await runDestroyApply(
      context(env, second, {
        prompt: async () => {
          throw new Error("retry must not prompt");
        },
      }),
    );
    const deletes = calls.filter((call) => call.includes("delete-stack"));
    expect(deletes).toHaveLength(2);
    expect(deletes.every((call) => call.includes(STACK_ID))).toBe(true);
  });

  it("main dispatches destroy plan and apply", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const provider = fakeProvider();
    const planned = await runSetup(["destroy", "plan"], context(env, provider));
    expect(planned.exitCode).toBe(0);
    const state = await loadState("prod", env);
    const phrase = buildDestroyConfirmationPhrase(state.plans.destroy as any);
    const applied = await runSetup(
      ["destroy", "apply"],
      context(env, provider, { prompt: async () => phrase }),
    );
    expect(applied.exitCode).toBe(0);
    expect((await loadState("prod", env)).plans.destroy.consumed).toBe(true);
  });
});

const STACK_ID =
  "arn:aws:cloudformation:us-east-1:123456789012:stack/nusend-prod/00000000-0000-0000-0000-000000000001";
const KEY_ID = "AKIARUNTIME000000001";
const DEPLOY_SHA = "b".repeat(40);

function testEnv() {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-destroy-"));
  temporaryDirectories.push(directory);
  return { NUSEND_SETUP_HOME: directory, HOME: directory };
}

async function seedInstallation(env: { NUSEND_SETUP_HOME: string; HOME: string }) {
  const now = "2026-01-01T00:00:00.000Z";
  await writeState(
    {
      schemaVersion: 1,
      installationId: "prod",
      createdAt: now,
      updatedAt: now,
      config: {
        releaseTag: "v0.1.1",
        domain: "mail.example.com",
        ingressMode: "direct",
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
        installationName: "prod",
      },
      stages: {
        init: { status: "complete", completedAt: now, evidence: { verified: true } },
        aws_core: { status: "complete", completedAt: now, evidence: { verified: true } },
        human_gates: { status: "complete", completedAt: now, evidence: { verified: true } },
        deploy: { status: "complete", completedAt: now, evidence: { verified: true } },
        aws_finalize: { status: "complete", completedAt: now, evidence: { verified: true } },
        validate_pre_simulator: {
          status: "complete",
          completedAt: now,
          evidence: { verified: true },
        },
        validate_simulator: { status: "complete", completedAt: now, evidence: { verified: true } },
        validate_final: { status: "complete", completedAt: now, evidence: { verified: true } },
      },
      plans: {},
      deploy: {
        commitSha: DEPLOY_SHA,
        releaseTag: "v0.1.1",
        sshTarget: "root@203.0.113.10",
        remotePath: "/srv/nusend",
        domain: "mail.example.com",
        appliedAt: now,
      },
      aws: {
        runtimeAccessKeyId: KEY_ID,
        stackCreation: {
          provenance: "coordinator-reviewed-change-set",
          phase: "core",
          changeSetType: "CREATE",
          stackId: STACK_ID,
          stackName: "nusend-prod",
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          changeSetArn:
            "arn:aws:cloudformation:us-east-1:123456789012:changeSet/nusend-prod-core/create-id",
          fingerprint: "a".repeat(64),
          appliedAt: now,
        },
        stack: {
          stackId: STACK_ID,
          stackName: "nusend-prod",
          accountId: "123456789012",
          partition: "aws",
          region: "us-east-1",
          phase: "finalize",
          status: "UPDATE_COMPLETE",
          changeSetType: "UPDATE",
          outputs: stackOutputs(),
        },
      },
    },
    env,
  );
  await writeDeploymentEnv(
    "prod",
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
      AWS_ACCESS_KEY_ID: KEY_ID,
      AWS_SECRET_ACCESS_KEY: "runtime-secret-value-xxxxxxxx",
      AWS_SESSION_TOKEN: "temporary-session-value-xxxxxxxx",
      AWS_REGION: "us-east-1",
      NUSEND_SES_FROM_EMAIL: "sender@example.com",
      NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "nusend-prod-transactional",
      NUSEND_SES_FEEDBACK_TOPIC_ARNS: stackOutputs().FeedbackTopicArn,
      NUSEND_RESTIC_REPOSITORY: "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
      NUSEND_R2_ACCESS_KEY_ID: "r2-access",
      NUSEND_R2_SECRET_ACCESS_KEY: "r2-secret-value-xxxxxx",
      NUSEND_RESTIC_PASSWORD: "restic-password-value-xxxxxx",
    },
    env,
  );
  await writeCurrentPointer("prod", env);
}

function stackOutputs() {
  return {
    RuntimeUserName: "nusend-prod-runtime",
    DlqUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/nusend-prod-dlq",
    DlqArn: "arn:aws:sqs:us-east-1:123456789012:nusend-prod-dlq",
    FeedbackTopicArn: "arn:aws:sns:us-east-1:123456789012:nusend-prod-feedback",
    AlarmTopicArn: "arn:aws:sns:us-east-1:123456789012:nusend-prod-alarms",
    DkimRecordName1: "token1._domainkey.example.com",
    DkimRecordValue1: "token1.dkim.amazonses.com",
    DkimRecordName2: "token2._domainkey.example.com",
    DkimRecordValue2: "token2.dkim.amazonses.com",
    DkimRecordName3: "token3._domainkey.example.com",
    DkimRecordValue3: "token3.dkim.amazonses.com",
  };
}

function exactKeyIntent() {
  return {
    runtimeAccessKeyId: KEY_ID,
    runtimeUserName: "nusend-prod-runtime",
    stackId: STACK_ID,
    accountId: "123456789012",
    region: "us-east-1",
    recordedAt: "2026-01-02T00:00:00.000Z",
  };
}

function context(
  env: { NUSEND_SETUP_HOME: string; HOME: string },
  executor: ReturnType<typeof fakeProvider>,
  io: { log?: (line: string) => void; prompt?: (message: string) => Promise<string> } = {},
) {
  return {
    env,
    executor,
    io: {
      prompt: io.prompt ?? (async () => ""),
      promptSecret: async () => "",
      log: io.log ?? (() => undefined),
      error: () => undefined,
    },
  };
}

type ProviderState = {
  stackExists: boolean;
  stackStatus: string;
  stackLastUpdatedTime: string;
  keyPresent: boolean;
  queueReads: number;
  describeAfterDeleteFailed: boolean;
  remoteOrigin: string;
  remoteHead: string;
  remoteTagSha: string;
  remoteDirty: boolean;
};

type ProviderOptions = {
  calls?: string[][];
  providerState?: ProviderState;
  accountId?: string;
  stackExists?: boolean;
  stackStatus?: string;
  keys?: { AccessKeyId: string; Status: string }[];
  dlqCounters?: { visible: number; notVisible: number; delayed: number };
  sshUnreachable?: boolean;
  failQueueReadNumber?: number;
  failDescribeAfterDeleteOnce?: boolean;
  deleteFails?: boolean;
  resources?: Array<{
    LogicalResourceId: string;
    PhysicalResourceId: string;
    ResourceType: string;
    ResourceStatus: string;
  }>;
  feedbackEndpoint?: string;
  alarmEndpoint?: string;
  alarmState?: string;
  reverseProviderArrays?: boolean;
  stopExitCode?: number;
  stopMessage?: string;
  interruptStopOnce?: boolean;
};

function providerStateDefaults(): ProviderState {
  return {
    stackExists: true,
    stackStatus: "UPDATE_COMPLETE",
    stackLastUpdatedTime: "2026-01-01T00:00:00.000Z",
    keyPresent: true,
    queueReads: 0,
    describeAfterDeleteFailed: false,
    remoteOrigin: "https://github.com/maxedapps/nusend.git",
    remoteHead: DEPLOY_SHA,
    remoteTagSha: DEPLOY_SHA,
    remoteDirty: false,
  };
}

function fakeProvider(options: ProviderOptions = {}) {
  const calls = options.calls ?? [];
  const providerState = options.providerState ?? providerStateDefaults();
  if (options.stackExists !== undefined) providerState.stackExists = options.stackExists;
  if (options.stackStatus !== undefined) providerState.stackStatus = options.stackStatus;
  let deleteAttempts = 0;
  let stopInterrupted = false;
  return async ({
    command,
    args,
  }: {
    command: string;
    args: readonly string[];
    allowNonZero?: boolean;
  }) => {
    const argv = [command, ...args];
    calls.push(argv);
    if (command === "ssh") {
      if (options.sshUnreachable) throw new Error("ssh: connect to host timed out");
      const joined = argv.join(" ");
      if (joined.includes("remote get-url origin")) {
        return ok(
          [
            `ORIGIN:${providerState.remoteOrigin}`,
            `PORCELAIN:${providerState.remoteDirty ? " M compose.yaml" : ""}`,
            `HEAD:${providerState.remoteHead}`,
            "BRANCH:",
            `TAG_SHA:${providerState.remoteTagSha}`,
            "",
          ].join("\n"),
        );
      }
      if (joined.includes("docker compose ps")) {
        return ok('{"Service":"api","State":"running"}\n');
      }
      if (joined.includes("docker compose stop")) {
        if (options.interruptStopOnce && !stopInterrupted) {
          stopInterrupted = true;
          throw new Error("simulated stop interruption");
        }
        return options.stopExitCode
          ? failed(options.stopMessage ?? "compose stop failed", options.stopExitCode)
          : ok("");
      }
      throw new Error(`unexpected ssh command: ${argv.join(" ")}`);
    }
    if (command !== "aws") throw new Error(`unexpected command: ${command}`);

    if (args[0] === "sts" && args[1] === "get-caller-identity") {
      const accountId = options.accountId ?? "123456789012";
      return ok(
        JSON.stringify({ Account: accountId, Arn: `arn:aws:iam::${accountId}:user/provisioner` }),
      );
    }
    if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
      if (
        !providerState.stackExists &&
        options.failDescribeAfterDeleteOnce &&
        !providerState.describeAfterDeleteFailed
      ) {
        providerState.describeAfterDeleteFailed = true;
        throw new Error("simulated post-delete interruption");
      }
      if (!providerState.stackExists) return failed("Stack does not exist");
      return ok(
        JSON.stringify({
          Stacks: [
            {
              StackId: STACK_ID,
              StackName: "nusend-prod",
              StackStatus: providerState.stackStatus,
              LastUpdatedTime: providerState.stackLastUpdatedTime,
              Outputs: Object.entries(stackOutputs()).map(([OutputKey, OutputValue]) => ({
                OutputKey,
                OutputValue,
              })),
            },
          ],
        }),
      );
    }
    if (args[0] === "cloudformation" && args[1] === "list-stack-resources") {
      if (!providerState.stackExists) return failed("Stack does not exist");
      const resources = options.resources ?? [
        {
          LogicalResourceId: "RuntimeUser",
          PhysicalResourceId: "nusend-prod-runtime",
          ResourceType: "AWS::IAM::User",
          ResourceStatus: "CREATE_COMPLETE",
        },
        {
          LogicalResourceId: "FeedbackTopic",
          PhysicalResourceId: stackOutputs().FeedbackTopicArn,
          ResourceType: "AWS::SNS::Topic",
          ResourceStatus: "CREATE_COMPLETE",
        },
      ];
      return ok(
        JSON.stringify({
          StackResourceSummaries: options.reverseProviderArrays
            ? [...resources].reverse()
            : resources,
        }),
      );
    }
    if (args[0] === "iam" && args[1] === "list-access-keys") {
      const keys =
        options.keys ??
        (providerState.keyPresent ? [{ AccessKeyId: KEY_ID, Status: "Active" }] : []);
      return ok(JSON.stringify({ AccessKeyMetadata: keys }));
    }
    if (args[0] === "iam" && args[1] === "delete-access-key") {
      expect(args).toContain(KEY_ID);
      providerState.keyPresent = false;
      return ok("");
    }
    if (args[0] === "sqs" && args[1] === "get-queue-attributes") {
      providerState.queueReads += 1;
      if (providerState.queueReads === options.failQueueReadNumber) {
        throw new Error("simulated queue interruption");
      }
      const counters = options.dlqCounters ?? { visible: 0, notVisible: 0, delayed: 0 };
      return ok(
        JSON.stringify({
          Attributes: {
            ApproximateNumberOfMessages: String(counters.visible),
            ApproximateNumberOfMessagesNotVisible: String(counters.notVisible),
            ApproximateNumberOfMessagesDelayed: String(counters.delayed),
          },
        }),
      );
    }
    if (args[0] === "sns" && args[1] === "list-subscriptions-by-topic") {
      const topic = String(args[args.indexOf("--topic-arn") + 1]);
      return ok(
        JSON.stringify({
          Subscriptions: [
            {
              SubscriptionArn: `${topic}:subscription-id`,
              Protocol: topic.includes("alarms") ? "email" : "https",
              Endpoint: topic.includes("alarms")
                ? (options.alarmEndpoint ?? "alerts@example.com")
                : (options.feedbackEndpoint ?? "https://mail.example.com/api/webhooks/aws/sns/ses"),
              Owner: "123456789012",
            },
          ],
        }),
      );
    }
    if (args[0] === "sns" && args[1] === "get-subscription-attributes") {
      const arn = String(args[args.indexOf("--subscription-arn") + 1]);
      const alarm = arn.includes("alarms");
      return ok(
        JSON.stringify({
          Attributes: {
            Endpoint: alarm
              ? (options.alarmEndpoint ?? "alerts@example.com")
              : (options.feedbackEndpoint ?? "https://mail.example.com/api/webhooks/aws/sns/ses"),
            Protocol: alarm ? "email" : "https",
            PendingConfirmation: "false",
            RawMessageDelivery: "false",
            RedrivePolicy: alarm
              ? ""
              : JSON.stringify({ deadLetterTargetArn: stackOutputs().DlqArn }),
          },
        }),
      );
    }
    if (args[0] === "cloudwatch" && args[1] === "describe-alarms") {
      return ok(
        JSON.stringify({
          MetricAlarms: [
            {
              AlarmName: "nusend-prod-dlq-visible-messages",
              StateValue: options.alarmState ?? "OK",
              AlarmActions: [stackOutputs().AlarmTopicArn],
            },
          ],
        }),
      );
    }
    if (args[0] === "cloudformation" && args[1] === "delete-stack") {
      expect(args).toContain(STACK_ID);
      deleteAttempts += 1;
      if (options.deleteFails && deleteAttempts === 1) {
        providerState.stackStatus = "DELETE_FAILED";
      } else {
        providerState.stackStatus = "DELETE_IN_PROGRESS";
      }
      return ok("");
    }
    if (args[0] === "cloudformation" && args[1] === "wait" && args[2] === "stack-delete-complete") {
      if (providerState.stackStatus === "DELETE_FAILED") return failed("waiter failed");
      providerState.stackExists = false;
      return ok("");
    }
    if (args[0] === "cloudformation" && args[1] === "describe-stack-events") {
      return ok(
        JSON.stringify({
          StackEvents: [
            {
              LogicalResourceId: "WebhookSubscription",
              ResourceStatus: "DELETE_FAILED",
              ResourceStatusReason: "endpoint still deleting",
            },
          ],
        }),
      );
    }
    throw new Error(`unexpected AWS command: ${argv.join(" ")}`);
  };
}

function ok(stdout: string) {
  return { exitCode: 0, signal: null, stdout, stderr: "", argv: [] };
}

function failed(stderr: string, exitCode = 255) {
  return { exitCode, signal: null, stdout: "", stderr, argv: [] };
}
