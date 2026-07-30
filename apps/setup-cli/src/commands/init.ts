import { Clock, Effect, Redacted } from "effect";

import { runAwsAuthWizard, type AwsCliService } from "../auth/index.ts";
import {
  AwsAuthError,
  CancellationError,
  SetupCommandError,
  SetupStoreError,
  TerminalError,
} from "../errors.ts";
import { resolveLatestReleaseTag } from "../release/latest.ts";
import { SetupStore, type SetupStoreService } from "../services/setup-store.ts";
import { assertInstallationId } from "../state/paths.ts";
import { assertAbsolutePosixPath, type SetupStateV2 } from "../state/schema.ts";
import type { TerminalService } from "../terminal.ts";
import {
  askBoolean,
  askChoice,
  askSecret,
  askUntil,
  looksLikeEmail,
  looksLikeHostname,
  writeLine,
} from "./prompts.ts";

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

    yield* writeLine(
      "New Nusend install. Secrets stay in deployment.env (never printed). AWS login comes after these questions.",
    );

    const installationId = yield* askUntil("Local setup name (e.g. prod): ", {
      emptyHint: "Pick a short local name for this install (e.g. prod). Not your domain.",
      validate: (value) => {
        try {
          assertInstallationId(value);
          return null;
        } catch {
          return "Use a short local name like prod (lowercase, start with a letter, max 31 chars).";
        }
      },
    });
    yield* store.assertInstallationNotInitialized(installationId, env);

    yield* writeLine("Fetching latest GitHub Release…");
    const releaseTagValue = yield* resolveLatestReleaseTag({ env });
    yield* writeLine(`Pinned release: ${releaseTagValue}`);

    const domain = yield* askUntil("Domain name of the server hosting this app (e.g. mail.example.com): ", {
      emptyHint: "Enter the hostname that will point at your VPS (no https://).",
      validate: (value) =>
        looksLikeHostname(value)
          ? null
          : "Use a hostname only, like mail.example.com (no https:// or path).",
    });
    const ingressMode = (yield* askChoice(
      "How HTTPS reaches your VPS (direct=DNS to server, cloudflare=proxied CF)",
      ["direct", "cloudflare"],
    )) as "direct" | "cloudflare";
    const ownerEmail = yield* askUntil("Admin Google email (the account that signs into Nusend): ", {
      emptyHint: "Required: the Google account that will own/admin this Nusend install.",
      validate: (value) =>
        looksLikeEmail(value) ? null : "Enter a normal email address (e.g. you@company.com).",
    });
    const ownerName = yield* askUntil("Admin display name: ", {
      emptyHint: "Required: a display name for the admin user.",
    });
    const awsRegion = yield* askUntil("AWS region for SES + stack (e.g. us-east-1): ", {
      emptyHint: "Required: AWS region where SES and the stack will live (e.g. us-east-1).",
      validate: (value) =>
        /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/u.test(value)
          ? null
          : "Use a region code like us-east-1 or eu-west-1.",
    });
    const awsAccountId = yield* askUntil("AWS account ID (12 digits): ", {
      emptyHint: "Required: the 12-digit AWS account that will own the stack.",
      validate: (value) =>
        /^\d{12}$/u.test(value) ? null : "Account ID must be exactly 12 digits.",
    });
    const sesIdentity = yield* askUntil("Domain used to send mail / SES+DKIM (e.g. example.com): ", {
      emptyHint: "Required: the domain SES will verify for sending (often example.com).",
      validate: (value) =>
        looksLikeHostname(value)
          ? null
          : "Use a domain hostname like example.com (no https://).",
    });
    const sesFromEmail = yield* askUntil("From address on outbound mail (e.g. news@example.com): ", {
      emptyHint: "Required: the From: address on mail Nusend sends.",
      validate: (value) =>
        looksLikeEmail(value) ? null : "Enter a full email address (e.g. news@example.com).",
    });
    const marketingEnabled = yield* askBoolean("Also create a marketing SES config set?", false);
    const trackingEnabled = yield* askBoolean("Track opens/clicks?", false);
    const alertEmail = yield* askUntil("Email for AWS ops alerts: ", {
      emptyHint: "Required: where CloudWatch/SNS alarm emails should go.",
      validate: (value) =>
        looksLikeEmail(value) ? null : "Enter a full email address for ops alerts.",
    });
    const route53Raw = yield* askUntil(
      "Route 53 zone ID to auto-create DKIM records (blank = you'll add DNS yourself): ",
      {
        allowEmpty: true,
        validate: (value) =>
          value === "" || /^Z[A-Z0-9]+$/u.test(value)
            ? null
            : "Use a Route 53 hosted zone id like Z123…, or leave blank for manual DNS.",
      },
    );
    const route53HostedZoneId = route53Raw === "" ? null : route53Raw;
    const sshTarget = yield* askUntil("SSH login for the VPS (user@host): ", {
      emptyHint: "Required: SSH target used to deploy (e.g. root@203.0.113.10).",
      validate: (value) =>
        /^[^@\s]+@[^@\s]+$/u.test(value)
          ? null
          : "Use user@host form (e.g. ubuntu@203.0.113.10 or deploy@mail.example.com).",
    });
    const remotePath = yield* askUntil("Directory on the VPS for the app (e.g. /srv/nusend): ", {
      emptyHint: "Required: absolute path on the VPS where Nusend will be checked out.",
      validate: (value) => {
        try {
          assertAbsolutePosixPath(value);
          return null;
        } catch (error) {
          return error instanceof Error
            ? error.message
            : "Use an absolute path like /srv/nusend (no .. segments).";
        }
      },
    });

    const googleClientId = yield* askUntil("Google OAuth client ID: ", {
      emptyHint: "Required: OAuth client ID from Google Cloud (Web application).",
    });
    const googleClientSecret = yield* askSecret("Google OAuth client secret: ", {
      emptyHint: "Required: OAuth client secret from Google Cloud.",
    });
    const resticRepository = yield* askUntil(
      "Cloudflare R2 backup URL (s3:https://<account>.r2.cloudflarestorage.com/<bucket>/nusend): ",
      {
        emptyHint: "Required: restic repository URL on R2 for backups.",
        validate: (value) =>
          value.startsWith("s3:https://")
            ? null
            : "Expected an s3:https://… R2 URL (restic repository form).",
      },
    );
    const r2AccessKeyId = yield* askUntil("R2 access key ID: ", {
      emptyHint: "Required: R2 API token access key id.",
    });
    const r2SecretAccessKey = yield* askSecret("R2 secret access key: ", {
      emptyHint: "Required: R2 API token secret.",
    });

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

    yield* writeLine(`Created setup "${installationId}" in ${store.setupHome(env)}.`);
    yield* writeLine(
      `SSO: ${binding.awsAuth.profileName} · account ${binding.awsAuth.verifiedAccountId} · role ${binding.awsAuth.roleName}`,
    );
    yield* writeLine(
      `SSO region ${binding.awsAuth.identityCenterRegion} · app/SES region ${awsRegion}`,
    );
    yield* writeLine("Next: pnpm nusend:setup doctor && pnpm nusend:setup continue");
    return published;
  });
}
