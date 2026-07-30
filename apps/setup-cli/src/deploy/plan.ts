import { readFile } from "node:fs/promises";

import { Clock, Effect } from "effect";

import { writeLine } from "../commands/prompts.ts";
import {
  CancellationError,
  ProcessFailedError,
  ProcessSignalError,
  ProcessStartError,
  SetupCommandError,
  SetupStoreError,
  TerminalError,
} from "../errors.ts";
import type { ProcessRunnerService } from "../process-runner.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import type { PathEnvironment } from "../state/paths.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { TerminalService } from "../terminal.ts";
import {
  DEPLOY_PLAN_STORE_KEY,
  LOCAL_COMPOSE_PATH,
  OCI_REVISION_LABEL,
  PUBLIC_REPO_URL,
} from "./constants.ts";
import { assertReleaseTag } from "../state/schema.ts";
import {
  abbreviateSha,
  assertSafeRemotePath,
  assertSshTarget,
  buildAppImageRef,
  buildBackupImageRef,
  buildComposeConfigDummyAssignments,
  buildRemoteComposeConfigCommand,
  buildRemoteComposeConfigFromStdinCommand,
  extractComposeImageTags,
  fingerprintDeployPlan,
  posixSingleQuote,
} from "./pure.ts";
import {
  inspectExistingCheckout,
  inspectRemotePath,
  inspectRemoteRuntime,
  resolveReleaseCommitSha,
} from "./remote.ts";
import { failCommand, runSsh, trySyncCommand } from "./ssh.ts";

export type DeployWorkflowError =
  | SetupCommandError
  | SetupStoreError
  | CancellationError
  | TerminalError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError;

export type DeployWorkflowServices = SetupStoreService | ProcessRunnerService | TerminalService;

