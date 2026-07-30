import { Clock, Effect, Redacted } from "effect";

import { runAwsAuthWizard, type AwsCliService } from "../auth/index.ts";
import {
  AwsAuthError,
  CancellationError,
  SetupCommandError,
  SetupStoreError,
  TerminalError,
} from "../errors.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { assertAbsolutePosixPath, assertReleaseTag, type SetupStateV2 } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import { ask, askBoolean, askChoice, askSecret, writeLine } from "./prompts.ts";

/**
 * Interactive init: collect installation config, bind modern SSO, write schema v2 + env.
 */
export function runInit(
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  SetupStateV2,
  SetupCommandError | SetupStoreError | AwsAuthError | CancellationError | TerminalError,
  SetupStoreService | TerminalService | AwsCliService
> {
  return Effect.gen(function* () {
    const store = yield* SetupStore;

    yield* writeLine("Initialize a new Nusend setup installation.");
    yield* writeLine("Secrets are written only to deployment.env and are never printed.");
    yield* writeLine(
      "AWS profile is selected via the SSO wizard after local fields are collected.",
    );

    const installationId = yield* store.assertInstallationId(
      yield* ask("Installation id (slug, max 31) [a-z][a-z0-9-]*: "),
    );
    yield* store.assertInstallationNotInitialized(installationId, env);

    const releaseTagRaw = yield* ask("Release tag (e.g. v0.1.1): ");
    const releaseTagValue = yield* Effect.try({
      try: () => assertReleaseTag(releaseTagRaw),
      catch: (error) => toCommandError(error),
    });

    const domain = yield* ask("Public domain (e.g. mail.example.com): ");
    const ingressMode = (yield* askChoice("Ingress mode", ["direct", "cloudflare"])) as
      | "direct"
      | "cloudflare";
    const ownerEmail = yield* ask("Owner email (Google account): ");
    const ownerName = yield* ask("Owner display name: ");
    const awsRegion = yield* ask("AWS workload region (e.g. us-east-1): ");
    const awsAccountId = yield* ask("Expected 12-digit AWS account id: ");
    if (!/^\d{12}$/u.test(awsAccountId)) {
      return yield* Effect.fail(
        new SetupCommandError({ message: "AWS account id must be exactly 12 digits." }),
      );
    }
    const sesIdentity = yield* ask("SES domain identity (e.g. example.com): ");
    const sesFromEmail = yield* ask("SES from address: ");
    const marketingEnabled = yield* askBoolean("Enable marketing configuration set?", false);
    const trackingEnabled = yield* askBoolean("Enable open/click tracking?", false);
    const alertEmail = yield* ask("Alert email for CloudWatch notifications: ");
    const route53Raw = yield* ask("Route 53 hosted zone id (empty for manual DNS): ", true);
    const route53HostedZoneId = route53Raw === "" ? null : route53Raw;
    const sshTarget = yield* ask("SSH target (user@host): ");
    const remotePathRaw = yield* ask("Absolute remote checkout path (e.g. /srv/nusend): ");
    const remotePath = yield* Effect.try({
      try: () => assertAbsolutePosixPath(remotePathRaw),
      catch: (error) => toCommandError(error),
    });

    const googleClientId = yield* ask("Google OAuth client id: ");
    const googleClientSecret = yield* askSecret("Google OAuth client secret: ");
    const resticRepository = yield* ask(
      "Restic repository URL (s3:https://...r2.../bucket/nusend): ",
    );
    const r2AccessKeyId = yield* ask("R2 access key id: ");
    const r2SecretAccessKey = yield* askSecret("R2 secret access key: ");

    const betterAuthSecret = store.generateSecret(32);
    const apiKeyHashSecret = store.generateSecret(32);
    const unsubscribeSecret = store.generateSecret(32);
    const resticPassword = store.generateSecret(32);

    // Bind modern SSO before durable writes so failed auth leaves nothing published.
    const binding = yield* runAwsAuthWizard({
      workloadRegion: awsRegion,
      expectedAccountId: awsAccountId,
      installationId,
    });

    const nowMillis = yield* Clock.currentTimeMillis;
    const now = new Date(nowMillis).toISOString();

    const state: SetupStateV2 = {
      schemaVersion: 2,
      installationId,
      createdAt: now,
      updatedAt: now,
      config: {
        releaseTag: releaseTagValue,
        domain,
        ingressMode,
        ownerEmail,
        ownerName,
        awsProfile: binding.awsAuth.profileName,
        awsRegion,
        awsAccountId: binding.awsAuth.verifiedAccountId,
        sesIdentity,
        sesFromEmail,
        marketingEnabled,
        trackingEnabled,
        alertEmail,
        route53HostedZoneId,
        sshTarget,
        remotePath,
        installationName: installationId,
      },
      stages: {
        init: {
          status: "complete",
          completedAt: now,
          evidence: {
            verified: true,
            installationId,
            domain,
            releaseTag: releaseTagValue,
            awsRegion,
            awsAccountId: binding.awsAuth.verifiedAccountId,
            awsProfile: binding.awsAuth.profileName,
            authType: "sso",
          },
        },
      },
      plans: {},
      awsAuth: binding.awsAuth,
    };

    const deploymentEnv = {
      NUSEND_DOMAIN: domain,
      NUSEND_INGRESS_MODE: ingressMode,
      NUSEND_OWNER_EMAIL: ownerEmail,
      NUSEND_OWNER_NAME: ownerName,
      BETTER_AUTH_SECRET: Redacted.make(betterAuthSecret),
      GOOGLE_CLIENT_ID: googleClientId,
      GOOGLE_CLIENT_SECRET: Redacted.make(googleClientSecret),
      NUSEND_API_KEY_HASH_SECRET: Redacted.make(apiKeyHashSecret),
      NUSEND_UNSUBSCRIBE_SECRET: Redacted.make(unsubscribeSecret),
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_REGION: awsRegion,
      NUSEND_SES_FROM_EMAIL: sesFromEmail,
      NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "",
      NUSEND_RESTIC_REPOSITORY: resticRepository,
      NUSEND_R2_ACCESS_KEY_ID: r2AccessKeyId,
      NUSEND_R2_SECRET_ACCESS_KEY: Redacted.make(r2SecretAccessKey),
      NUSEND_RESTIC_PASSWORD: Redacted.make(resticPassword),
      ...(marketingEnabled ? { NUSEND_SES_MARKETING_CONFIGURATION_SET: "" } : {}),
      ...(trackingEnabled ? { NUSEND_SES_TRACKING_EVENTS: "open,click" } : {}),
    };

    yield* store.reserveInstallationDirectory(installationId, env);
    const published = yield* store.writeState(state, env).pipe(
      Effect.flatMap(() => store.writeDeploymentEnv(installationId, deploymentEnv, env)),
      Effect.flatMap(() => store.writeCurrentPointer(installationId, env)),
      Effect.as(state),
      Effect.catchTag("SetupStoreError", (error) =>
        store.removeUnpublishedInstallation(installationId, env).pipe(
          Effect.ignore,
          Effect.flatMap(() => Effect.fail(error)),
        ),
      ),
    );

    yield* writeLine(`Installation "${installationId}" created under ${store.setupHome(env)}.`);
    yield* writeLine(
      `Bound SSO profile "${binding.awsAuth.profileName}" (account ${binding.awsAuth.verifiedAccountId}, role ${binding.awsAuth.roleName}).`,
    );
    yield* writeLine(
      `Identity Center region: ${binding.awsAuth.identityCenterRegion}; workload region: ${awsRegion}.`,
    );
    yield* writeLine("Next: run doctor, then continue.");
    return published;
  });
}

function toCommandError(error: unknown): SetupCommandError {
  if (error instanceof SetupCommandError) return error;
  if (error instanceof SetupStoreError) {
    return new SetupCommandError({ message: error.message });
  }
  return new SetupCommandError({
    message: error instanceof Error ? error.message : String(error),
  });
}
