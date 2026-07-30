import { Clock, Effect } from "effect";

import { ask, writeLine } from "../commands/prompts.ts";
import { SetupCommandError } from "../errors.ts";
import { SetupStore } from "../services/setup-store.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import type { PathEnvironment } from "../state/paths.ts";
import type { SetupState } from "../state/schema.ts";
import { CREATE_RUNTIME_KEY_PHRASE } from "./constants.ts";
import {
  createAccessKey,
  listAccessKeys,
  resolveCallerContext,
  type AwsWorkflowError,
  type AwsWorkflowServices,
} from "./ops.ts";

export type CreateRuntimeKeyResult = {
  readonly accessKeyId: string;
  readonly state: SetupState;
};

export function runCreateRuntimeKey(
  env: PathEnvironment = process.env,
  options: {
    readonly existingState?: SetupState;
    readonly confirmation?: string;
  } = {},
): Effect.Effect<CreateRuntimeKeyResult, AwsWorkflowError, AwsWorkflowServices> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const installationId =
      options.existingState?.installationId ?? (yield* store.resolveInstallationId(env));
    let state = options.existingState ?? (yield* store.loadState(installationId, env));
    yield* resolveCallerContext(state, env);

    const stack = state.aws?.stack;
    if (stack == null || typeof stack !== "object") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "Runtime key requires a successful core stack apply first.",
        }),
      );
    }
    const outputs =
      stack.outputs && typeof stack.outputs === "object"
        ? (stack.outputs as Record<string, string>)
        : {};
    const userName = String(outputs.RuntimeUserName ?? "");
    if (!userName) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: "Stack outputs are missing RuntimeUserName.",
        }),
      );
    }
    if (state.aws?.runtimeAccessKeyId) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Runtime access key ${state.aws.runtimeAccessKeyId} is already recorded. Lost secrets require explicit manual rotation; the coordinator will not recreate automatically.`,
        }),
      );
    }

    const metadata = yield* listAccessKeys(state, userName, env);
    if (metadata.length > 0) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Runtime IAM user ${userName} already has ${metadata.length} access key(s). Refusing to create another. Delete the existing key only with an explicit manual process if rotation is required.`,
        }),
      );
    }

    const confirmation =
      options.confirmation ??
      (yield* ask(`Type ${CREATE_RUNTIME_KEY_PHRASE} to create one runtime key: `));
    if (String(confirmation).trim() !== CREATE_RUNTIME_KEY_PHRASE) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Confirmation rejected. Type exactly: ${CREATE_RUNTIME_KEY_PHRASE}`,
        }),
      );
    }

    const { accessKeyId, secretAccessKey } = yield* createAccessKey(state, userName, env);

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const nextState: SetupState = {
      ...state,
      updatedAt: now,
      aws: sanitizePlanMetadata({
        ...(state.aws ?? {}),
        runtimeAccessKeyId: accessKeyId,
      }) as SetupState["aws"],
    };
    // Record non-secret key id first so a later env failure does not look like "no key".
    yield* store.writeState(nextState, env);

    const deployment = yield* store.loadDeploymentEnv(installationId, env);
    const nextEnv = {
      ...deployment,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
    };
    // Atomic env write of id+secret together; never print either value.
    yield* store.writeDeploymentEnv(installationId, nextEnv, env);
    yield* writeLine(
      "Runtime access key created and stored in deployment.env (values not printed).",
    );
    return { accessKeyId, state: nextState };
  });
}
