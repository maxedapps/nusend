import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { SetupStore, SetupStoreLive } from "../services/setup-store.ts";
import { secretValuesFromEnv, unwrapEnvValue } from "../state/env.ts";
import type { SetupState } from "../state/schema.ts";
import { runDeployApply } from "./apply.ts";
import {
  APPLY_CHECKPOINT_HEALTHY,
  APPLY_CHECKPOINT_IMAGES,
  APPLY_CHECKPOINT_UP,
  DEPLOY_PLAN_STORE_KEY,
  OCI_REVISION_LABEL,
} from "./constants.ts";
import { runDeployPlan } from "./plan.ts";
import {
  abbreviateSha,
  buildAppImageRef,
  buildBackupImageRef,
  buildDeployConfirmationPhrase,
  buildOpenSshRemoteCommand,
  buildRemoteEnvTransferScript,
} from "./pure.ts";
import { runDeployStageVerification } from "./stage.ts";
import {
  OTHER_SHA,
  PLANNED_SHA,
  applyExecutor,
  assertOpenSshArgvShape,
  cleanupTemps,
  deployLayer,
  opensshJoinedRemote,
  planExecutor,
  runDeployWorkflow,
  runDeployWorkflowExit,
  seedInstallation,
  testEnv,
} from "./test-harness.ts";

afterEach(() => {
  cleanupTemps();
});

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

async function writeDeploymentEnv(
  env: NodeJS.ProcessEnv,
  installationId: string,
  values: Record<string, string>,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SetupStore;
      yield* store.writeDeploymentEnv(installationId, values, env);
    }).pipe(Effect.provide(SetupStoreLive)),
  );
}

function failMessage(exit: Exit.Exit<unknown, { message: string }>): string {
  if (Exit.isSuccess(exit)) return "";
  const err = Cause.findErrorOption(exit.cause);
  return Option.isSome(err) ? err.value.message : String(exit.cause);
}

function confirmationPhrase() {
  return buildDeployConfirmationPhrase({
    sshTarget: "root@203.0.113.10",
    domain: "mail.example.com",
    remotePath: "/srv/nusend",
    releaseTag: "v0.1.2",
    commitSha: PLANNED_SHA,
  });
}

