import { Clock, Effect, Result } from "effect";

import { askBoolean, askUntil } from "../commands/prompts.ts";
import { AwsAuthError, CancellationError, SetupCommandError, TerminalError } from "../errors.ts";
import type { SsoMigrationBinding } from "../state/migration.ts";
import type { AwsSsoAuth, SetupState, SetupStateV2 } from "../state/schema.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { Terminal, type TerminalService } from "../terminal.ts";
import { AwsCli, type AwsCliService, type ResolvedCallerContext } from "./aws-cli.ts";
import {
  discoverModernSsoProfiles,
  generateSsoNames,
  loadModernSsoProfile,
  type ModernSsoProfile,
} from "./profile.ts";

export type AuthBindingExpectations = {
  /** Workload/SES region (explicit; distinct from Identity Center region). */
  readonly workloadRegion: string;
  /** When set, STS account must match. */
  readonly expectedAccountId?: string;
  /** When set, STS partition must match. */
  readonly expectedPartition?: string;
  /** When set, STS role must match profile role and this value. */
  readonly expectedRoleName?: string;
  readonly installationId?: string;
};

export type VerifiedSsoBinding = {
  readonly awsAuth: AwsSsoAuth;
  readonly migrationBinding: SsoMigrationBinding;
  readonly caller: ResolvedCallerContext;
  readonly profile: ModernSsoProfile;
};

export type AuthWizardOptions = {
  /** Prefer browser PKCE (default) or device-code flow when configuring. */
  readonly preferDeviceCode?: boolean;
};

function log(terminal: TerminalService, message: string) {
  return terminal.writeOut(`${message}\n`);
}

function formatProfileChoice(profile: ModernSsoProfile, index: number): string {
  return `${index + 1}) ${profile.profileName}  account=${profile.accountId}  role=${profile.roleName}  sso_region=${profile.identityCenterRegion}`;
}

/**
 * Interactive SSO profile selection / configure / login / STS bind.
 * Stores no tokens, device codes, URLs, or temporary credentials.
 */
export function runAwsAuthWizard(
  expectations: AuthBindingExpectations,
  options: AuthWizardOptions = {},
): Effect.Effect<
  VerifiedSsoBinding,
  AwsAuthError | CancellationError | TerminalError | SetupCommandError,
  AwsCliService | TerminalService
> {
  return Effect.gen(function* () {
    const aws = yield* AwsCli;
    const terminal = yield* Terminal;

    yield* log(
      terminal,
      `AWS SSO login (browser/MFA handled by AWS CLI). App/SES region: ${expectations.workloadRegion}.`,
    );

    let profiles = [...(yield* discoverModernSsoProfiles(aws))];
    let selected: ModernSsoProfile | null = null;

    if (profiles.length === 0) {
      yield* log(terminal, "No usable SSO profiles found. Starting aws configure sso…");
      selected = yield* configureNewProfile(aws, terminal, expectations, options);
    } else {
      yield* log(terminal, "SSO profiles on this machine:");
      for (const [index, profile] of profiles.entries()) {
        yield* log(terminal, `  ${formatProfileChoice(profile, index)}`);
      }
      yield* log(terminal, `  ${profiles.length + 1}) Set up a different account/role`);

      const last = profiles.length + 1;
      const raw = yield* askUntil(`Choose profile [1-${last}]: `, {
        emptyHint: `Enter a number between 1 and ${last}.`,
        validate: (value) => {
          const parsed = Number.parseInt(value, 10);
          return Number.isFinite(parsed) && parsed >= 1 && parsed <= last
            ? null
            : `Enter a number between 1 and ${last}.`;
        },
      });
      const choice = Number.parseInt(raw, 10);
      if (choice === profiles.length + 1) {
        selected = yield* configureNewProfile(aws, terminal, expectations, options);
      } else {
        selected = profiles[choice - 1] ?? null;
      }
    }

    if (selected == null) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: "No SSO profile selected.",
          reason: "no-suitable-profile",
        }),
      );
    }

    // Re-load after configure so we never trust stale metadata.
    selected = yield* loadModernSsoProfile(aws, selected.profileName);

    const caller = yield* ensureFreshSession(aws, terminal, selected, expectations.workloadRegion);
    return yield* buildVerifiedBinding(selected, caller, expectations);
  });
}

