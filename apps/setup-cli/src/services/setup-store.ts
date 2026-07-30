import { randomBytes } from "node:crypto";

import { Clock, Context, Effect, Layer } from "effect";

import { SetupStoreError } from "../errors.ts";
import {
  parseEnvFile,
  redactDeploymentEnv,
  serializeDeploymentEnv,
  type DeploymentEnvMap,
  type PlainEnvMap,
} from "../state/env.ts";
import {
  assertPrivateDirectory,
  assertPrivateFile,
  assertSymlinkFreePath,
  ensurePrivateDirectory,
  mkdirExclusive,
  pathExists,
  readUtf8File,
  removeDirectoryRecursive,
  writeAtomicFile,
  type AtomicWriteHooks,
} from "../state/fs.ts";
import { migrateV1ToV2, type SsoMigrationBinding } from "../state/migration.ts";
import {
  currentPointerPath,
  envFilePath,
  installationDirectory,
  policyArtifactPath,
  setupHome,
  stateFilePath,
  type PathEnvironment,
  assertInstallationId,
} from "../state/paths.ts";
import { publicStatusView, type PublicStatusView } from "../state/public-status.ts";
import { sanitizePlanMetadata } from "../state/sanitize.ts";
import {
  decodeSetupState,
  encodeSetupStateJson,
  type SetupState,
  type SetupStateV2,
} from "../state/schema.ts";

export type WriteHooks = AtomicWriteHooks;

export interface SetupStoreService {
  readonly setupHome: (env?: PathEnvironment) => string;
  readonly assertInstallationId: (installationId: string) => Effect.Effect<string, SetupStoreError>;
  readonly resolveInstallationId: (env?: PathEnvironment) => Effect.Effect<string, SetupStoreError>;
  readonly writeCurrentPointer: (
    installationId: string,
    env?: PathEnvironment,
  ) => Effect.Effect<void, SetupStoreError>;
  readonly loadState: (
    installationId: string,
    env?: PathEnvironment,
  ) => Effect.Effect<SetupState, SetupStoreError>;
  readonly writeState: (
    state: SetupState,
    env?: PathEnvironment,
    hooks?: WriteHooks,
  ) => Effect.Effect<SetupState, SetupStoreError>;
  readonly loadDeploymentEnv: (
    installationId: string,
    env?: PathEnvironment,
  ) => Effect.Effect<DeploymentEnvMap, SetupStoreError>;
  readonly writeDeploymentEnv: (
    installationId: string,
    values: DeploymentEnvMap | PlainEnvMap,
    env?: PathEnvironment,
    hooks?: WriteHooks,
  ) => Effect.Effect<void, SetupStoreError>;
  readonly checkpointStage: (
    state: SetupState,
    stageId: string,
    evidence: Record<string, unknown>,
    env?: PathEnvironment,
  ) => Effect.Effect<SetupState, SetupStoreError>;
  readonly assertInstallationNotInitialized: (
    installationId: string,
    env?: PathEnvironment,
  ) => Effect.Effect<string, SetupStoreError>;
  readonly reserveInstallationDirectory: (
    installationId: string,
    env?: PathEnvironment,
  ) => Effect.Effect<string, SetupStoreError>;
  readonly removeUnpublishedInstallation: (
    installationId: string,
    env?: PathEnvironment,
  ) => Effect.Effect<boolean, SetupStoreError>;
  readonly writePolicyArtifact: (
    installationId: string,
    policyJson: string,
    env?: PathEnvironment,
    hooks?: WriteHooks,
  ) => Effect.Effect<void, SetupStoreError>;
  readonly migrateV1ToV2: (
    state: SetupState,
    binding: SsoMigrationBinding,
    env?: PathEnvironment,
    hooks?: WriteHooks,
  ) => Effect.Effect<SetupStateV2, SetupStoreError>;
  readonly publicStatusView: (state: SetupState) => PublicStatusView;
  readonly generateSecret: (bytes?: number) => string;
}

export const SetupStore = Context.Service<SetupStoreService>("nusend/setup/SetupStore");

function wrapInput<A>(fn: () => A): Effect.Effect<A, SetupStoreError> {
  return Effect.try({
    try: fn,
    catch: (error) =>
      error instanceof SetupStoreError
        ? error
        : new SetupStoreError({
            message: error instanceof Error ? error.message : String(error),
            reason: "invalid-input",
            cause: error,
          }),
  });
}