describe("deploy plan", () => {
  it("requires completed aws_core and human_gates before planning", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: false, humanGatesComplete: false });
    const { layer } = deployLayer(env, planExecutor([]));
    const exit = await runDeployWorkflowExit(runDeployPlan(env), layer);
    expect(failMessage(exit)).toMatch(/aws_core/);

    await seedInstallation(env, "prod2", { awsCoreComplete: true, humanGatesComplete: false });
    const { layer: layer2 } = deployLayer(env, planExecutor([]));
    const exit2 = await runDeployWorkflowExit(runDeployPlan(env), layer2);
    expect(failMessage(exit2)).toMatch(/human_gates/);
  });

  it("is read-only and persists planned commit/image metadata without secrets", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer, terminal } = deployLayer(env, planExecutor(calls, { pathMode: "absent" }));
    await runDeployWorkflow(runDeployPlan(env), layer);

    const state = await loadState(env, "prod");
    const plan = state.plans[DEPLOY_PLAN_STORE_KEY] as Record<string, unknown>;
    expect(plan.commitSha).toBe(PLANNED_SHA);
    expect(plan.abbreviatedSha).toBe(abbreviateSha(PLANNED_SHA));
    expect(plan.pathMode).toBe("empty");
    expect(plan.appImage).toBe(buildAppImageRef("v0.1.2"));
    expect(plan.backupImage).toBe(buildBackupImageRef("v0.1.2"));
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.composeReadiness).toMatchObject({
      mode: "local_compose_stdin_remote_render",
      remoteConfigQuiet: true,
      localComposeImageMatch: true,
    });
    expect(JSON.stringify(plan)).not.toMatch(
      /google-client-secret|restic-password-value|SecretAccessKey/i,
    );
    expect(terminal.state.stdout.join("")).toMatch(/read-only/i);
    expect(terminal.state.stdout.join("")).toMatch(/Compose render/i);

    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => /\b(mkdir|clone|pull|up|rm|mv|chmod|cat >)\b/u.test(line))).toBe(
      false,
    );
    expect(
      flat.every((line) => !/StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/u.test(line)),
    ).toBe(true);
    const stdinConfig = calls.find((call) =>
      opensshJoinedRemote(call.argv).includes("docker compose -f - config --quiet"),
    );
    expect(stdinConfig).toBeTruthy();
    expect(stdinConfig?.stdin ?? "").toContain("ghcr.io/maxedapps/nusend:v0.1.2");
    expect(stdinConfig?.stdin ?? "").not.toMatch(/google-client-secret|restic-password-value/i);
    for (const call of calls.filter((entry) => entry.argv[0] === "ssh")) {
      expect(call.argv[1]).toBe("root@203.0.113.10");
      assertOpenSshArgvShape(call.argv);
    }
  });

  it("rejects unsafe target/path and unsupported compose/arch", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const state = await loadState(env, "prod");
      await writeState(env, {
        ...state,
        config: { ...state.config, sshTarget: "root@host;evil" },
      });
      const { layer } = deployLayer(env, () =>
        Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
          argv: [] as string[],
        }),
      );
      const exit = await runDeployWorkflowExit(runDeployPlan(env), layer);
      expect(failMessage(exit)).toMatch(/unsafe|invalid/i);
    }

    await seedInstallation(env, "prod2", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const { layer } = deployLayer(
        env,
        planExecutor([], {
          pathMode: "absent",
          composeVersionText: "Docker Compose version v5.2.0",
        }),
      );
      const exit = await runDeployWorkflowExit(runDeployPlan(env), layer);
      expect(failMessage(exit)).toMatch(/Compose 5\.2\.0 is too old/);
    }

    await seedInstallation(env, "prod3", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "absent", arch: "ppc64le" }));
      const exit = await runDeployWorkflowExit(runDeployPlan(env), layer);
      expect(failMessage(exit)).toMatch(/architecture/i);
    }
  });

  it("validates existing checkout origin/tag/SHA/dirty and empty path parent", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });

    for (const [options, pattern] of [
      [
        { pathMode: "existing_git" as const, origin: "https://github.com/other/nusend.git" },
        /origin/i,
      ],
      [{ pathMode: "existing_git" as const, dirty: true }, /dirty/i],
      [{ pathMode: "existing_git" as const, head: OTHER_SHA }, /HEAD/i],
      [{ pathMode: "existing_git" as const, branch: "main" }, /branch/i],
      [{ pathMode: "nonempty_not_git" as const }, /not usable|non-git|partial/i],
      [{ pathMode: "existing_git" as const, tagSha: "" }, /missing local release tag|exact tag/i],
    ] as const) {
      const { layer } = deployLayer(env, planExecutor([], options));
      const exit = await runDeployWorkflowExit(runDeployPlan(env), layer);
      expect(failMessage(exit)).toMatch(pattern);
    }
  });

  it("does not mutate when planning an existing clean checkout and runs dummy compose config", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer } = deployLayer(env, planExecutor(calls, { pathMode: "existing_git" }));
    await runDeployWorkflow(runDeployPlan(env), layer);
    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => line.includes("docker compose config --quiet"))).toBe(true);
    expect(flat.some((line) => /\bgit clone\b|\bpull\b|\bup\b/u.test(line))).toBe(false);
    const state = await loadState(env, "prod");
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({ pathMode: "existing" });
  });
});