function configureNewProfile(
  aws: AwsCliService,
  terminal: TerminalService,
  expectations: AuthBindingExpectations,
  options: AuthWizardOptions,
): Effect.Effect<
  ModernSsoProfile,
  AwsAuthError | CancellationError | TerminalError | SetupCommandError,
  TerminalService
> {
  return Effect.gen(function* () {
    const names = generateSsoNames(expectations.installationId ?? "setup");
    yield* log(
      terminal,
      `Starting aws configure sso (profile ${names.profileName}). Follow the AWS prompts for login and account/role.`,
    );
    yield* log(terminal, `If asked for a session name, you can use: ${names.sessionHint}`);

    const useDevice =
      options.preferDeviceCode === true
        ? true
        : options.preferDeviceCode === false
          ? false
          : yield* askBoolean("No browser available (use device code instead)?", false);

    const args = ["configure", "sso", "--profile", names.profileName];
    if (useDevice) {
      args.push("--use-device-code", "--no-browser");
    }

    const result = yield* aws.runInheritedSso(args).pipe(
      Effect.mapError((error) => {
        if (error instanceof AwsAuthError) {
          if (error.reason === "login-cancelled") {
            return new AwsAuthError({
              message: "aws configure sso was cancelled or failed.",
              reason: "configure-failed",
              cause: error,
            });
          }
          return error;
        }
        return new AwsAuthError({
          message: "aws configure sso was cancelled or failed.",
          reason: "configure-failed",
          cause: error,
        });
      }),
    );

    // Inherited mode must never expose captured streams.
    if (result.stdout !== "" || result.stderr !== "") {
      return yield* Effect.fail(
        new AwsAuthError({
          message: "Internal error: inherited SSO configure captured terminal output.",
          reason: "configure-failed",
        }),
      );
    }

    return yield* loadModernSsoProfile(aws, names.profileName).pipe(
      Effect.mapError((error) =>
        error instanceof AwsAuthError
          ? new AwsAuthError({
              message: `Configured profile "${names.profileName}" is not a modern refreshable SSO profile: ${error.message}`,
              reason: "invalid-profile",
              cause: error,
            })
          : error,
      ),
    );
  });
}

/**
 * Verify session; on recognized expiry prompt once for sso login, then recheck.
 * Does not retry AccessDenied, malformed output, cancel, or binding mismatch as auth.
 */
export function ensureFreshSession(
  aws: AwsCliService,
  terminal: TerminalService,
  profile: ModernSsoProfile,
  workloadRegion: string,
): Effect.Effect<
  ResolvedCallerContext,
  AwsAuthError | CancellationError | TerminalError | SetupCommandError,
  TerminalService
> {
  return Effect.gen(function* () {
    const first = yield* aws
      .verifyProfileSession(profile.profileName, workloadRegion)
      .pipe(Effect.result);

    if (Result.isSuccess(first)) {
      return first.success;
    }

    const error = first.failure;
    if (!(error instanceof AwsAuthError) || error.reason !== "expired-session") {
      return yield* Effect.fail(error);
    }

    yield* log(terminal, `SSO session for profile "${profile.profileName}" is missing or expired.`);
    const proceed = yield* askBoolean(
      `Run \`aws sso login --profile ${profile.profileName}\` now?`,
      true,
    );
    if (!proceed) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: "SSO login declined; authentication incomplete.",
          reason: "login-cancelled",
        }),
      );
    }

    const loginArgs = ["sso", "login", "--profile", profile.profileName];
    const loginResult = yield* aws.runInheritedSso(loginArgs).pipe(
      Effect.mapError((err) => {
        if (err instanceof CancellationError) {
          return new AwsAuthError({
            message: "aws sso login was cancelled.",
            reason: "login-cancelled",
            cause: err,
          });
        }
        if (err instanceof AwsAuthError) {
          return new AwsAuthError({
            message: err.message,
            reason: "login-cancelled",
            cause: err,
          });
        }
        return new AwsAuthError({
          message: "aws sso login failed.",
          reason: "login-cancelled",
          cause: err,
        });
      }),
    );

    if (loginResult.stdout !== "" || loginResult.stderr !== "") {
      return yield* Effect.fail(
        new AwsAuthError({
          message: "Internal error: inherited SSO login captured terminal output.",
          reason: "login-failed",
        }),
      );
    }

    // Single recheck only — do not loop.
    return yield* aws.verifyProfileSession(profile.profileName, workloadRegion).pipe(
      Effect.mapError((err) => {
        if (err instanceof AwsAuthError && err.reason === "expired-session") {
          return new AwsAuthError({
            message: "SSO session still invalid after one login attempt.",
            reason: "login-failed",
            cause: err,
          });
        }
        return err;
      }),
    );
  });
}

