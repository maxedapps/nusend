import { Clock, Effect } from "effect";

import { ask, writeLine } from "../commands/prompts.ts";
import { SetupStore } from "../services/setup-store.ts";
import { secretValuesFromEnv, serializeDeploymentEnv } from "../state/env.ts";
import type { PathEnvironment } from "../state/paths.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { SetupState } from "../state/schema.ts";
import {
  APPLY_CHECKPOINT_CLONED,
  APPLY_CHECKPOINT_CONFIG,
  APPLY_CHECKPOINT_ENV,
  APPLY_CHECKPOINT_HEALTHY,
  APPLY_CHECKPOINT_IMAGES,
  APPLY_CHECKPOINT_PULLED,
  APPLY_CHECKPOINT_UP,
  DEPLOY_PLAN_STORE_KEY,
  PUBLIC_REPO_URL,
} from "./constants.ts";
import type { DeployWorkflowError, DeployWorkflowServices } from "./plan.ts";
import {
  abbreviateSha,
  assertArgvFreeOfSecrets,
  assertSafeRemotePath,
  buildDeployConfirmationPhrase,
  buildRemoteCloneScript,
  buildRemoteEnvTransferScript,
  extractComposeImageTags,
  fingerprintDeployPlan,
  posixSingleQuote,
  validateDeployConfirmation,
} from "./pure.ts";
import {
  assertRemoteImageRevision,
  inspectExistingCheckout,
  inspectRemotePath,
  resolveReleaseCommitSha,
  validateDeployHealth,
} from "./remote.ts";
import { failCommand, runSsh, trySyncCommand } from "./ssh.ts";