describe("deploy apply", () => {
  it("rejects missing/stale/fingerprint mismatch/moved git tag and confirmation mismatch", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });

    {
      const { layer } = deployLayer(env, applyExecutor({}));
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(/No stored deploy plan/);
    }

    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "absent" }));
      await runDeployWorkflow(runDeployPlan(env), layer);
    }

    {
      const { layer } = deployLayer(env, applyExecutor({}), ["DEPLOY wrong"]);
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(/Confirmation rejected/);
    }

    {
      const { layer } = deployLayer(env, applyExecutor({ lsRemoteSha: OTHER_SHA }), [
        confirmationPhrase(),
      ]);
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(/moved|now points/i);
    }

    {
      const state = await loadState(env, "prod");
      await writeState(env, {
        ...state,
        config: { ...state.config, domain: "other.example.com" },
        plans: {
          ...state.plans,
          [DEPLOY_PLAN_STORE_KEY]: {
            ...(state.plans[DEPLOY_PLAN_STORE_KEY] as object),
            domain: "other.example.com",
          },
        },
      });
      const { layer } = deployLayer(env, applyExecutor({}), [
        buildDeployConfirmationPhrase({
          sshTarget: "root@203.0.113.10",
          domain: "other.example.com",
          remotePath: "/srv/nusend",
          releaseTag: "v0.1.2",
          commitSha: PLANNED_SHA,
        }),
      ]);
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(/fingerprint|does not match/i);
    }
  });

  it("clones empty targets, transfers env via stdin only, and refuses dirty checkout", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const deployment = await loadDeploymentEnv(env, "prod");
    const secrets = secretValuesFromEnv(deployment);

    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "absent" }));
      await runDeployWorkflow(runDeployPlan(env), layer);
    }

    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer } = deployLayer(env, applyExecutor({ calls, pathModeAfterPlan: "absent" }), [
      confirmationPhrase(),
    ]);
    await runDeployWorkflow(runDeployApply(env), layer);

    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => line.includes("git clone"))).toBe(true);
    const transfer = calls.find((call) => opensshJoinedRemote(call.argv).includes(".env.tmp"));
    expect(transfer).toBeTruthy();
    expect(transfer?.stdin ?? "").toContain("mail.example.com");
    expect(transfer?.stdin ?? "").toContain(unwrapEnvValue(deployment.BETTER_AUTH_SECRET!));
    for (const secret of secrets) {
      expect(JSON.stringify(calls.map((c) => c.argv))).not.toContain(secret);
    }
    assertOpenSshArgvShape(transfer!.argv);
    expect(transfer!.argv[2]).toBe(
      buildOpenSshRemoteCommand(buildRemoteEnvTransferScript("/srv/nusend/.env")),
    );

    const state = await loadState(env, "prod");
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_HEALTHY,
      consumed: true,
    });
    expect(state.deploy).toMatchObject({
      commitSha: PLANNED_SHA,
      releaseTag: "v0.1.2",
    });

    await seedInstallation(env, "dirty", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const { layer: planLayer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), planLayer);
    }
    {
      const { layer: applyLayer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git", dirtyAtApply: true }),
        [confirmationPhrase()],
      );
      const exit = await runDeployWorkflowExit(runDeployApply(env), applyLayer);
      expect(failMessage(exit)).toMatch(/dirty/i);
    }
  });

  it("refuses moved image labels and compose config/pull/up failures", async () => {
    for (const [id, failOptions, pattern] of [
      ["img", { imageRevision: OTHER_SHA }, new RegExp(OCI_REVISION_LABEL)],
      ["cfg", { failAt: "config" as const }, /config/i],
      ["pull", { failAt: "pull" as const }, /pull/i],
      ["up", { failAt: "up" as const }, /up/i],
    ] as const) {
      const env = testEnv();
      await seedInstallation(env, id, { awsCoreComplete: true, humanGatesComplete: true });
      const { layer: planLayer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), planLayer);
      const { layer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git", ...failOptions }),
        [confirmationPhrase()],
      );
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(pattern);
    }
  });

  it("validates health outcomes and resumes from checkpoints without moved-tag adoption", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), layer);
    }

    {
      const { layer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git", publicHealthCode: "500" }),
        [confirmationPhrase()],
      );
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(/Public \/health/);
    }

    let state = await loadState(env, "prod");
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_UP,
      consumed: false,
    });

    {
      const { layer, terminal } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git" }),
        ["nope"],
      );
      await runDeployWorkflow(runDeployApply(env), layer);
      expect(terminal.state.prompts).toHaveLength(0);
    }
    state = await loadState(env, "prod");
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_HEALTHY,
      consumed: true,
    });

    for (const [id, options, pattern] of [
      ["db404", { publicDbCode: "200" }, /Public \/health\/db/],
      ["backup", { missingService: "backup" }, /backup/],
      ["apihealth", { apiHealth: "unhealthy" }, /api/i],
    ] as const) {
      await seedInstallation(env, id, { awsCoreComplete: true, humanGatesComplete: true });
      const { layer: planLayer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), planLayer);
      const { layer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git", ...options }),
        [confirmationPhrase()],
      );
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(pattern);
    }

    await seedInstallation(env, "runningonly", {
      awsCoreComplete: true,
      humanGatesComplete: true,
    });
    {
      const { layer: planLayer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), planLayer);
      const { layer } = deployLayer(
        env,
        applyExecutor({
          pathModeAfterPlan: "existing_git",
          caddyHealth: "",
          workerHealth: "",
        }),
        [confirmationPhrase()],
      );
      await runDeployWorkflow(runDeployApply(env), layer);
    }
    expect((await loadState(env, "runningonly")).plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_HEALTHY,
    });
  });

  it("resume after failure re-transfers current local env and replays up without confirmation/clone/delete", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), layer);
    }
    {
      const { layer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git", failAt: "up" }),
        [confirmationPhrase()],
      );
      const exit = await runDeployWorkflowExit(runDeployApply(env), layer);
      expect(failMessage(exit)).toMatch(/up/i);
    }

    const failed = await loadState(env, "prod");
    expect(failed.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_IMAGES,
      consumed: false,
    });

    const deployment = await loadDeploymentEnv(env, "prod");
    const plain: Record<string, string> = {};
    for (const [key, value] of Object.entries(deployment)) {
      plain[key] = unwrapEnvValue(value);
    }
    plain.NUSEND_OWNER_NAME = "Resume Corrected Owner";
    await writeDeploymentEnv(env, "prod", plain);

    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer, terminal } = deployLayer(
      env,
      applyExecutor({ calls, pathModeAfterPlan: "existing_git" }),
      ["nope"],
    );
    await runDeployWorkflow(runDeployApply(env), layer);
    expect(terminal.state.prompts).toHaveLength(0);

    const transferCalls = calls.filter((call) =>
      opensshJoinedRemote(call.argv).includes(".env.tmp"),
    );
    expect(transferCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      transferCalls.some((call) => (call.stdin ?? "").includes("Resume Corrected Owner")),
    ).toBe(true);
    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => line.includes("docker compose up -d --wait"))).toBe(true);
    expect(flat.some((line) => line.includes("git clone"))).toBe(false);
    expect(flat.some((line) => /\brm\s+-rf\b|down\s+-v/u.test(line))).toBe(false);
  });

  it("treats partial clone as existing and never deletes it", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "absent" }));
      await runDeployWorkflow(runDeployPlan(env), layer);
    }
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const { layer } = deployLayer(
      env,
      applyExecutor({ calls, pathModeAfterPlan: "existing_git" }),
      [confirmationPhrase()],
    );
    await runDeployWorkflow(runDeployApply(env), layer);
    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => line.includes("git clone"))).toBe(false);
    expect(flat.some((line) => /\brm\s+-rf\b/u.test(line))).toBe(false);
  });
});