export function buildVerifiedBinding(
  profile: ModernSsoProfile,
  caller: ResolvedCallerContext,
  expectations: AuthBindingExpectations,
): Effect.Effect<VerifiedSsoBinding, AwsAuthError> {
  return Effect.gen(function* () {
    if (caller.accountId !== profile.accountId) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: `STS account ${caller.accountId} does not match profile sso_account_id ${profile.accountId}.`,
          reason: "binding-mismatch",
        }),
      );
    }
    if (
      expectations.expectedAccountId != null &&
      caller.accountId !== expectations.expectedAccountId
    ) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: `STS account ${caller.accountId} does not match expected account ${expectations.expectedAccountId}.`,
          reason: "binding-mismatch",
        }),
      );
    }
    if (
      expectations.expectedPartition != null &&
      caller.partition !== expectations.expectedPartition
    ) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: `STS partition ${caller.partition} does not match expected ${expectations.expectedPartition}.`,
          reason: "binding-mismatch",
        }),
      );
    }
    if (caller.roleName != null && caller.roleName !== profile.roleName) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: `STS role ${caller.roleName} does not match profile sso_role_name ${profile.roleName}.`,
          reason: "binding-mismatch",
        }),
      );
    }
    if (
      expectations.expectedRoleName != null &&
      caller.roleName != null &&
      caller.roleName !== expectations.expectedRoleName
    ) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: `STS role ${caller.roleName} does not match expected role ${expectations.expectedRoleName}.`,
          reason: "binding-mismatch",
        }),
      );
    }

    // Detect profile mutation vs previously bound role when expected.
    if (
      expectations.expectedRoleName != null &&
      profile.roleName !== expectations.expectedRoleName
    ) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: `Profile role ${profile.roleName} does not match previously bound role ${expectations.expectedRoleName}.`,
          reason: "profile-mutation",
        }),
      );
    }

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();

    const awsAuth: AwsSsoAuth = {
      type: "sso",
      profileName: profile.profileName,
      ssoSessionName: profile.ssoSessionName,
      accountId: profile.accountId,
      roleName: profile.roleName,
      identityCenterRegion: profile.identityCenterRegion,
      partition: caller.partition,
      verifiedAccountId: caller.accountId,
      verifiedAt: now,
      boundAt: now,
    };

    const migrationBinding: SsoMigrationBinding = {
      type: "sso",
      profileName: profile.profileName,
      ssoSessionName: profile.ssoSessionName,
      accountId: profile.accountId,
      roleName: profile.roleName,
      identityCenterRegion: profile.identityCenterRegion,
      partition: caller.partition,
      verifiedAccountId: caller.accountId,
      workloadRegion: expectations.workloadRegion,
    };

    return { awsAuth, migrationBinding, caller, profile };
  });
}

/**
 * Bind verified SSO into installation state: v2 write or v1→v2 migration.
 * Never stores tokens/device codes/URLs/temp creds.
 */
export function persistSsoBinding(
  state: SetupState,
  binding: VerifiedSsoBinding,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<
  SetupStateV2,
  AwsAuthError | import("../errors.ts").SetupStoreError,
  SetupStoreService
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const pathEnv = env ?? process.env;

    if (state.schemaVersion === 1) {
      return yield* store.migrateV1ToV2(state, binding.migrationBinding, pathEnv);
    }

    // Already v2: update awsAuth + config labels after re-verification.
    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();
    const next: SetupStateV2 = {
      ...state,
      updatedAt: now,
      config: {
        ...state.config,
        awsProfile: binding.awsAuth.profileName,
        awsAccountId: binding.awsAuth.verifiedAccountId,
      },
      awsAuth: {
        ...binding.awsAuth,
        boundAt: state.awsAuth.boundAt,
        verifiedAt: now,
      },
    };
    const written = yield* store.writeState(next, pathEnv);
    if (written.schemaVersion !== 2) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: "Failed to persist SSO binding as schema v2.",
          reason: "binding-mismatch",
        }),
      );
    }
    return written;
  });
}