export function runDeployApply(
  env: PathEnvironment = process.env,
): Effect.Effect<
  { readonly commitSha: string; readonly health: unknown; readonly state: SetupState },
  DeployWorkflowError,
  DeployWorkflowServices
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    let state = yield* store.loadState(installationId, env);
    const plan = state.plans?.[DEPLOY_PLAN_STORE_KEY];
    if (plan == null || typeof plan !== "object") {
      return yield* failCommand(
        "No stored deploy plan. Run `pnpm nusend:setup deploy plan` first.",
      );
    }
    if (plan.consumed === true && plan.applyCheckpoint === APPLY_CHECKPOINT_HEALTHY) {
      return yield* failCommand(
        "Stored deploy plan is already consumed after a healthy apply. Re-run `pnpm nusend:setup deploy plan` before applying again.",
      );
    }

    const sshTarget = String(plan.sshTarget ?? "");
    const domain = String(plan.domain ?? "");
    const remotePath = String(plan.remotePath ?? "");
    const releaseTag = String(plan.releaseTag ?? "");
    const commitSha = String(plan.commitSha ?? "");
    const fingerprint = String(plan.fingerprint ?? "");
    const pathMode = String(plan.pathMode ?? "");
    const appImage = String(plan.appImage ?? "");
    const backupImage = String(plan.backupImage ?? "");
    let applyCheckpoint =
      typeof plan.applyCheckpoint === "string" && plan.applyCheckpoint
        ? String(plan.applyCheckpoint)
        : null;

    if (!sshTarget || !domain || !remotePath || !releaseTag || !commitSha || !fingerprint) {
      return yield* failCommand(
        "Stored deploy plan is incomplete. Re-run `pnpm nusend:setup deploy plan`.",
      );
    }
    if (sshTarget !== state.config.sshTarget) {
      return yield* failCommand(
        "Stored deploy plan SSH target does not match installation config.",
      );
    }
    if (domain !== state.config.domain) {
      return yield* failCommand("Stored deploy plan domain does not match installation config.");
    }
    if (remotePath !== state.config.remotePath) {
      return yield* failCommand(
        "Stored deploy plan remote path does not match installation config.",
      );
    }
    if (releaseTag !== state.config.releaseTag) {
      return yield* failCommand(
        "Stored deploy plan release tag does not match installation config.",
      );
    }
    if (pathMode !== "empty" && pathMode !== "existing") {
      return yield* failCommand(`Stored deploy plan has invalid pathMode "${pathMode}".`);
    }

    const liveSha = yield* resolveReleaseCommitSha(releaseTag);
    if (liveSha !== commitSha) {
      return yield* failCommand(
        `Release tag ${releaseTag} now points at ${liveSha}, not planned ${commitSha}. Re-run deploy plan; refusing moved tag adoption.`,
      );
    }

    const currentFingerprint = fingerprintDeployPlan({
      ...plan,
      commitSha,
      releaseTag,
      sshTarget,
      remotePath,
      domain,
      pathMode,
      architecture: plan.architecture,
      appImage,
      backupImage,
      dockerVersion: plan.dockerVersion,
      composeVersion: plan.composeVersion,
    });
    if (currentFingerprint !== fingerprint) {
      return yield* failCommand(
        "Stored deploy plan fingerprint does not match current plan inputs. Re-run `pnpm nusend:setup deploy plan`.",
      );
    }

    const expectedPhrase = buildDeployConfirmationPhrase({
      sshTarget,
      domain,
      remotePath,
      releaseTag,
      commitSha,
    });

    if (!applyCheckpoint) {
      yield* writeLine(
        `About to deploy ${releaseTag} (${abbreviateSha(commitSha)}) to ${sshTarget}:${remotePath}.`,
      );
      yield* writeLine(`Type exactly: ${expectedPhrase}`);
      const answer = yield* ask("Confirmation: ", true);
      yield* trySyncCommand(() =>
        validateDeployConfirmation(answer, {
          sshTarget,
          domain,
          remotePath,
          releaseTag,
          commitSha,
        }),
      );
    } else {
      yield* writeLine(
        `Resuming deploy apply from checkpoint "${applyCheckpoint}" (no moved-tag adoption; env/volumes/checkout preserved).`,
      );
    }

    const deployment = yield* store.loadDeploymentEnv(installationId, env);
    const secrets = secretValuesFromEnv(deployment);
    const envBody = serializeDeploymentEnv(deployment);
    for (const secret of secrets) {
      if (secret && expectedPhrase.includes(secret)) {
        return yield* failCommand(
          "Internal error: confirmation phrase unexpectedly contained a secret.",
        );
      }
    }

    const persistCheckpoint = (
      checkpoint: string | null,
      extra: Record<string, unknown> = {},
    ): Effect.Effect<void, DeployWorkflowError, DeployWorkflowServices> =>
      Effect.gen(function* () {
        applyCheckpoint = checkpoint;
        const nowMillis = yield* Clock.currentTimeMillis;
        const now = new Date(nowMillis).toISOString();
        state = yield* store.loadState(installationId, env);
        const previous = state.plans?.[DEPLOY_PLAN_STORE_KEY] ?? plan;
        const next: SetupState = {
          ...state,
          updatedAt: now,
          plans: {
            ...state.plans,
            [DEPLOY_PLAN_STORE_KEY]: sanitizePlanMetadata({
              ...previous,
              ...extra,
              applyCheckpoint: checkpoint,
              lastApplyAt: now,
              consumed: checkpoint === APPLY_CHECKPOINT_HEALTHY,
            }),
          },
        };
        const withDeploy: SetupState =
          checkpoint === APPLY_CHECKPOINT_HEALTHY
            ? {
                ...next,
                deploy: sanitizePlanMetadata({
                  commitSha,
                  releaseTag,
                  sshTarget,
                  remotePath,
                  domain,
                  appImage,
                  backupImage,
                  appliedAt: now,
                  fingerprint,
                }),
              }
            : next;
        yield* store.writeState(withDeploy, env);
        state = withDeploy;
      });

    if (!applyCheckpoint) {
      if (pathMode === "empty") {
        const pathInfo = yield* inspectRemotePath(state, remotePath);
        if (pathInfo.mode === "existing_git") {
          yield* writeLine(
            "Remote path already has a git checkout; validating instead of deleting/cloning.",
          );
          yield* inspectExistingCheckout(state, remotePath, releaseTag, commitSha);
        } else if (pathInfo.mode === "absent" || pathInfo.mode === "empty") {
          yield* writeLine(`Cloning ${PUBLIC_REPO_URL} at ${releaseTag} into ${remotePath}.`);
          const cloneScript = yield* trySyncCommand(() =>
            buildRemoteCloneScript(remotePath, releaseTag, commitSha),
          );
          const clone = yield* runSsh(state, cloneScript);
          const head = clone.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
          if (head !== commitSha) {
            return yield* failCommand(
              `Clone HEAD ${head} does not match planned commit ${commitSha}.`,
            );
          }
        } else {
          return yield* failCommand(
            `Cannot clone into ${remotePath}: ${pathInfo.detail}. Existing partial content is never deleted.`,
          );
        }
      } else {
        yield* inspectExistingCheckout(state, remotePath, releaseTag, commitSha);
      }
      yield* persistCheckpoint(APPLY_CHECKPOINT_CLONED);
    } else if (applyCheckpoint !== APPLY_CHECKPOINT_HEALTHY) {
      yield* inspectExistingCheckout(state, remotePath, releaseTag, commitSha);
      if (applyCheckpoint !== APPLY_CHECKPOINT_CLONED) {
        yield* writeLine(
          `Resetting resume checkpoint "${applyCheckpoint}" to "${APPLY_CHECKPOINT_CLONED}" to re-transfer env and replay config→pull→images→up→health (volumes/checkout preserved).`,
        );
        yield* persistCheckpoint(APPLY_CHECKPOINT_CLONED);
      }
    }

    if (applyCheckpoint === APPLY_CHECKPOINT_CLONED) {
      const safePath = yield* trySyncCommand(() => assertSafeRemotePath(remotePath));
      const remoteEnvPath = `${safePath}/.env`;
      const transferScript = yield* trySyncCommand(() =>
        buildRemoteEnvTransferScript(remoteEnvPath),
      );
      yield* writeLine(
        "Transferring deployment.env over SSH stdin to a mode-0600 temp file with atomic rename.",
      );
      const transfer = yield* runSsh(state, transferScript, {
        stdin: envBody,
        redact: secrets,
      });
      yield* trySyncCommand(() => assertArgvFreeOfSecrets(transfer.argv, secrets));
      const modeCheck = yield* runSsh(
        state,
        `stat -c '%a' ${posixSingleQuote(remoteEnvPath)} 2>/dev/null || stat -f '%OLp' ${posixSingleQuote(remoteEnvPath)}`,
        { redact: secrets },
      );
      const mode = modeCheck.stdout.trim();
      if (mode !== "600" && mode !== "0600") {
        return yield* failCommand(`Remote .env mode is ${mode || "unknown"}; expected 600.`);
      }
      yield* persistCheckpoint(APPLY_CHECKPOINT_ENV, { remoteEnvMode: "600" });
    }

    if (applyCheckpoint === APPLY_CHECKPOINT_ENV) {
      yield* writeLine("Running remote docker compose config --quiet.");
      yield* runSsh(state, `cd ${posixSingleQuote(remotePath)} && docker compose config --quiet`, {
        redact: secrets,
      });
      yield* persistCheckpoint(APPLY_CHECKPOINT_CONFIG);
    }

    if (applyCheckpoint === APPLY_CHECKPOINT_CONFIG) {
      yield* writeLine("Running remote docker compose pull.");
      yield* runSsh(state, `cd ${posixSingleQuote(remotePath)} && docker compose pull`, {
        redact: secrets,
      });
      yield* persistCheckpoint(APPLY_CHECKPOINT_PULLED);
    }

    if (applyCheckpoint === APPLY_CHECKPOINT_PULLED) {
      yield* writeLine(
        "Verifying app/backup image OCI source-revision labels match planned commit.",
      );
      yield* assertRemoteImageRevision(state, appImage, commitSha);
      yield* assertRemoteImageRevision(state, backupImage, commitSha);
      const remoteCompose = yield* runSsh(
        state,
        `cd ${posixSingleQuote(remotePath)} && cat compose.yaml`,
      );
      const remoteImages = extractComposeImageTags(remoteCompose.stdout, releaseTag);
      if (!remoteImages.matchesRelease) {
        return yield* failCommand(
          `Remote compose image tags do not match release ${releaseTag} before up.`,
        );
      }
      if (remoteImages.appImage !== appImage || remoteImages.backupImage !== backupImage) {
        return yield* failCommand(
          "Remote compose image refs do not match planned exact tag image refs.",
        );
      }
      yield* persistCheckpoint(APPLY_CHECKPOINT_IMAGES, {
        appImageRevision: commitSha,
        backupImageRevision: commitSha,
      });
    }

    if (applyCheckpoint === APPLY_CHECKPOINT_IMAGES) {
      yield* writeLine("Running remote docker compose up -d --wait.");
      yield* runSsh(state, `cd ${posixSingleQuote(remotePath)} && docker compose up -d --wait`, {
        redact: secrets,
      });
      yield* persistCheckpoint(APPLY_CHECKPOINT_UP);
    }

    if (applyCheckpoint === APPLY_CHECKPOINT_UP) {
      yield* writeLine(
        "Validating Compose service/backup health and public/private health endpoints.",
      );
      const health = yield* validateDeployHealth(state, {
        domain,
        remotePath,
        secrets,
      });
      yield* persistCheckpoint(APPLY_CHECKPOINT_HEALTHY, { health });
      yield* writeLine(
        `Deploy apply complete for ${releaseTag} (${abbreviateSha(commitSha)}). continue can checkpoint deploy on live health evidence.`,
      );
      return { commitSha, health, state };
    }

    return yield* failCommand(
      `Deploy apply stopped in unexpected checkpoint state: ${applyCheckpoint}`,
    );
  });
}