describe("deploy stage verification", () => {
  it("requires healthy apply evidence and revalidates live health", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });

    {
      const { layer } = deployLayer(env, applyExecutor({}));
      const exit = await runDeployWorkflowExit(runDeployStageVerification(env), layer);
      expect(failMessage(exit)).toMatch(/no deploy plan|blocked/i);
    }

    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), layer);
      const { layer: applyLayer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git" }),
        [confirmationPhrase()],
      );
      await runDeployWorkflow(runDeployApply(env), applyLayer);
    }

    const { layer } = deployLayer(env, applyExecutor({ pathModeAfterPlan: "existing_git" }));
    const evidence = await runDeployWorkflow(runDeployStageVerification(env), layer);
    expect(evidence).toMatchObject({
      verified: true,
      commitSha: PLANNED_SHA,
      releaseTag: "v0.1.2",
    });
  });

  it("rejects hybrid, unhealthy, and mismatched deploy stage evidence", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    {
      const { layer } = deployLayer(env, planExecutor([], { pathMode: "existing_git" }));
      await runDeployWorkflow(runDeployPlan(env), layer);
      const { layer: applyLayer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git" }),
        [confirmationPhrase()],
      );
      await runDeployWorkflow(runDeployApply(env), applyLayer);
    }

    const good = await loadState(env, "prod");
    await writeState(env, {
      ...good,
      deploy: {
        ...(good.deploy as object),
        domain: "other.example.com",
      },
    });
    {
      const { layer } = deployLayer(env, applyExecutor({ pathModeAfterPlan: "existing_git" }));
      const exit = await runDeployWorkflowExit(runDeployStageVerification(env), layer);
      expect(failMessage(exit)).toMatch(/domain|does not exactly match|installation config/i);
    }

    await writeState(env, good);
    {
      const { layer } = deployLayer(
        env,
        applyExecutor({ pathModeAfterPlan: "existing_git", publicHealthCode: "503" }),
      );
      const exit = await runDeployWorkflowExit(runDeployStageVerification(env), layer);
      expect(failMessage(exit)).toMatch(/Public \/health/);
    }
  });
});
