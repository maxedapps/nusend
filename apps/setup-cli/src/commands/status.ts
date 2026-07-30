import { Effect } from "effect";

import { revalidateStoredAuth, type AwsCliService } from "../auth/index.ts";
import type { AwsCommandError } from "../aws/errors.ts";
import type { AwsPermissionDeniedError } from "../aws/permissions.ts";
import type { ProvisioningPolicyError } from "../aws/provisioning-policy.ts";
import {
  AwsAuthError,
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
import type { TerminalService } from "../terminal.ts";
import { runProviderRefresh } from "../validate/refresh.ts";
import { STAGE_ORDER } from "./parse.ts";
import { askBoolean, writeLine } from "./prompts.ts";

/**
 * Local status is mutation-free. `--refresh` may prompt once before SSO login when expired,
 * then runs opt-in provider refresh (sanitized summary only).
 */
export function runStatus(
  refresh: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  void,
  | SetupCommandError
  | SetupStoreError
  | AwsAuthError
  | AwsCommandError
  | AwsPermissionDeniedError
  | ProvisioningPolicyError
  | CancellationError
  | TerminalError
  | ProcessFailedError
  | ProcessSignalError
  | ProcessStartError,
  SetupStoreService | TerminalService | AwsCliService | ProcessRunnerService
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);
    const view = store.publicStatusView(state);

    yield* writeLine(`Installation: ${view.installationId}`);
    yield* writeLine(`Domain: ${view.config.domain}`);
    yield* writeLine(`Release: ${view.config.releaseTag}`);
    yield* writeLine(`Updated: ${view.updatedAt}`);
    if (view.awsAuth) {
      yield* writeLine(
        `AWS auth: sso profile=${view.awsAuth.profileName} account=${view.awsAuth.verifiedAccountId} role=${view.awsAuth.roleName} sso_region=${view.awsAuth.identityCenterRegion} partition=${view.awsAuth.partition}`,
      );
      yield* writeLine(`Workload region: ${view.config.awsRegion}`);
    } else {
      yield* writeLine("AWS auth: unbound (schema v1 or missing). Run aws auth.");
    }

    yield* writeLine("Stages:");
    const completed = new Set(Object.keys(view.stages));
    if (completed.has("init")) {
      yield* writeLine(`  init: complete (${view.stages.init?.completedAt ?? ""})`);
    } else {
      yield* writeLine("  init: missing");
    }
    for (const stageId of STAGE_ORDER) {
      if (completed.has(stageId)) {
        yield* writeLine(`  ${stageId}: complete (${view.stages[stageId]?.completedAt ?? ""})`);
      } else {
        yield* writeLine(`  ${stageId}: pending`);
      }
    }

    if (!refresh) {
      yield* writeLine(
        "Provider state: local-only (stale/unknown). Re-run with --refresh for opt-in provider checks and drift detection.",
      );
      return;
    }

    yield* writeLine("Provider refresh (opt-in; drift detection updates AWS drift metadata only):");
    if (state.schemaVersion === 2) {
      // Prompt before opening authentication when the session is expired.
      const caller = yield* revalidateStoredAuth(state, { promptForLogin: true });
      yield* writeLine(
        `  aws-caller: ok ${JSON.stringify({
          accountId: caller.accountId,
          partition: caller.partition,
          roleName: caller.roleName,
          region: state.config.awsRegion,
          profile: state.awsAuth.profileName,
        })}`,
      );
    }

    const summary = yield* runProviderRefresh(env, state);
    for (const [key, value] of Object.entries(summary)) {
      if (key === "checkedAt") continue;
      yield* writeLine(`  ${key}: ${JSON.stringify(value)}`);
    }
  });
}

/** Used by guided path when deciding whether to open auth. */
export function promptRefreshAuthIfNeeded(): Effect.Effect<
  boolean,
  TerminalError | CancellationError | SetupCommandError,
  TerminalService
> {
  return askBoolean("SSO session may need refresh. Continue with authentication?", true);
}