function makeSetupStore(): SetupStoreService {
  const service: SetupStoreService = {
    setupHome: (env = process.env) => setupHome(env),

    assertInstallationId: (installationId) => wrapInput(() => assertInstallationId(installationId)),

    resolveInstallationId: (env = process.env) =>
      Effect.gen(function* () {
        const fromEnv = env.NUSEND_SETUP_INSTALLATION?.trim();
        if (fromEnv) {
          return yield* wrapInput(() => assertInstallationId(fromEnv));
        }

        const pointer = currentPointerPath(env);
        yield* assertSymlinkFreePath(setupHome(env), "Setup home");
        yield* assertPrivateFile(pointer, "Installation pointer");
        const raw = yield* readUtf8File(pointer).pipe(
          Effect.mapError((error) =>
            error.reason === "not-found"
              ? new SetupStoreError({
                  message:
                    "No active installation. Run `pnpm nusend:setup init` or set NUSEND_SETUP_INSTALLATION.",
                  reason: "not-found",
                  cause: error,
                })
              : error,
          ),
        );
        const id = raw.trim();
        if (!id) {
          return yield* Effect.fail(
            new SetupStoreError({
              message:
                "Installation pointer is empty. Run `pnpm nusend:setup init` or set NUSEND_SETUP_INSTALLATION.",
              reason: "parse",
            }),
          );
        }
        return yield* wrapInput(() => assertInstallationId(id));
      }),

    writeCurrentPointer: (installationId, env = process.env) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        const home = setupHome(env);
        yield* assertSymlinkFreePath(home, "Setup home");
        yield* ensurePrivateDirectory(home);
        yield* writeAtomicFile(currentPointerPath(env), `${id}\n`, { mode: 0o600 });
      }),

    loadState: (installationId, env = process.env) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        const path = stateFilePath(id, env);
        yield* assertSymlinkFreePath(setupHome(env), "Setup home");
        yield* assertPrivateFile(path, "State file");
        yield* assertPrivateDirectory(installationDirectory(id, env), "Installation directory");
        const raw = yield* readUtf8File(path).pipe(
          Effect.mapError((error) =>
            error.reason === "not-found"
              ? new SetupStoreError({
                  message: `Installation "${id}" has no state.json. Run \`pnpm nusend:setup init\`.`,
                  reason: "not-found",
                  cause: error,
                })
              : error,
          ),
        );
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          return yield* Effect.fail(
            new SetupStoreError({
              message: `state.json for "${id}" is malformed JSON.`,
              reason: "parse",
              cause: error,
            }),
          );
        }
        return yield* decodeSetupState(parsed);
      }),

    writeState: (state, env = process.env, hooks = {}) =>
      Effect.gen(function* () {
        const validated = yield* decodeSetupState(state);
        const destination = stateFilePath(validated.installationId, env);
        const directory = installationDirectory(validated.installationId, env);
        yield* assertSymlinkFreePath(setupHome(env), "Setup home");
        yield* ensurePrivateDirectory(setupHome(env));
        yield* ensurePrivateDirectory(directory);
        const body = encodeSetupStateJson(validated);
        yield* writeAtomicFile(destination, body, { mode: 0o600, hooks });
        return validated;
      }),

    loadDeploymentEnv: (installationId, env = process.env) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        const path = envFilePath(id, env);
        yield* assertSymlinkFreePath(setupHome(env), "Setup home");
        yield* assertPrivateFile(path, "deployment.env");
        yield* assertPrivateDirectory(installationDirectory(id, env), "Installation directory");
        const raw = yield* readUtf8File(path).pipe(
          Effect.mapError((error) =>
            error.reason === "not-found"
              ? new SetupStoreError({
                  message: `Installation "${id}" has no deployment.env. Run \`pnpm nusend:setup init\`.`,
                  reason: "not-found",
                  cause: error,
                })
              : error,
          ),
        );
        const plain = yield* Effect.try({
          try: () => parseEnvFile(raw),
          catch: (error) =>
            new SetupStoreError({
              message: error instanceof Error ? error.message : String(error),
              reason: "parse",
              cause: error,
            }),
        });
        return redactDeploymentEnv(plain);
      }),

    writeDeploymentEnv: (installationId, values, env = process.env, hooks = {}) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        const destination = envFilePath(id, env);
        const directory = installationDirectory(id, env);
        yield* assertSymlinkFreePath(setupHome(env), "Setup home");
        yield* ensurePrivateDirectory(setupHome(env));
        yield* ensurePrivateDirectory(directory);

        const asDeployment: DeploymentEnvMap = Object.fromEntries(
          Object.entries(values).map(([key, value]) => {
            if (value == null) return [key, undefined];
            return [key, value];
          }),
        ) as DeploymentEnvMap;

        const body = yield* Effect.try({
          try: () => {
            const serialized = serializeDeploymentEnv(asDeployment);
            // Round-trip to reject malformed content before writing.
            parseEnvFile(serialized);
            return serialized;
          },
          catch: (error) =>
            new SetupStoreError({
              message: error instanceof Error ? error.message : String(error),
              reason: "parse",
              cause: error,
            }),
        });
        yield* writeAtomicFile(destination, body, { mode: 0o600, hooks });
      }),

    checkpointStage: (state, stageId, evidence, env = process.env) =>
      Effect.gen(function* () {
        if (!stageId || typeof stageId !== "string") {
          return yield* Effect.fail(
            new SetupStoreError({
              message: "stageId is required.",
              reason: "invalid-input",
            }),
          );
        }
        const sanitized = sanitizePlanMetadata(evidence);
        if (sanitized.verified !== true) {
          return yield* Effect.fail(
            new SetupStoreError({
              message: `Refusing to checkpoint stage "${stageId}" without verified evidence (process exit alone is insufficient).`,
              reason: "invalid-input",
            }),
          );
        }
        const nowMillis = yield* Clock.currentTimeMillis;
        const now = new Date(nowMillis).toISOString();
        const next: SetupState = {
          ...state,
          updatedAt: now,
          stages: {
            ...state.stages,
            [stageId]: {
              status: "complete",
              completedAt: now,
              evidence: sanitized,
            },
          },
        };
        return yield* service.writeState(next, env);
      }),

    assertInstallationNotInitialized: (installationId, env = process.env) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        const directory = installationDirectory(id, env);
        yield* assertSymlinkFreePath(directory, "Installation directory");

        const candidates: Array<readonly [string, string]> = [
          [stateFilePath(id, env), "state.json"],
          [envFilePath(id, env), "deployment.env"],
          [directory, "installation directory"],
        ];

        for (const [path, label] of candidates) {
          const exists = yield* pathExists(path);
          if (exists) {
            return yield* Effect.fail(
              new SetupStoreError({
                message: `Installation "${id}" already exists (${label} at ${path}). Refusing to overwrite existing state, deployment.env, or secrets. Choose a new installation id or continue the existing installation.`,
                reason: "conflict",
              }),
            );
          }
        }
        return id;
      }),

    reserveInstallationDirectory: (installationId, env = process.env) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        const home = setupHome(env);
        const directory = installationDirectory(id, env);
        yield* assertSymlinkFreePath(home, "Setup home");
        yield* ensurePrivateDirectory(home);
        yield* mkdirExclusive(directory);
        yield* assertPrivateDirectory(directory, "Installation directory");
        return id;
      }),

    removeUnpublishedInstallation: (installationId, env = process.env) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        const pointer = currentPointerPath(env);
        type PointerProbe =
          | { readonly kind: "value"; readonly raw: string }
          | { readonly kind: "missing" }
          | { readonly kind: "ambiguous" };

        const pointerResult: PointerProbe = yield* readUtf8File(pointer).pipe(
          Effect.map((raw): PointerProbe => ({ kind: "value", raw })),
          Effect.catchTag(
            "SetupStoreError",
            (error): Effect.Effect<PointerProbe> =>
              error.reason === "not-found"
                ? Effect.succeed({ kind: "missing" })
                : Effect.succeed({ kind: "ambiguous" }),
          ),
        );
        if (pointerResult.kind === "ambiguous") return false;
        if (pointerResult.kind === "value" && pointerResult.raw.trim() === id) return false;

        const directory = installationDirectory(id, env);
        yield* assertSymlinkFreePath(directory, "Installation directory");
        yield* removeDirectoryRecursive(directory);
        return true;
      }),

    writePolicyArtifact: (installationId, policyJson, env = process.env, hooks = {}) =>
      Effect.gen(function* () {
        const id = yield* wrapInput(() => assertInstallationId(installationId));
        if (typeof policyJson !== "string" || policyJson.trim() === "") {
          return yield* Effect.fail(
            new SetupStoreError({
              message: "Provisioner policy artifact body must be a non-empty JSON string.",
              reason: "invalid-input",
            }),
          );
        }
        // Structural JSON check only — full policy schema is T4.
        try {
          JSON.parse(policyJson);
        } catch (error) {
          return yield* Effect.fail(
            new SetupStoreError({
              message: "Provisioner policy artifact must be valid JSON.",
              reason: "parse",
              cause: error,
            }),
          );
        }
        const destination = policyArtifactPath(id, env);
        const directory = installationDirectory(id, env);
        yield* assertSymlinkFreePath(setupHome(env), "Setup home");
        yield* ensurePrivateDirectory(setupHome(env));
        yield* ensurePrivateDirectory(directory);
        const body = policyJson.endsWith("\n") ? policyJson : `${policyJson}\n`;
        yield* writeAtomicFile(destination, body, { mode: 0o600, hooks });
      }),

    migrateV1ToV2: (state, binding, env = process.env, hooks = {}) =>
      Effect.gen(function* () {
        const migrated = yield* migrateV1ToV2(state, binding);
        const written = yield* service.writeState(migrated, env, hooks);
        if (written.schemaVersion !== 2) {
          return yield* Effect.fail(
            new SetupStoreError({
              message: "Migration write did not persist schema v2.",
              reason: "migration",
            }),
          );
        }
        return written;
      }),

    publicStatusView: (state) => publicStatusView(state),

    generateSecret: (bytes = 32) => randomBytes(bytes).toString("base64url"),
  };

  return service;
}

export const SetupStoreLive: Layer.Layer<SetupStoreService> =
  Layer.succeed(SetupStore)(makeSetupStore());

export type SetupStoreFakeHandlers = Partial<SetupStoreService>;

export function SetupStoreFake(
  handlers: SetupStoreFakeHandlers = {},
): Layer.Layer<SetupStoreService> {
  const base = makeSetupStore();
  const service: SetupStoreService = {
    ...base,
    ...handlers,
  };
  return Layer.succeed(SetupStore)(service);
}

export type {
  DeploymentEnvMap,
  PlainEnvMap,
  PublicStatusView,
  SetupState,
  SetupStateV2,
  SsoMigrationBinding,
};