/**
 * `aws auth` recovery command: resolve installation, run wizard, persist binding.
 */
export function runAwsAuthCommand(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  SetupStateV2,
  | AwsAuthError
  | CancellationError
  | TerminalError
  | SetupCommandError
  | import("../errors.ts").SetupStoreError,
  AwsCliService | TerminalService | SetupStoreService
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;
    const terminal = yield* Terminal;
    const installationId = yield* store.resolveInstallationId(env);
    const state = yield* store.loadState(installationId, env);

    const expectations: AuthBindingExpectations = {
      workloadRegion: state.config.awsRegion,
      expectedAccountId: state.config.awsAccountId,
      installationId: state.installationId,
      ...(state.schemaVersion === 2
        ? {
            expectedPartition: state.awsAuth.partition,
            expectedRoleName: state.awsAuth.roleName,
          }
        : {}),
    };

    const binding = yield* runAwsAuthWizard(expectations);
    const written = yield* persistSsoBinding(state, binding, env);
    yield* log(
      terminal,
      `Bound SSO profile "${written.awsAuth.profileName}" (account ${written.awsAuth.verifiedAccountId}, role ${written.awsAuth.roleName}, partition ${written.awsAuth.partition}).`,
    );
    yield* log(
      terminal,
      `Identity Center region: ${written.awsAuth.identityCenterRegion}; workload region: ${written.config.awsRegion}.`,
    );
    return written;
  });
}

/**
 * Non-interactive revalidation of the stored binding (status --refresh / doctor).
 * Prompts once before login when session expired if `promptForLogin` is true.
 */
export function revalidateStoredAuth(
  state: SetupState,
  options: { readonly promptForLogin: boolean },
): Effect.Effect<
  ResolvedCallerContext,
  AwsAuthError | CancellationError | TerminalError | SetupCommandError,
  AwsCliService | TerminalService
> {
  return Effect.gen(function* () {
    const aws = yield* AwsCli;
    const terminal = yield* Terminal;

    if (state.schemaVersion !== 2) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: "Installation has no SSO binding yet. Run `aws auth` or re-init.",
          reason: "no-suitable-profile",
        }),
      );
    }

    const profile = yield* loadModernSsoProfile(aws, state.awsAuth.profileName);

    // Detect profile mutation against stored binding.
    if (
      profile.accountId !== state.awsAuth.accountId ||
      profile.roleName !== state.awsAuth.roleName ||
      profile.ssoSessionName !== state.awsAuth.ssoSessionName
    ) {
      return yield* Effect.fail(
        new AwsAuthError({
          message: `AWS profile "${profile.profileName}" metadata changed since binding. Re-run aws auth.`,
          reason: "profile-mutation",
        }),
      );
    }

    if (options.promptForLogin) {
      return yield* ensureFreshSession(aws, terminal, profile, state.config.awsRegion).pipe(
        Effect.flatMap((caller) =>
          buildVerifiedBinding(profile, caller, {
            workloadRegion: state.config.awsRegion,
            expectedAccountId: state.awsAuth.accountId,
            expectedPartition: state.awsAuth.partition,
            expectedRoleName: state.awsAuth.roleName,
            installationId: state.installationId,
          }).pipe(Effect.map((b) => b.caller)),
        ),
      );
    }

    const caller = yield* aws.verifyProfileSession(profile.profileName, state.config.awsRegion);
    yield* buildVerifiedBinding(profile, caller, {
      workloadRegion: state.config.awsRegion,
      expectedAccountId: state.awsAuth.accountId,
      expectedPartition: state.awsAuth.partition,
      expectedRoleName: state.awsAuth.roleName,
      installationId: state.installationId,
    });
    return caller;
  });
}

/** Build configure-sso argv for tests and wizard. */
export function configureSsoArgv(
  profileName: string,
  mode: "browser" | "device-code",
): readonly string[] {
  if (mode === "device-code") {
    return ["configure", "sso", "--profile", profileName, "--use-device-code", "--no-browser"];
  }
  return ["configure", "sso", "--profile", profileName];
}

export function ssoLoginArgv(profileName: string): readonly string[] {
  return ["sso", "login", "--profile", profileName];
}