export function runDeployPlan(
  env: PathEnvironment = process.env,
): Effect.Effect<Record<string, unknown>, DeployWorkflowError, DeployWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);

    if (state.stages.aws_core?.status !== "complete") {
      return yield* failCommand(
        "Deploy plan requires completed aws_core stage. Finish AWS core setup before deploy plan.",
      );
    }
    if (state.stages.human_gates?.status !== "complete") {
      return yield* failCommand(
        "Deploy plan requires completed human_gates stage. Finish human/external gates before deploy plan.",
      );
    }

    const sshTarget = yield* trySyncCommand(() => assertSshTarget(state.config.sshTarget));
    const remotePath = yield* trySyncCommand(() => assertSafeRemotePath(state.config.remotePath));
    const releaseTag = yield* trySyncCommand(() => assertReleaseTag(state.config.releaseTag));
    const domain = state.config.domain;

    yield* writeLine(
      "Deploy plan (read-only SSH inspection; no remote mkdir/clone/write/pull/up).",
    );

    const commitSha = yield* resolveReleaseCommitSha(releaseTag);
    const abbreviatedSha = abbreviateSha(commitSha);
    yield* writeLine(`Release ${releaseTag} -> ${commitSha}`);

    const localCompose = yield* Effect.tryPromise({
      try: () => readFile(LOCAL_COMPOSE_PATH, "utf8"),
      catch: (cause) =>
        new SetupCommandError({
          message:
            cause instanceof Error
              ? `Failed to read local compose.yaml: ${cause.message}`
              : "Failed to read local compose.yaml.",
        }),
    });
    const localImages = extractComposeImageTags(localCompose, releaseTag);
    if (!localImages.matchesRelease) {
      return yield* failCommand(
        `Local compose.yaml image tags (app=${localImages.appTag}, backup=${localImages.backupTag}) do not match release ${releaseTag}.`,
      );
    }

    const runtime = yield* inspectRemoteRuntime(state);
    const pathInfo = yield* inspectRemotePath(state, remotePath);

    let pathMode: "empty" | "existing";
    let checkout: Record<string, unknown> = {};
    let composeReadiness: Record<string, unknown> = {};

    if (pathInfo.mode === "absent" || pathInfo.mode === "empty") {
      pathMode = "empty";
      const dummy = buildComposeConfigDummyAssignments(state);
      const configCmd = buildRemoteComposeConfigFromStdinCommand(dummy);
      yield* runSsh(state, configCmd, { stdin: localCompose });
      composeReadiness = {
        mode: "local_compose_stdin_remote_render",
        limitation:
          "Empty remote path has no checkout yet. Compose config was rendered remotely from local compose.yaml over SSH stdin with inline dummy non-secret env; no remote files were written and real secrets were not used.",
        localComposeImageMatch: true,
        remoteConfigQuiet: true,
        remoteEngineReady: true,
      };
      yield* writeLine(`Remote path ${remotePath}: empty target (${pathInfo.detail}).`);
      yield* writeLine("Remote Compose render (stdin compose.yaml + dummy env) succeeded.");
    } else if (pathInfo.mode === "existing_git") {
      pathMode = "existing";
      checkout = yield* inspectExistingCheckout(state, remotePath, releaseTag, commitSha);
      const dummy = buildComposeConfigDummyAssignments(state);
      const configCmd = buildRemoteComposeConfigCommand(remotePath, dummy);
      yield* runSsh(state, configCmd);
      const remoteCompose = yield* runSsh(
        state,
        `cd ${posixSingleQuote(remotePath)} && cat compose.yaml`,
      );
      const remoteImages = extractComposeImageTags(remoteCompose.stdout, releaseTag);
      if (!remoteImages.matchesRelease) {
        return yield* failCommand(
          `Remote compose.yaml image tags (app=${remoteImages.appTag}, backup=${remoteImages.backupTag}) do not match release ${releaseTag}.`,
        );
      }
      composeReadiness = {
        mode: "remote_compose_config_with_dummy_env",
        limitation:
          "Compose config used inline dummy non-secret placeholder values via env; real deployment.env was not transferred or printed.",
        remoteComposeImageMatch: true,
        configQuiet: true,
      };
      yield* writeLine(`Remote path ${remotePath}: existing clean checkout at ${commitSha}.`);
    } else {
      return yield* failCommand(
        `Remote path ${remotePath} is not usable for deploy (${pathInfo.detail}). Partial non-git content is never deleted automatically.`,
      );
    }

    const appImage = yield* trySyncCommand(() => buildAppImageRef(releaseTag));
    const backupImage = yield* trySyncCommand(() => buildBackupImageRef(releaseTag));
    const nowMillis = yield* Clock.currentTimeMillis;
    const plannedAt = new Date(nowMillis).toISOString();
    const planBody: Record<string, unknown> = {
      kind: "deploy",
      plannedAt,
      installationId,
      sshTarget,
      domain,
      remotePath,
      releaseTag,
      commitSha,
      abbreviatedSha,
      pathMode,
      architecture: runtime.architecture,
      architectureRaw: runtime.architectureRaw,
      dockerVersion: runtime.dockerVersion,
      composeVersion: runtime.composeVersion,
      ports: runtime.ports,
      appImage,
      backupImage,
      ociRevisionLabel: OCI_REVISION_LABEL,
      repository: PUBLIC_REPO_URL,
      checkout,
      composeReadiness,
      commands: {
        clone:
          pathMode === "empty"
            ? `git clone --branch ${releaseTag} ${PUBLIC_REPO_URL} ${remotePath}`
            : null,
        composeConfig: "docker compose config --quiet",
        pull: "docker compose pull",
        up: "docker compose up -d --wait",
        imageInspect: `docker image inspect --format={{ index .Config.Labels "${OCI_REVISION_LABEL}" }}`,
      },
      consumed: false,
      applyCheckpoint: null,
    };
    const fingerprint = fingerprintDeployPlan(planBody);
    planBody.fingerprint = fingerprint;

    yield* store.writeState(
      {
        ...state,
        updatedAt: plannedAt,
        plans: {
          ...state.plans,
          [DEPLOY_PLAN_STORE_KEY]: sanitizePlanMetadata(planBody),
        },
      },
      env,
    );

    yield* writeLine(
      `Architecture: linux/${runtime.architecture} (raw ${runtime.architectureRaw})`,
    );
    yield* writeLine(`Docker ${runtime.dockerVersion}; Compose ${runtime.composeVersion}`);
    yield* writeLine(
      `Ports context: 80=${runtime.ports.listening80 ? "listen" : "free/unknown"}, 443=${runtime.ports.listening443 ? "listen" : "free/unknown"} (informational)`,
    );
    yield* writeLine(`Images: ${appImage}, ${backupImage}`);
    yield* writeLine(`Fingerprint: ${fingerprint}`);
    yield* writeLine(
      "Plan stored. Review, then run `pnpm nusend:setup deploy apply` with the confirmation phrase.",
    );
    return planBody;
  });
}
