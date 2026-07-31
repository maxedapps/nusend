import { Effect } from "effect";

import type { StageHandler } from "../commands/continue.ts";
import { writeLine } from "../commands/prompts.ts";
import { SetupStore } from "../services/setup-store.ts";
import { secretValuesFromEnv } from "../state/env.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import { APPLY_CHECKPOINT_HEALTHY, DEPLOY_PLAN_STORE_KEY } from "./constants.ts";
import { runHumanGatesStep } from "./human-gates.ts";
import type { DeployWorkflowError, DeployWorkflowServices } from "./plan.ts";
import { fingerprintDeployPlan } from "./pure.ts";
import {
  assertRemoteImageRevision,
  inspectExistingCheckout,
  resolveReleaseCommitSha,
  validateDeployHealth,
} from "./remote.ts";
import { failCommand } from "./ssh.ts";

export function runDeployStageVerification(
  env: PathEnvironment = process.env,
  initialState?: SetupState,
): Effect.Effect<Record<string, unknown>, DeployWorkflowError, DeployWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId =
      initialState?.installationId ?? (yield* store.resolveInstallationId(env));
    const state = yield* store.loadState(installationId, env);
    const plan = state.plans?.[DEPLOY_PLAN_STORE_KEY];
    const deploy = state.deploy;
    if (plan == null || typeof plan !== "object") {
      return yield* failCommand(
        "Deploy stage is blocked: no deploy plan/apply evidence. Run `pnpm nusend:setup deploy plan` then `deploy apply`.",
      );
    }
    if (plan.applyCheckpoint !== APPLY_CHECKPOINT_HEALTHY || plan.consumed !== true) {
      return yield* failCommand(
        "Deploy stage is blocked: deploy plan has no completed healthy apply checkpoint.",
      );
    }
    if (deploy == null || typeof deploy !== "object" || Array.isArray(deploy)) {
      return yield* failCommand(
        "Deploy stage is blocked: complete state.deploy evidence is missing.",
      );
    }

    const requiredDeployFields = [
      "commitSha",
      "releaseTag",
      "sshTarget",
      "remotePath",
      "domain",
      "appImage",
      "backupImage",
      "appliedAt",
      "fingerprint",
    ] as const;
    for (const field of requiredDeployFields) {
      if (typeof deploy[field] !== "string" || !deploy[field]) {
        return yield* failCommand(`Deploy stage is blocked: state.deploy.${field} is missing.`);
      }
    }
    const planFingerprint = String(plan.fingerprint ?? "");
    if (!planFingerprint || fingerprintDeployPlan(plan) !== planFingerprint) {
      return yield* failCommand("Deploy stage is blocked: healthy plan fingerprint is invalid.");
    }
    for (const field of [
      "fingerprint",
      "commitSha",
      "releaseTag",
      "sshTarget",
      "remotePath",
      "domain",
      "appImage",
      "backupImage",
    ] as const) {
      if (deploy[field] !== plan[field]) {
        return yield* failCommand(
          `Deploy stage is blocked: state.deploy.${field} does not exactly match the healthy plan.`,
        );
      }
    }
    for (const [field, configured] of Object.entries({
      releaseTag: state.config.releaseTag,
      sshTarget: state.config.sshTarget,
      remotePath: state.config.remotePath,
      domain: state.config.domain,
    })) {
      if (deploy[field] !== configured) {
        return yield* failCommand(
          `Deploy stage is blocked: state.deploy.${field} does not match installation config.`,
        );
      }
    }

    const commitSha = String(deploy.commitSha);
    const releaseTag = String(deploy.releaseTag);
    const domain = String(deploy.domain);
    const remotePath = String(deploy.remotePath);
    const appImage = String(deploy.appImage);
    const backupImage = String(deploy.backupImage);

    const liveSha = yield* resolveReleaseCommitSha(releaseTag);
    if (liveSha !== commitSha) {
      return yield* failCommand(
        `Deploy stage is blocked: release tag ${releaseTag} moved to ${liveSha} (planned ${commitSha}).`,
      );
    }

    yield* inspectExistingCheckout(state, remotePath, releaseTag, commitSha);
    yield* assertRemoteImageRevision(state, appImage, commitSha);
    yield* assertRemoteImageRevision(state, backupImage, commitSha);

    const secrets = yield* store.loadDeploymentEnv(installationId, env).pipe(
      Effect.map((deployment) => secretValuesFromEnv(deployment)),
      Effect.catchTag("SetupStoreError", () => Effect.succeed([] as string[])),
    );

    yield* writeLine("Re-validating live deploy health before checkpoint.");
    const health = yield* validateDeployHealth(state, { domain, remotePath, secrets });

    return {
      verified: true,
      commitSha,
      releaseTag,
      domain,
      remotePath,
      appImage,
      backupImage,
      health,
    };
  });
}

export function humanGatesStageHandler(env: PathEnvironment = process.env): StageHandler {
  return {
    isEligible: (state) => Effect.succeed(state.stages.aws_core?.status === "complete"),
    run: (state) => runHumanGatesStep(env, state),
  };
}

export function deployStageHandler(env: PathEnvironment = process.env): StageHandler {
  return {
    isEligible: (state) => Effect.succeed(state.stages.human_gates?.status === "complete"),
    run: (state) => runDeployStageVerification(env, state),
  };
}
