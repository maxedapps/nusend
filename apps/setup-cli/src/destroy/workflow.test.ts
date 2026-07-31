import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { AwsPermissionDeniedError } from "../aws/permissions.ts";
import { SetupStore, SetupStoreLive } from "../services/setup-store.ts";
import { unwrapEnvValue } from "../state/env.ts";
import type { SetupState } from "../state/schema.ts";
import { runDestroyApply } from "./apply.ts";
import { runDestroyPlan } from "./plan.ts";
import { RETAINED_RESOURCES, buildDestroyConfirmationPhrase } from "./pure.ts";
import {
  ACCOUNT,
  DEPLOY_SHA,
  KEY_ID,
  STACK_ID,
  cleanupTemps,
  destroyLayer,
  exactKeyIntent,
  providerStateDefaults,
  runDestroyWorkflow,
  runDestroyWorkflowExit,
  seedInstallation,
  testEnv,
} from "./test-harness.ts";

afterEach(() => {
  cleanupTemps();
});

async function loadState(env: NodeJS.ProcessEnv, installationId = "prod"): Promise<SetupState> {
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

async function loadDeploymentEnv(env: NodeJS.ProcessEnv, installationId = "prod") {
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

describe("destroy plan", () => {
  it("is provider-read-only, exact-ID bound, inventories state, and prominently reports retention/DKIM", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const { layer, terminal, calls } = destroyLayer(env);
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);

    expect(plan.stackId).toBe(STACK_ID);
    expect(plan.stackLastUpdatedTime).toBe("2026-01-01T00:00:00.000Z");
    expect(plan.runtimeKeys).toEqual([{ accessKeyId: KEY_ID, status: "Active" }]);
    expect(plan.dlq).toEqual({ visible: 0, notVisible: 0, delayed: 0 });
    expect((plan.stackResources as unknown[]).length).toBe(2);
    expect((plan.subscriptions as { feedback: unknown[] }).feedback).toHaveLength(1);
    expect((plan.alarms as unknown[]).length).toBe(1);
    expect(plan.remote).toMatchObject({
      reachable: true,
      status: "inspected",
      stopReviewed: true,
      evidence: { commitSha: DEPLOY_SHA, releaseTag: "v0.1.2" },
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
    expect(
      calls.some((call) => mutationWords.some((word) => call.argv.join(" ").includes(word))),
    ).toBe(false);
    expect(calls.find((call) => call.argv.includes("list-stack-resources"))?.argv).toContain(
      STACK_ID,
    );
    const logs = terminal.state.stdout.join("");
    expect(logs).toMatch(/RETAINED.*NOT remove/i);
    for (const retained of RETAINED_RESOURCES) expect(logs).toContain(retained);
    expect(logs).toContain("token1._domainkey.example.com");
  });

  it("blocks wrong caller context, active stack operation, unproven ownership, and unknown keys", async () => {
    for (const scenario of ["wrong-account", "active", "unknown-key"] as const) {
      const env = testEnv();
      await seedInstallation(env);
      const fake =
        scenario === "wrong-account"
          ? { stsAccount: "999999999999" }
          : scenario === "active"
            ? { providerState: { ...providerStateDefaults(), stackStatus: "UPDATE_IN_PROGRESS" } }
            : {
                keys: [
                  { AccessKeyId: KEY_ID, Status: "Active" },
                  { AccessKeyId: "AKIAUNKNOWN000000001", Status: "Active" },
                ],
              };
      const { layer } = destroyLayer(env, fake);
      const exit = await runDestroyWorkflowExit(runDestroyPlan(env), layer);
      expect(failMessage(exit)).toMatch(
        scenario === "wrong-account"
          ? /account mismatch|caller|does not match profile sso_account_id/i
          : scenario === "active"
            ? /active|IN_PROGRESS/i
            : /unrecorded access key|Unknown keys/i,
      );
    }

    const env = testEnv();
    await seedInstallation(env);
    const state = await loadState(env);
    await writeState(env, {
      ...state,
      aws: { ...state.aws, stackCreation: undefined } as never,
    });
    const { layer } = destroyLayer(env);
    const exit = await runDestroyWorkflowExit(runDestroyPlan(env), layer);
    expect(failMessage(exit)).toMatch(/unproven|CREATE proof/i);
  });

  it.each([
    ["visible", { visible: 1, notVisible: 0, delayed: 0 }],
    ["notVisible", { visible: 0, notVisible: 1, delayed: 0 }],
    ["delayed", { visible: 0, notVisible: 0, delayed: 1 }],
  ])("blocks a nonzero %s DLQ counter", async (_name, counters) => {
    const env = testEnv();
    await seedInstallation(env);
    const { layer } = destroyLayer(env, { dlqCounters: counters });
    const exit = await runDestroyWorkflowExit(runDestroyPlan(env), layer);
    expect(failMessage(exit)).toMatch(/DLQ is not empty/);
  });

  it("accepts a missing recorded key only with the exact durable key-delete checkpoint", async () => {
    const env = testEnv();
    await seedInstallation(env);
    {
      const { layer } = destroyLayer(env, { keys: [] });
      const exit = await runDestroyWorkflowExit(runDestroyPlan(env), layer);
      expect(failMessage(exit)).toMatch(/missing without.*checkpoint/i);
    }

    const state = await loadState(env);
    await writeState(env, {
      ...state,
      plans: {
        destroy: {
          apply: {
            runtimeKeyDeleteIntent: exactKeyIntent(),
          },
        },
      },
    });
    const { layer } = destroyLayer(env, { keys: [] });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    expect(plan.runtimeKeyState).toMatchObject({ present: false, status: "absent" });
  });

  it("reports an unreachable VPS and still permits exact AWS cleanup", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    const { layer, terminal, calls } = destroyLayer(env, {
      providerState,
      sshUnreachable: true,
    });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    expect(plan.remote).toMatchObject({ reachable: false, status: "unreachable" });
    expect(terminal.state.stdout.join("")).toMatch(/AWS cleanup remains available/);

    const phrase = buildDestroyConfirmationPhrase(plan as never);
    const { layer: applyLayer, terminal: applyTerminal } = destroyLayer(
      env,
      { providerState, sshUnreachable: true, calls },
      [phrase],
    );
    await runDestroyWorkflow(runDestroyApply(env), applyLayer);
    expect(applyTerminal.state.stdout.join("")).toMatch(
      /Remote stop skipped.*continuing exact AWS cleanup/i,
    );
    expect((await loadState(env)).plans.destroy).toMatchObject({ consumed: true });
  });
});

describe("destroy apply and resume", () => {
  it("rejects stale fingerprint and confirmation mismatch before deletes", async () => {
    const env = testEnv();
    await seedInstallation(env);
    {
      const { layer } = destroyLayer(env);
      await runDestroyWorkflow(runDestroyPlan(env), layer);
    }
    let state = await loadState(env);
    await writeState(env, {
      ...state,
      plans: {
        ...state.plans,
        destroy: { ...(state.plans.destroy as object), stackStatus: "tampered" },
      },
    });
    {
      const { layer } = destroyLayer(env);
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), layer);
      expect(failMessage(exit)).toMatch(/fingerprint/i);
    }

    {
      const { layer } = destroyLayer(env);
      await runDestroyWorkflow(runDestroyPlan(env), layer);
    }
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    {
      const { layer } = destroyLayer(env, { calls }, ["DESTROY wrong"]);
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), layer);
      expect(failMessage(exit)).toMatch(/Confirmation rejected/);
      expect(calls.some((call) => call.argv.includes("delete-access-key"))).toBe(false);
      expect((await loadState(env)).plans.destroy).not.toMatchObject({
        apply: { approved: expect.anything() },
      });
    }
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
    {
      const { layer } = destroyLayer(env);
      await runDestroyWorkflow(runDestroyPlan(env), layer);
    }
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer, terminal } = destroyLayer(env, { ...changed(), calls }, ["should-not-prompt"]);
    const exit = await runDestroyWorkflowExit(runDestroyApply(env), layer);
    expect(failMessage(exit)).toMatch(/provider inventory changed after planning/i);
    expect(terminal.state.prompts).toHaveLength(0);
    expect(calls.some((call) => call.argv.join(" ").includes("docker compose stop"))).toBe(false);
    expect(calls.some((call) => call.argv.includes("delete-access-key"))).toBe(false);
    expect(calls.some((call) => call.argv.includes("delete-stack"))).toBe(false);
  });

  it("normalizes provider array ordering before exact comparison", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const { layer } = destroyLayer(env);
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    const { layer: applyLayer } = destroyLayer(env, { reverseProviderArrays: true }, [
      buildDestroyConfirmationPhrase(plan as never),
    ]);
    await expect(runDestroyWorkflow(runDestroyApply(env), applyLayer)).resolves.toMatchObject({
      verified: true,
    });
  });

  it("stops without volumes, deletes key before repeated queue check and exact stack, verifies absence, then removes only AWS credentials", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const providerState = providerStateDefaults();
    const { layer } = destroyLayer(env, { calls, providerState });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    const { layer: applyLayer } = destroyLayer(env, { calls, providerState }, [
      buildDestroyConfirmationPhrase(plan as never),
    ]);
    const result = await runDestroyWorkflow(runDestroyApply(env), applyLayer);
    expect(result.verified).toBe(true);

    const strings = calls.map((call) => call.argv.join(" "));
    const stopIndex = strings.findIndex((call) => call.includes("docker compose stop"));
    const keyDeleteIndex = strings.findIndex((call) => call.includes("delete-access-key"));
    const queueIndices = strings
      .map((call, index) => (call.includes("get-queue-attributes") ? index : -1))
      .filter((index) => index >= 0);
    const stackDeleteIndex = strings.findIndex((call) => call.includes("delete-stack"));
    expect(stopIndex).toBeGreaterThan(-1);
    expect(strings[stopIndex]).not.toMatch(/\bdown\b|-v|--volumes/);
    expect(keyDeleteIndex).toBeGreaterThan(stopIndex);
    expect(queueIndices.length).toBeGreaterThanOrEqual(3);
    expect(queueIndices.at(-1)!).toBeGreaterThan(keyDeleteIndex);
    expect(stackDeleteIndex).toBeGreaterThan(queueIndices.at(-1)!);
    expect(strings[stackDeleteIndex]).toContain(STACK_ID);

    const deployment = await loadDeploymentEnv(env);
    expect(deployment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(deployment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(unwrapEnvValue(deployment.AWS_REGION!)).toBe("us-east-1");
    expect(unwrapEnvValue(deployment.NUSEND_RESTIC_REPOSITORY!)).toContain(
      "r2.cloudflarestorage.com",
    );
    const finished = await loadState(env);
    expect(finished.plans.destroy).toMatchObject({
      consumed: true,
      tombstone: { exactStackId: STACK_ID },
    });
    expect(finished.aws?.stackCreation).toMatchObject({ changeSetType: "CREATE" });
  });

  it.each([
    [
      "origin",
      (providerState: ReturnType<typeof providerStateDefaults>) => {
        providerState.remoteOrigin = "https://github.com/other/unrelated-project.git";
      },
    ],
    [
      "commit",
      (providerState: ReturnType<typeof providerStateDefaults>) => {
        providerState.remoteHead = "c".repeat(40);
      },
    ],
  ])(
    "skips remote mutation when the reviewed checkout path has a replaced %s identity before apply",
    async (_name, replaceIdentity) => {
      const env = testEnv();
      await seedInstallation(env);
      const providerState = providerStateDefaults();
      const { layer } = destroyLayer(env, { providerState });
      const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
      expect(plan.remote).toMatchObject({ stopReviewed: true });

      replaceIdentity(providerState);
      const calls: Array<{ argv: string[]; stdin?: string }> = [];
      const { layer: applyLayer } = destroyLayer(env, { providerState, calls }, [
        buildDestroyConfirmationPhrase(plan as never),
      ]);
      await runDestroyWorkflow(runDestroyApply(env), applyLayer);
      expect(calls.some((call) => call.argv.join(" ").includes("docker compose stop"))).toBe(false);
      expect(calls.some((call) => call.argv.includes("delete-stack"))).toBe(true);
      expect((await loadState(env)).plans.destroy).toMatchObject({
        apply: { remoteStop: { skipped: true, reason: "identity-unproven" } },
      });
    },
  );

  it("does not opportunistically stop when trusted remote identity was not reviewed in the plan", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    providerState.remoteOrigin = "https://github.com/other/unrelated-project.git";
    const { layer } = destroyLayer(env, { providerState });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    expect(plan.remote).toMatchObject({ status: "identity-unproven", stopReviewed: false });

    providerState.remoteOrigin = "https://github.com/maxedapps/nusend.git";
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer: applyLayer } = destroyLayer(env, { providerState, calls }, [
      buildDestroyConfirmationPhrase(plan as never),
    ]);
    await runDestroyWorkflow(runDestroyApply(env), applyLayer);
    expect(calls.some((call) => call.argv.join(" ").includes("docker compose stop"))).toBe(false);
    expect((await loadState(env)).plans.destroy).toMatchObject({
      apply: {
        remoteStop: { skipped: true, reason: "identity-not-reviewed-or-state-changed" },
      },
    });
  });

  it("persists exact remote-stop intent before an interruption and safely retries stop", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const providerState = providerStateDefaults();
    const { layer } = destroyLayer(env, {
      calls,
      providerState,
      interruptStopOnce: true,
    });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    {
      const { layer: applyLayer } = destroyLayer(
        env,
        { calls, providerState, interruptStopOnce: true },
        [buildDestroyConfirmationPhrase(plan as never)],
      );
      // Need shared interrupt flag - recreate with same provider options carefully
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), applyLayer);
      expect(failMessage(exit)).toMatch(/simulated stop interruption|compose stop/i);
    }

    let interrupted = await loadState(env);
    // If stop failed with exit code, remoteStop may be set; if process failed before persist of outcome after intent
    const apply = interrupted.plans.destroy?.apply as Record<string, unknown> | undefined;
    expect(apply?.remoteStopIntent || apply?.remoteStop).toBeTruthy();
    expect(apply?.runtimeKeyDeleteIntent).toBeUndefined();

    const { layer: resumeLayer } = destroyLayer(env, { calls, providerState }, []);
    // may need approval already
    if (!(apply as { approved?: unknown })?.approved) {
      // re-plan if needed - shouldn't happen
    }
    await runDestroyWorkflow(runDestroyApply(env), resumeLayer);
    expect(
      calls.filter((call) => call.argv.join(" ").includes("docker compose stop")).length,
    ).toBeGreaterThanOrEqual(1);
    interrupted = await loadState(env);
    expect(interrupted.plans.destroy).toMatchObject({ consumed: true });
  });

  it("re-prompts after a new plan but not when resuming the approved plan", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const providerState = providerStateDefaults();

    const plan = await runDestroyWorkflow(
      runDestroyPlan(env),
      destroyLayer(env, { calls, providerState, interruptStopOnce: true }).layer,
    );
    {
      const { layer } = destroyLayer(env, { calls, providerState, interruptStopOnce: true }, [
        buildDestroyConfirmationPhrase(plan as never),
      ]);
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), layer);
      expect(failMessage(exit)).toMatch(/simulated stop interruption|compose stop/i);
    }
    expect(
      (await loadState(env)).plans.destroy as { apply?: { approved?: unknown } },
    ).toMatchObject({ apply: { approved: expect.anything() } });

    // Resuming the same plan keeps the approval: no prompt needed.
    {
      const { layer, terminal } = destroyLayer(env, { calls, providerState }, []);
      await runDestroyWorkflow(runDestroyApply(env), layer);
      expect(terminal.state.prompts.join(" ")).not.toContain("Destroy confirmation");
    }

    // A brand-new plan drops the approval, so apply must ask again.
    {
      const { layer } = destroyLayer(env, { calls, providerState });
      await runDestroyWorkflow(runDestroyPlan(env), layer);
    }
    expect(
      (await loadState(env)).plans.destroy as { apply?: { approved?: unknown } },
    ).not.toMatchObject({ apply: { approved: expect.anything() } });
    {
      const { layer } = destroyLayer(env, { calls, providerState }, ["DESTROY wrong"]);
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), layer);
      expect(failMessage(exit)).toMatch(/Confirmation rejected/);
    }
  });

  it("persists a reachable nonzero stop outcome and blocks AWS mutation", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const providerState = providerStateDefaults();
    const { layer } = destroyLayer(env, { providerState });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    const { layer: applyLayer } = destroyLayer(
      env,
      {
        calls,
        providerState,
        stopExitCode: 17,
        stopMessage: "docker daemon connection refused: network is unreachable",
      },
      [buildDestroyConfirmationPhrase(plan as never)],
    );
    const exit = await runDestroyWorkflowExit(runDestroyApply(env), applyLayer);
    expect(failMessage(exit)).toMatch(/docker compose stop.*failed/i);
    const interrupted = await loadState(env);
    expect(interrupted.plans.destroy).toMatchObject({
      apply: {
        remoteStopIntent: { commitSha: DEPLOY_SHA, command: "docker compose stop" },
        remoteStop: { reachable: true, stopped: false, exitCode: 17 },
      },
    });
    expect(calls.some((call) => call.argv.includes("delete-access-key"))).toBe(false);
    expect(calls.some((call) => call.argv.includes("delete-stack"))).toBe(false);
  });

  it("resumes after runtime key provider deletion using exact prior intent", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    const { layer } = destroyLayer(env, { providerState });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    {
      const { layer: applyLayer } = destroyLayer(env, { providerState, failQueueReadNumber: 3 }, [
        buildDestroyConfirmationPhrase(plan as never),
      ]);
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), applyLayer);
      expect(failMessage(exit)).toMatch(/simulated queue interruption/);
    }
    expect(providerState.keyPresent).toBe(false);
    let interrupted = await loadState(env);
    expect(interrupted.plans.destroy).toMatchObject({
      apply: {
        runtimeKeyDeleteIntent: { runtimeAccessKeyId: KEY_ID, stackId: STACK_ID },
      },
    });
    expect(
      (interrupted.plans.destroy as { apply?: { stackDeleteIntent?: unknown } }).apply
        ?.stackDeleteIntent,
    ).toBeUndefined();

    const resumeCalls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer: resumeLayer } = destroyLayer(env, {
      providerState,
      calls: resumeCalls,
    });
    await runDestroyWorkflow(runDestroyApply(env), resumeLayer);
    expect(resumeCalls.some((call) => call.argv.includes("delete-access-key"))).toBe(false);
    expect((await loadState(env)).plans.destroy).toMatchObject({ consumed: true });
  });

  it("accepts exact stack absence after interruption only with deletion-request checkpoint", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    const { layer } = destroyLayer(env, { providerState });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    {
      const { layer: applyLayer } = destroyLayer(
        env,
        { providerState, failDescribeAfterDeleteOnce: true },
        [buildDestroyConfirmationPhrase(plan as never)],
      );
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), applyLayer);
      expect(failMessage(exit)).toMatch(/simulated post-delete interruption/);
    }
    expect(providerState.stackExists).toBe(false);
    const interrupted = await loadState(env);
    expect(interrupted.plans.destroy).toMatchObject({
      apply: { stackDeleteIntent: { stackId: STACK_ID } },
    });
    expect(unwrapEnvValue((await loadDeploymentEnv(env)).AWS_ACCESS_KEY_ID!)).toBe(KEY_ID);

    const { layer: resumeLayer } = destroyLayer(env, { providerState });
    await runDestroyWorkflow(runDestroyApply(env), resumeLayer);
    expect((await loadDeploymentEnv(env)).AWS_ACCESS_KEY_ID).toBeUndefined();

    const unexplainedEnv = testEnv();
    await seedInstallation(unexplainedEnv);
    const { layer: missingLayer } = destroyLayer(unexplainedEnv, {
      providerState: { ...providerStateDefaults(), stackExists: false },
    });
    const exit = await runDestroyWorkflowExit(runDestroyPlan(unexplainedEnv), missingLayer);
    expect(failMessage(exit)).toMatch(/unexpectedly missing|deletion-request checkpoint/i);
  });

  it("reports failed logical resource and retries DELETE_FAILED on the same exact stack", async () => {
    const env = testEnv();
    await seedInstallation(env);
    const providerState = providerStateDefaults();
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer } = destroyLayer(env, { providerState, calls });
    const plan = await runDestroyWorkflow(runDestroyPlan(env), layer);
    {
      const { layer: applyLayer } = destroyLayer(env, { providerState, calls, deleteFails: true }, [
        buildDestroyConfirmationPhrase(plan as never),
      ]);
      const exit = await runDestroyWorkflowExit(runDestroyApply(env), applyLayer);
      expect(failMessage(exit)).toMatch(
        /WebhookSubscription.*endpoint still deleting|Failed logical resource/i,
      );
    }
    expect(providerState.stackStatus).toBe("DELETE_FAILED");

    const { layer: retryLayer } = destroyLayer(env, { providerState, calls });
    await runDestroyWorkflow(runDestroyApply(env), retryLayer);
    const deletes = calls.filter((call) => call.argv.includes("delete-stack"));
    expect(deletes.length).toBeGreaterThanOrEqual(2);
    expect(deletes.every((call) => call.argv.includes(STACK_ID))).toBe(true);
  });

  it("emits AccessDenied handoff and auth-expiry fail-closed without SSH mutation", async () => {
    const env = testEnv();
    await seedInstallation(env);
    {
      const { layer, terminal, calls } = destroyLayer(env, {
        accessDeniedOn: "get-queue-attributes",
      });
      const exit = await runDestroyWorkflowExit(runDestroyPlan(env), layer);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(err) && err.value instanceof AwsPermissionDeniedError).toBe(true);
      }
      expect(terminal.state.stdout.join("")).toMatch(/permission handoff/i);
      expect(calls.some((call) => call.argv.join(" ").includes("docker compose stop"))).toBe(false);
    }

    {
      // Decline the one SSO login prompt so expiry remains fail-closed without mutation.
      const { layer, calls } = destroyLayer(
        env,
        {
          expiredSessionOn: "get-caller-identity",
        },
        ["n"],
      );
      const exit = await runDestroyWorkflowExit(runDestroyPlan(env), layer);
      expect(failMessage(exit)).toMatch(
        /expired|token|sso|login declined|authentication incomplete/i,
      );
      expect(calls.some((call) => call.argv[0] === "ssh")).toBe(false);
      expect(calls.every((call) => call.argv[0] === "aws")).toBe(true);
    }
  });
});

void ACCOUNT;
