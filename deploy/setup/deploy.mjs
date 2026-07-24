import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAbsolutePosixPath,
  assertReleaseTag,
  loadDeploymentEnv,
  loadState,
  resolveInstallationId,
  sanitizePlanMetadata,
  secretValuesFromEnv,
  serializeEnvFile,
  writeState,
} from "./state.mjs";

export const DEPLOY_PLAN_KEY = "human_gates";
export const DEPLOY_PLAN_STORE_KEY = "deploy";
export const PUBLIC_REPO_URL = "https://github.com/maxedapps/nusend.git";
export const PUBLIC_REPO_ORIGINS = Object.freeze([
  "https://github.com/maxedapps/nusend.git",
  "https://github.com/maxedapps/nusend",
  "git@github.com:maxedapps/nusend.git",
  "git@github.com:maxedapps/nusend",
  "ssh://git@github.com/maxedapps/nusend.git",
  "ssh://git@github.com/maxedapps/nusend",
]);
export const APP_IMAGE_REPOSITORY = "ghcr.io/maxedapps/nusend";
export const BACKUP_IMAGE_REPOSITORY = "ghcr.io/maxedapps/nusend-backup";
export const OCI_REVISION_LABEL = "org.opencontainers.image.revision";
export const DEPLOY_PHRASE_PREFIX = "DEPLOY";
export const REQUIRED_COMPOSE_MAJOR = 5;
export const REQUIRED_COMPOSE_MINOR = 3;
export const SUPPORTED_ARCHITECTURES = Object.freeze(["x86_64", "amd64", "aarch64", "arm64"]);
export const REQUIRED_SERVICES = Object.freeze(["api", "worker", "caddy", "backup"]);

export const APPLY_CHECKPOINT_CLONED = "cloned";
export const APPLY_CHECKPOINT_ENV = "env_transferred";
export const APPLY_CHECKPOINT_CONFIG = "compose_config";
export const APPLY_CHECKPOINT_PULLED = "pulled";
export const APPLY_CHECKPOINT_IMAGES = "images_verified";
export const APPLY_CHECKPOINT_UP = "up";
export const APPLY_CHECKPOINT_HEALTHY = "healthy";

export const LOCAL_COMPOSE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "compose.yaml",
);

/**
 * @typedef {import('./state.mjs').SetupState} SetupState
 * @typedef {import('./main.mjs').SetupContext} SetupContext
 */

/**
 * Named human/external gates. continue handles one incomplete gate per invocation.
 * Evidence is phrase/prompt based; the coordinator never pretends to complete provider consoles.
 */
export const HUMAN_GATE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "google_oauth",
    title: "Google OAuth exact origin and redirect",
    /**
     * @param {SetupState} state
     */
    requiredValues(state) {
      const origin = `https://${state.config.domain}`;
      return {
        authorizedJavaScriptOrigin: origin,
        authorizedRedirectUri: `${origin}/api/auth/callback/google`,
      };
    },
    /**
     * @param {SetupState} state
     */
    buildPrompt(state) {
      const values = this.requiredValues(state);
      return [
        "Create a Google OAuth Web application client with these exact values:",
        `  Authorized JavaScript origin: ${values.authorizedJavaScriptOrigin}`,
        `  Authorized redirect URI:      ${values.authorizedRedirectUri}`,
        "Confirm the client already uses both values (the coordinator cannot open Google Console).",
      ].join("\n");
    },
    /**
     * @param {SetupState} state
     */
    confirmationPhrase(state) {
      return `GOOGLE-OAUTH ${state.config.domain}`;
    },
  }),
  Object.freeze({
    id: "dns_firewall",
    title: "External DNS and firewall ports/mode",
    /**
     * @param {SetupState} state
     */
    requiredValues(state) {
      return {
        domain: state.config.domain,
        ingressMode: state.config.ingressMode,
        ports: "80,443",
        note:
          state.config.ingressMode === "cloudflare"
            ? "Proxied Cloudflare DNS + Full (strict); origin 80/443 only from Cloudflare ranges"
            : "Public A/AAAA to host; inbound TCP 80/443 open",
      };
    },
    /**
     * @param {SetupState} state
     */
    buildPrompt(state) {
      const values = this.requiredValues(state);
      return [
        "Configure external DNS and the provider firewall (the coordinator will not mutate them):",
        `  Domain: ${values.domain}`,
        `  Ingress mode: ${values.ingressMode}`,
        `  Required ports: TCP ${values.ports}`,
        `  Expectation: ${values.note}`,
      ].join("\n");
    },
    /**
     * @param {SetupState} state
     */
    confirmationPhrase(state) {
      return `DNS-FIREWALL ${state.config.domain} ${state.config.ingressMode} 80,443`;
    },
  }),
  Object.freeze({
    id: "r2_bucket",
    title: "R2 private bucket, token, and repository",
    /**
     * @param {SetupState} state
     */
    requiredValues(state) {
      void state;
      return {
        // Avoid secretish key names (token/password/secret/private) so evidence survives sanitizePlanMetadata.
        bucketVisibility: "private-bucket",
        objectAccessScope: "Object Read & Write for the selected bucket only",
        repositoryForm: "s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/nusend",
      };
    },
    /**
     * @param {SetupState} state
     * @param {Record<string, string>} [deploymentEnv]
     */
    buildPrompt(state, deploymentEnv = {}) {
      void state;
      const repository =
        deploymentEnv.NUSEND_RESTIC_REPOSITORY?.trim() || "(set in deployment.env)";
      return [
        "Confirm the Cloudflare R2 backup target (coordinator cannot create R2 resources):",
        "  Bucket: private",
        "  Token: Object Read & Write, apply to that bucket only",
        `  Repository in deployment.env: ${repository}`,
        "  Form: s3:https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/nusend",
      ].join("\n");
    },
    /**
     * @param {SetupState} state
     */
    confirmationPhrase(state) {
      return `R2-PRIVATE ${state.installationId}`;
    },
  }),
  Object.freeze({
    // Gate id must not match secretish key patterns (password/secret/token) used by sanitizePlanMetadata.
    id: "restic_escrow",
    title: "Independently escrowed restic password",
    /**
     * @param {SetupState} state
     */
    requiredValues(state) {
      void state;
      return {
        escrow: "off-server password manager or equivalent independent store",
        warning: "Losing the restic password makes every backup unreadable",
      };
    },
    /**
     * @param {SetupState} state
     */
    buildPrompt(state) {
      void state;
      return [
        "Escrow the generated NUSEND_RESTIC_PASSWORD independently off-server.",
        "The coordinator will not print or recover it. Losing it makes R2 backups unrecoverable.",
        "Confirm the password is stored outside this workstation setup home.",
      ].join("\n");
    },
    /**
     * @param {SetupState} state
     */
    confirmationPhrase(state) {
      return `RESTIC-ESCROW ${state.installationId}`;
    },
  }),
  Object.freeze({
    id: "alarm_email",
    title: "Alarm email confirmation",
    /**
     * @param {SetupState} state
     */
    requiredValues(state) {
      return {
        alertEmail: state.config.alertEmail,
        action:
          "Confirm the SNS alarm-topic subscription email and keep the exercised-notification gate pending until later validation",
      };
    },
    /**
     * @param {SetupState} state
     */
    buildPrompt(state) {
      return [
        `Confirm the CloudWatch/SNS alarm email subscription for ${state.config.alertEmail}.`,
        "Open the confirmation link from AWS if still pending.",
        "Exercising a live notification remains a later production gate; this only confirms the subscription email.",
      ].join("\n");
    },
    /**
     * @param {SetupState} state
     */
    confirmationPhrase(state) {
      return `ALARM-EMAIL ${state.config.alertEmail}`;
    },
  }),
  Object.freeze({
    id: "ses_approval",
    title: "SES production-access approval",
    /**
     * @param {SetupState} state
     */
    requiredValues(state) {
      const production = state.aws?.productionAccess ?? {};
      return {
        region: state.config.awsRegion,
        status: String(production.status ?? production.reviewStatus ?? "unknown"),
        productionAccessEnabled: production.productionAccessEnabled === true,
      };
    },
    /**
     * @param {SetupState} state
     */
    buildPrompt(state) {
      const values = this.requiredValues(state);
      return [
        "SES production access is a regional AWS review gate outside CloudFormation.",
        `  Region: ${values.region}`,
        `  Recorded status: ${values.status}`,
        `  productionAccessEnabled: ${values.productionAccessEnabled}`,
        "Confirm AWS has approved production access for this account/region (sandbox is insufficient for production mail).",
      ].join("\n");
    },
    /**
     * @param {SetupState} state
     */
    confirmationPhrase(state) {
      return `SES-APPROVED ${state.config.awsAccountId} ${state.config.awsRegion}`;
    },
    /**
     * Auto-complete when AWS state already records approval (still nonsecret).
     * @param {SetupState} state
     */
    isAlreadySatisfied(state) {
      const production = state.aws?.productionAccess ?? {};
      return (
        production.productionAccessEnabled === true ||
        String(production.status ?? "").toLowerCase() === "granted" ||
        String(production.reviewStatus ?? "").toUpperCase() === "GRANTED"
      );
    },
  }),
]);

/**
 * One POSIX single-quote helper for remote shell fragments.
 * @param {string} value
 */
export function posixSingleQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/**
 * OpenSSH joins every argv after the destination with spaces into one remote
 * command string (no per-argument quoting). Always pass exactly one remote argv:
 * `sh -c ${posixSingleQuote(script)}` so spaces/metacharacters survive.
 * @param {string} remoteCommand
 */
export function buildOpenSshRemoteCommand(remoteCommand) {
  return `sh -c ${posixSingleQuote(remoteCommand)}`;
}

/**
 * Build SSH argv after the binary: [target, remoteCommand].
 * @param {string} target
 * @param {string} remoteCommand
 */
export function buildOpenSshArgs(target, remoteCommand) {
  return [assertSshTarget(target), buildOpenSshRemoteCommand(remoteCommand)];
}

/**
 * Conservative SSH target: optional user@ + host/IP. Always passed as one argv element.
 * @param {string} target
 */
export function assertSshTarget(target) {
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("SSH target is required.");
  }
  const trimmed = target.trim();
  if (trimmed.length > 253) {
    throw new Error("SSH target is too long.");
  }
  if (/\s/u.test(trimmed) || /[;|&$`<>(){}[\]\\*"']/u.test(trimmed)) {
    throw new Error(
      `SSH target contains unsafe characters (got "${trimmed}"). Use a single user@host or host value.`,
    );
  }
  if (trimmed.includes("..") || trimmed.includes("=") || trimmed.includes("/")) {
    throw new Error(`SSH target is not a conservative user@host/host value (got "${trimmed}").`);
  }
  const match =
    /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/u.exec(
      trimmed,
    );
  if (!match) {
    throw new Error(`SSH target is invalid (got "${trimmed}"). Expected user@host or host.`);
  }
  return trimmed;
}

/**
 * @param {string} path
 */
export function assertSafeRemotePath(path) {
  const absolute = assertAbsolutePosixPath(path);
  if (absolute === "/") {
    throw new Error("Remote path must not be the filesystem root.");
  }
  if (absolute.length > 512) {
    throw new Error("Remote path is too long.");
  }
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(absolute)) {
    throw new Error(
      `Remote path contains unsupported characters (got "${absolute}"). Use a conservative absolute POSIX path.`,
    );
  }
  return absolute;
}

/**
 * @param {string} sha
 */
export function assertFullCommitSha(sha) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`Expected a 40-hex commit SHA (got "${sha}").`);
  }
  return sha;
}

/**
 * @param {string} sha
 */
export function abbreviateSha(sha) {
  return assertFullCommitSha(sha).slice(0, 7);
}

/**
 * @param {string} origin
 */
export function normalizeGitOrigin(origin) {
  return String(origin ?? "")
    .trim()
    .replace(/\/+$/u, "")
    .toLowerCase();
}

/**
 * @param {string} origin
 */
export function isPublicRepoOrigin(origin) {
  const normalized = normalizeGitOrigin(origin);
  return PUBLIC_REPO_ORIGINS.some((allowed) => normalizeGitOrigin(allowed) === normalized);
}

/**
 * @param {string} text
 */
export function parseComposeVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(text ?? ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

/**
 * @param {{ major: number, minor: number, patch: number }} version
 */
export function isComposeVersionSupported(version) {
  if (version.major > REQUIRED_COMPOSE_MAJOR) return true;
  if (version.major < REQUIRED_COMPOSE_MAJOR) return false;
  return version.minor >= REQUIRED_COMPOSE_MINOR;
}

/**
 * @param {string} arch
 */
export function isSupportedArchitecture(arch) {
  const normalized = String(arch ?? "")
    .trim()
    .toLowerCase();
  return SUPPORTED_ARCHITECTURES.includes(normalized);
}

/**
 * @param {string} arch
 */
export function normalizeArchitecture(arch) {
  const value = String(arch ?? "")
    .trim()
    .toLowerCase();
  if (value === "x86_64" || value === "amd64") return "amd64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  return value;
}

/**
 * @param {string} tag
 */
export function buildAppImageRef(tag) {
  return `${APP_IMAGE_REPOSITORY}:${assertReleaseTag(tag)}`;
}

/**
 * @param {string} tag
 */
export function buildBackupImageRef(tag) {
  return `${BACKUP_IMAGE_REPOSITORY}:${assertReleaseTag(tag)}`;
}

/**
 * @param {{ sshTarget: string, domain: string, remotePath: string, releaseTag: string, commitSha: string }} input
 */
export function buildDeployConfirmationPhrase(input) {
  const sha = abbreviateSha(input.commitSha);
  return `${DEPLOY_PHRASE_PREFIX} ${assertSshTarget(input.sshTarget)} ${input.domain} ${assertSafeRemotePath(input.remotePath)} ${assertReleaseTag(input.releaseTag)} ${sha}`;
}

/**
 * @param {string} answer
 * @param {{ sshTarget: string, domain: string, remotePath: string, releaseTag: string, commitSha: string }} expected
 */
export function validateDeployConfirmation(answer, expected) {
  const phrase = buildDeployConfirmationPhrase(expected);
  if (String(answer ?? "").trim() !== phrase) {
    throw new Error(`Confirmation rejected. Type exactly: ${phrase}`);
  }
  return phrase;
}

/**
 * @param {string} composeBody
 * @param {string} releaseTag
 */
export function extractComposeImageTags(composeBody, releaseTag) {
  const appMatch = /ghcr\.io\/maxedapps\/nusend:(v[^\s"'\\]+)/u.exec(composeBody);
  const backupMatch = /ghcr\.io\/maxedapps\/nusend-backup:(v[^\s"'\\]+)/u.exec(composeBody);
  const appTag = appMatch?.[1] ?? null;
  const backupTag = backupMatch?.[1] ?? null;
  return {
    appTag,
    backupTag,
    appImage: appTag ? `${APP_IMAGE_REPOSITORY}:${appTag}` : null,
    backupImage: backupTag ? `${BACKUP_IMAGE_REPOSITORY}:${backupTag}` : null,
    matchesRelease: appTag === releaseTag && backupTag === releaseTag,
  };
}

/**
 * Build dummy non-secret env assignments for a read-only `docker compose config` probe.
 * Values are placeholders only — never real secrets from deployment.env.
 * @param {SetupState} state
 */
export function buildComposeConfigDummyAssignments(state) {
  /** @type {Record<string, string>} */
  const values = {
    NUSEND_DOMAIN: state.config.domain,
    NUSEND_INGRESS_MODE: state.config.ingressMode,
    NUSEND_OWNER_EMAIL: "owner@example.invalid",
    NUSEND_OWNER_NAME: "Owner",
    BETTER_AUTH_SECRET: "compose-config-dummy-better-auth-secret-0001",
    GOOGLE_CLIENT_ID: "compose-config-dummy-google-client-id",
    GOOGLE_CLIENT_SECRET: "compose-config-dummy-google-client-secret",
    NUSEND_API_KEY_HASH_SECRET: "compose-config-dummy-api-key-hash-secret-01",
    NUSEND_UNSUBSCRIBE_SECRET: "compose-config-dummy-unsubscribe-secret-01",
    AWS_ACCESS_KEY_ID: "AKIADUMMYCOMPOSECONFIG01",
    AWS_SECRET_ACCESS_KEY: "compose-config-dummy-aws-secret-access-key",
    AWS_REGION: state.config.awsRegion,
    NUSEND_SES_FROM_EMAIL: state.config.sesFromEmail,
    NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "dummy-transactional",
    NUSEND_SES_FEEDBACK_TOPIC_ARNS: "arn:aws:sns:us-east-1:000000000000:dummy",
    NUSEND_RESTIC_REPOSITORY: "s3:https://example.invalid/bucket/nusend",
    NUSEND_R2_ACCESS_KEY_ID: "r2-dummy-access",
    NUSEND_R2_SECRET_ACCESS_KEY: "compose-config-dummy-r2-secret-access-key",
    NUSEND_RESTIC_PASSWORD: "compose-config-dummy-restic-password-0001",
  };
  if (state.config.marketingEnabled) {
    values.NUSEND_SES_MARKETING_CONFIGURATION_SET = "dummy-marketing";
  }
  return values;
}

/**
 * Inline dummy env assignments for `env KEY=val ...` (values POSIX-single-quoted).
 * @param {Record<string, string>} dummyEnv
 */
export function buildDummyEnvAssignments(dummyEnv) {
  return Object.entries(dummyEnv)
    .map(([key, value]) => `${key}=${posixSingleQuote(value)}`)
    .join(" ");
}

/**
 * Remote shell that sets dummy env inline and runs compose config — no file writes.
 * @param {string} remotePath
 * @param {Record<string, string>} dummyEnv
 */
export function buildRemoteComposeConfigCommand(remotePath, dummyEnv) {
  const assignments = buildDummyEnvAssignments(dummyEnv);
  return `cd ${posixSingleQuote(remotePath)} && env ${assignments} docker compose config --quiet`;
}

/**
 * Read-only remote Compose render from local compose.yaml over SSH stdin.
 * No remote path/checkout required; no file writes; dummy non-secret env only.
 * @param {Record<string, string>} dummyEnv
 */
export function buildRemoteComposeConfigFromStdinCommand(dummyEnv) {
  const assignments = buildDummyEnvAssignments(dummyEnv);
  return `env ${assignments} docker compose -f - config --quiet`;
}

/**
 * Stdin → mode-0600 temp (POSIX mktemp in destination dir) → atomic rename.
 * No secrets in argv. Avoids `$RANDOM` (not set under dash `set -u`).
 * @param {string} remoteEnvPath
 */
export function buildRemoteEnvTransferScript(remoteEnvPath) {
  const dest = assertSafeRemotePath(remoteEnvPath);
  const directory = dest.slice(0, dest.lastIndexOf("/")) || "/";
  return [
    "set -eu",
    `dest=${posixSingleQuote(dest)}`,
    `dir=${posixSingleQuote(directory)}`,
    'tmp=$(mktemp "$dir/.env.tmp.XXXXXX")',
    'cleanup() { rm -f "$tmp"; }',
    "trap cleanup EXIT HUP INT TERM",
    "umask 077",
    'cat >"$tmp"',
    'chmod 600 "$tmp"',
    'mv -f "$tmp" "$dest"',
    "trap - EXIT HUP INT TERM",
  ].join("; ");
}

/**
 * docker image inspect with the entire Go template as one shell word.
 * @param {string} imageRef
 */
export function buildRemoteImageInspectCommand(imageRef) {
  const format = `{{ index .Config.Labels "${OCI_REVISION_LABEL}" }}`;
  return `docker image inspect --format=${posixSingleQuote(format)} ${posixSingleQuote(imageRef)}`;
}

/**
 * @param {string} remotePath
 * @param {string} releaseTag
 * @param {string} commitSha
 */
export function buildRemoteCloneScript(remotePath, releaseTag, commitSha) {
  const path = assertSafeRemotePath(remotePath);
  const tag = assertReleaseTag(releaseTag);
  const sha = assertFullCommitSha(commitSha);
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  return [
    "set -eu",
    `path=${posixSingleQuote(path)}`,
    `parent=${posixSingleQuote(parent)}`,
    `tag=${posixSingleQuote(tag)}`,
    `url=${posixSingleQuote(PUBLIC_REPO_URL)}`,
    `expected=${posixSingleQuote(sha)}`,
    'if [ -e "$path" ]; then',
    '  if [ -d "$path" ] && [ -z "$(ls -A "$path" 2>/dev/null || true)" ]; then',
    '    rmdir "$path"',
    "  else",
    '    echo "refusing to clone: path exists and is not an empty directory" >&2',
    "    exit 20",
    "  fi",
    "fi",
    'if [ ! -d "$parent" ]; then echo "parent directory missing: $parent" >&2; exit 21; fi',
    'if [ ! -w "$parent" ]; then echo "parent directory not writable: $parent" >&2; exit 22; fi',
    'git clone --branch "$tag" -- "$url" "$path"',
    'head=$(git -C "$path" rev-parse HEAD)',
    'if [ "$head" != "$expected" ]; then',
    '  echo "cloned HEAD $head does not match planned commit $expected" >&2',
    "  exit 23",
    "fi",
    'printf "%s\\n" "$head"',
  ].join("; ");
}

/**
 * Fingerprint planned deploy inputs (non-secret).
 * @param {Record<string, unknown>} planBody
 */
export function fingerprintDeployPlan(planBody) {
  const canonical = JSON.stringify({
    commitSha: planBody.commitSha,
    releaseTag: planBody.releaseTag,
    sshTarget: planBody.sshTarget,
    remotePath: planBody.remotePath,
    domain: planBody.domain,
    pathMode: planBody.pathMode,
    architecture: planBody.architecture,
    appImage: planBody.appImage,
    backupImage: planBody.backupImage,
    dockerVersion: planBody.dockerVersion,
    composeVersion: planBody.composeVersion,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} remoteCommand
 * @param {{ stdin?: string, redact?: readonly string[], allowNonZero?: boolean }} [options]
 */
export async function runSsh(ctx, state, remoteCommand, options = {}) {
  const target = assertSshTarget(state.config.sshTarget);
  // Never disable host-key checking; never pass UserKnownHostsFile=/dev/null.
  // OpenSSH joins remote argv with spaces — pass one safely quoted `sh -c '…'` word.
  const result = await ctx.executor({
    command: "ssh",
    args: buildOpenSshArgs(target, remoteCommand),
    stdin: options.stdin,
    redact: options.redact,
    allowNonZero: options.allowNonZero,
  });
  assertNoHostKeyBypass(result.argv);
  return result;
}

/**
 * @param {readonly string[] | undefined} argv
 */
export function assertNoHostKeyBypass(argv = []) {
  const joined = argv.join(" ");
  if (
    /StrictHostKeyChecking\s*=\s*no/iu.test(joined) ||
    /UserKnownHostsFile\s*=\s*\/dev\/null/iu.test(joined)
  ) {
    throw new Error("Refusing SSH invocation that disables host-key verification.");
  }
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} releaseTag
 */
export async function resolveReleaseCommitSha(ctx, state, releaseTag) {
  void state;
  const tag = assertReleaseTag(releaseTag);
  const result = await ctx.executor({
    command: "git",
    args: ["ls-remote", "--tags", "--refs", PUBLIC_REPO_URL, `refs/tags/${tag}`],
  });
  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`Release tag ${tag} was not found on ${PUBLIC_REPO_URL}.`);
  }
  if (lines.length !== 1) {
    throw new Error(
      `Release tag ${tag} resolved to ${lines.length} refs; expected exactly one immutable tag.`,
    );
  }
  const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+)$/u.exec(lines[0] ?? "");
  if (!match) {
    throw new Error(`Could not parse git ls-remote output for ${tag}: ${lines[0]}`);
  }
  if (match[2] !== tag) {
    throw new Error(`git ls-remote returned unexpected tag ${match[2]} (wanted ${tag}).`);
  }
  return assertFullCommitSha(match[1] ?? "");
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} remotePath
 */
export async function inspectRemotePath(ctx, state, remotePath) {
  const path = assertSafeRemotePath(remotePath);
  const script = [
    "set -eu",
    `path=${posixSingleQuote(path)}`,
    `parent=${posixSingleQuote(path.slice(0, path.lastIndexOf("/")) || "/")}`,
    'if [ ! -e "$path" ]; then',
    '  if [ -d "$parent" ] && [ -w "$parent" ]; then echo "ABSENT_WRITABLE_PARENT"; exit 0; fi',
    '  if [ ! -e "$parent" ]; then echo "ABSENT_PARENT_MISSING"; exit 0; fi',
    '  echo "ABSENT_PARENT_NOT_WRITABLE"; exit 0',
    "fi",
    'if [ ! -d "$path" ]; then echo "EXISTS_NOT_DIRECTORY"; exit 0; fi',
    'if [ -z "$(ls -A "$path" 2>/dev/null || true)" ]; then',
    '  if [ -w "$path" ] || [ -w "$parent" ]; then echo "EMPTY_DIRECTORY"; else echo "EMPTY_DIRECTORY_NOT_WRITABLE"; fi',
    "  exit 0",
    "fi",
    'if [ -d "$path/.git" ]; then echo "EXISTING_GIT"; exit 0; fi',
    'echo "NONEMPTY_NOT_GIT"',
  ].join("; ");
  const result = await runSsh(ctx, state, script);
  const code = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
  /** @type {"absent" | "empty" | "existing_git" | "error"} */
  let mode = "error";
  let detail = code;
  if (code === "ABSENT_WRITABLE_PARENT") {
    mode = "absent";
    detail = "path absent; parent exists and is writable";
  } else if (code === "EMPTY_DIRECTORY") {
    mode = "empty";
    detail = "path is an empty directory";
  } else if (code === "EXISTING_GIT") {
    mode = "existing_git";
    detail = "path contains a git checkout";
  } else if (code === "ABSENT_PARENT_MISSING") {
    detail = "path absent and parent directory is missing";
  } else if (code === "ABSENT_PARENT_NOT_WRITABLE") {
    detail = "path absent and parent directory is not writable";
  } else if (code === "EMPTY_DIRECTORY_NOT_WRITABLE") {
    detail = "path is empty but not writable";
  } else if (code === "EXISTS_NOT_DIRECTORY") {
    detail = "path exists and is not a directory";
  } else if (code === "NONEMPTY_NOT_GIT") {
    detail =
      "path is non-empty without a .git directory (partial/non-git content is not auto-deleted)";
  }
  return { mode, detail, code };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} remotePath
 * @param {string} releaseTag
 * @param {string} commitSha
 */
export async function inspectExistingCheckout(ctx, state, remotePath, releaseTag, commitSha) {
  const path = assertSafeRemotePath(remotePath);
  const tag = assertReleaseTag(releaseTag);
  const expected = assertFullCommitSha(commitSha);
  const script = [
    "set -eu",
    `path=${posixSingleQuote(path)}`,
    `tag=${posixSingleQuote(tag)}`,
    'origin=$(git -C "$path" remote get-url origin)',
    'porcelain=$(git -C "$path" status --porcelain)',
    'head=$(git -C "$path" rev-parse HEAD)',
    'branch=$(git -C "$path" symbolic-ref -q --short HEAD || true)',
    'tag_sha=$(git -C "$path" rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null || true)',
    'printf "ORIGIN:%s\\n" "$origin"',
    'printf "PORCELAIN:%s\\n" "$porcelain"',
    'printf "HEAD:%s\\n" "$head"',
    'printf "BRANCH:%s\\n" "$branch"',
    'printf "TAG_SHA:%s\\n" "$tag_sha"',
  ].join("; ");
  const result = await runSsh(ctx, state, script);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of result.stdout.split(/\r?\n/u)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  const origin = fields.ORIGIN ?? "";
  const porcelain = fields.PORCELAIN ?? "";
  const head = fields.HEAD ?? "";
  const branch = fields.BRANCH ?? "";
  const tagSha = fields.TAG_SHA ?? "";

  if (!isPublicRepoOrigin(origin)) {
    throw new Error(
      `Existing checkout origin "${origin}" is not the public Nusend repository. Refusing to adopt or update it.`,
    );
  }
  if (porcelain.trim() !== "") {
    throw new Error(
      "Existing checkout has a dirty worktree. Commit/clean it manually; deploy will not reset or discard changes.",
    );
  }
  if (head !== expected) {
    throw new Error(
      `Existing checkout HEAD ${head || "unknown"} does not match planned commit ${expected}. Deploy will not fetch/reset.`,
    );
  }
  if (branch) {
    throw new Error(
      `Existing checkout is on branch "${branch}". Deploy requires a clean detached HEAD or exact tag at ${expected}.`,
    );
  }
  if (!tagSha) {
    throw new Error(
      `Existing checkout is missing local release tag ${tag}. Deploy requires the exact tag to resolve to planned commit ${expected}.`,
    );
  }
  if (tagSha !== expected) {
    throw new Error(
      `Local tag ${tag} points at ${tagSha}, not planned commit ${expected}. Refusing moved/mismatched tag.`,
    );
  }
  return {
    origin,
    head,
    branch: branch || null,
    tagSha,
    clean: true,
  };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 */
export async function inspectRemoteRuntime(ctx, state) {
  const uname = await runSsh(ctx, state, "uname -s; uname -m");
  const lines = uname.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const kernel = lines[0] ?? "";
  const archRaw = lines[1] ?? "";
  if (!/^linux$/iu.test(kernel)) {
    throw new Error(`Remote kernel must be Linux (got "${kernel}").`);
  }
  if (!isSupportedArchitecture(archRaw)) {
    throw new Error(
      `Remote architecture "${archRaw}" is unsupported. Require one of: ${SUPPORTED_ARCHITECTURES.join(", ")}.`,
    );
  }

  const docker = await runSsh(ctx, state, "docker version --format '{{.Server.Version}}'");
  const dockerVersion = docker.stdout.trim();
  if (!dockerVersion) {
    throw new Error("Could not read remote Docker server version.");
  }

  const compose = await runSsh(ctx, state, "docker compose version");
  const composeText = `${compose.stdout}\n${compose.stderr}`;
  const composeVersion = parseComposeVersion(composeText);
  if (!composeVersion) {
    throw new Error(`Could not parse remote Docker Compose version from: ${composeText.trim()}`);
  }
  if (!isComposeVersionSupported(composeVersion)) {
    throw new Error(
      `Docker Compose ${composeVersion.raw} is too old; require ${REQUIRED_COMPOSE_MAJOR}.${REQUIRED_COMPOSE_MINOR}+.`,
    );
  }

  // Port context only — never mutate firewall/listeners.
  const ports = await runSsh(
    ctx,
    state,
    "if command -v ss >/dev/null 2>&1; then ss -lnt 2>/dev/null || true; elif command -v netstat >/dev/null 2>&1; then netstat -lnt 2>/dev/null || true; else echo 'NO_PORT_TOOL'; fi",
    { allowNonZero: true },
  );
  const portText = ports.stdout;
  const listening80 = /:80\b/u.test(portText);
  const listening443 = /:443\b/u.test(portText);

  return {
    kernel: "linux",
    architecture: normalizeArchitecture(archRaw),
    architectureRaw: archRaw,
    dockerVersion,
    composeVersion: composeVersion.raw,
    ports: {
      toolOutputPresent: portText.trim() !== "" && !portText.includes("NO_PORT_TOOL"),
      listening80,
      listening443,
      note: "informational only; deploy does not open firewall ports",
    },
  };
}

/**
 * @param {SetupContext} ctx
 */
export async function runDeployPlan(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  const state = await loadState(installationId, ctx.env);
  if (state.stages.aws_core?.status !== "complete") {
    throw new Error(
      "Deploy plan requires completed aws_core stage. Finish AWS core setup before deploy plan.",
    );
  }
  if (state.stages.human_gates?.status !== "complete") {
    throw new Error(
      "Deploy plan requires completed human_gates stage. Finish human/external gates before deploy plan.",
    );
  }
  const sshTarget = assertSshTarget(state.config.sshTarget);
  const remotePath = assertSafeRemotePath(state.config.remotePath);
  const releaseTag = assertReleaseTag(state.config.releaseTag);
  const domain = state.config.domain;

  log("Deploy plan (read-only SSH inspection; no remote mkdir/clone/write/pull/up).");

  const commitSha = await resolveReleaseCommitSha(ctx, state, releaseTag);
  const abbreviatedSha = abbreviateSha(commitSha);
  log(`Release ${releaseTag} -> ${commitSha}`);

  const localCompose = await readFile(LOCAL_COMPOSE_PATH, "utf8");
  const localImages = extractComposeImageTags(localCompose, releaseTag);
  if (!localImages.matchesRelease) {
    throw new Error(
      `Local compose.yaml image tags (app=${localImages.appTag}, backup=${localImages.backupTag}) do not match release ${releaseTag}.`,
    );
  }

  const runtime = await inspectRemoteRuntime(ctx, state);
  const pathInfo = await inspectRemotePath(ctx, state, remotePath);

  /** @type {"empty" | "existing"} */
  let pathMode;
  /** @type {Record<string, unknown>} */
  let checkout = {};
  /** @type {Record<string, unknown>} */
  let composeReadiness = {};

  if (pathInfo.mode === "absent" || pathInfo.mode === "empty") {
    pathMode = "empty";
    // Truly read-only remote Compose render: local compose.yaml over SSH stdin, dummy env, no writes.
    const dummy = buildComposeConfigDummyAssignments(state);
    const configCmd = buildRemoteComposeConfigFromStdinCommand(dummy);
    await runSsh(ctx, state, configCmd, { stdin: localCompose });
    composeReadiness = {
      mode: "local_compose_stdin_remote_render",
      limitation:
        "Empty remote path has no checkout yet. Compose config was rendered remotely from local compose.yaml over SSH stdin with inline dummy non-secret env; no remote files were written and real secrets were not used.",
      localComposeImageMatch: true,
      remoteConfigQuiet: true,
      remoteEngineReady: true,
    };
    log(`Remote path ${remotePath}: empty target (${pathInfo.detail}).`);
    log("Remote Compose render (stdin compose.yaml + dummy env) succeeded.");
  } else if (pathInfo.mode === "existing_git") {
    pathMode = "existing";
    checkout = await inspectExistingCheckout(ctx, state, remotePath, releaseTag, commitSha);
    const dummy = buildComposeConfigDummyAssignments(state);
    const configCmd = buildRemoteComposeConfigCommand(remotePath, dummy);
    await runSsh(ctx, state, configCmd);
    // Optional: verify remote compose image pins without dumping env.
    const remoteCompose = await runSsh(
      ctx,
      state,
      `cd ${posixSingleQuote(remotePath)} && cat compose.yaml`,
    );
    const remoteImages = extractComposeImageTags(remoteCompose.stdout, releaseTag);
    if (!remoteImages.matchesRelease) {
      throw new Error(
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
    log(`Remote path ${remotePath}: existing clean checkout at ${commitSha}.`);
  } else {
    throw new Error(
      `Remote path ${remotePath} is not usable for deploy (${pathInfo.detail}). Partial non-git content is never deleted automatically.`,
    );
  }

  const appImage = buildAppImageRef(releaseTag);
  const backupImage = buildBackupImageRef(releaseTag);
  const plannedAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const planBody = {
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

  /** @type {SetupState} */
  const nextState = {
    ...state,
    updatedAt: plannedAt,
    plans: {
      ...state.plans,
      [DEPLOY_PLAN_STORE_KEY]: sanitizePlanMetadata(planBody),
    },
  };
  await writeState(nextState, ctx.env);

  log(`Architecture: linux/${runtime.architecture} (raw ${runtime.architectureRaw})`);
  log(`Docker ${runtime.dockerVersion}; Compose ${runtime.composeVersion}`);
  log(
    `Ports context: 80=${runtime.ports.listening80 ? "listen" : "free/unknown"}, 443=${runtime.ports.listening443 ? "listen" : "free/unknown"} (informational)`,
  );
  log(`Images: ${appImage}, ${backupImage}`);
  log(`Fingerprint: ${fingerprint}`);
  log(
    "Plan stored. Review, then run `pnpm nusend:setup deploy apply` with the confirmation phrase.",
  );
  return planBody;
}

/**
 * @param {SetupContext} ctx
 */
export async function runDeployApply(ctx) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = await resolveInstallationId(ctx.env);
  let state = await loadState(installationId, ctx.env);
  const plan = state.plans?.[DEPLOY_PLAN_STORE_KEY];
  if (plan == null || typeof plan !== "object") {
    throw new Error("No stored deploy plan. Run `pnpm nusend:setup deploy plan` first.");
  }
  if (plan.consumed === true && plan.applyCheckpoint === APPLY_CHECKPOINT_HEALTHY) {
    throw new Error(
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
    throw new Error("Stored deploy plan is incomplete. Re-run `pnpm nusend:setup deploy plan`.");
  }
  if (sshTarget !== state.config.sshTarget) {
    throw new Error("Stored deploy plan SSH target does not match installation config.");
  }
  if (domain !== state.config.domain) {
    throw new Error("Stored deploy plan domain does not match installation config.");
  }
  if (remotePath !== state.config.remotePath) {
    throw new Error("Stored deploy plan remote path does not match installation config.");
  }
  if (releaseTag !== state.config.releaseTag) {
    throw new Error("Stored deploy plan release tag does not match installation config.");
  }
  if (pathMode !== "empty" && pathMode !== "existing") {
    throw new Error(`Stored deploy plan has invalid pathMode "${pathMode}".`);
  }

  // Reject moved tags before any mutation (and on resume).
  const liveSha = await resolveReleaseCommitSha(ctx, state, releaseTag);
  if (liveSha !== commitSha) {
    throw new Error(
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
    throw new Error(
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
    log(
      `About to deploy ${releaseTag} (${abbreviateSha(commitSha)}) to ${sshTarget}:${remotePath}.`,
    );
    log(`Type exactly: ${expectedPhrase}`);
    const answer = await ctx.io.prompt("Confirmation: ");
    validateDeployConfirmation(answer, {
      sshTarget,
      domain,
      remotePath,
      releaseTag,
      commitSha,
    });
  } else {
    log(
      `Resuming deploy apply from checkpoint "${applyCheckpoint}" (no moved-tag adoption; env/volumes/checkout preserved).`,
    );
  }

  const deployment = await loadDeploymentEnv(installationId, ctx.env);
  const secrets = secretValuesFromEnv(deployment);
  const envBody = serializeEnvFile(deployment);
  for (const secret of secrets) {
    if (secret && expectedPhrase.includes(secret)) {
      throw new Error("Internal error: confirmation phrase unexpectedly contained a secret.");
    }
  }

  /**
   * @param {string | null} checkpoint
   * @param {Record<string, unknown>} [extra]
   */
  async function persistCheckpoint(checkpoint, extra = {}) {
    applyCheckpoint = checkpoint;
    const now = new Date().toISOString();
    state = await loadState(installationId, ctx.env);
    const previous = state.plans?.[DEPLOY_PLAN_STORE_KEY] ?? plan;
    /** @type {SetupState} */
    const next = {
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
    if (checkpoint === APPLY_CHECKPOINT_HEALTHY) {
      next.deploy = sanitizePlanMetadata({
        commitSha,
        releaseTag,
        sshTarget,
        remotePath,
        domain,
        appImage,
        backupImage,
        appliedAt: now,
        fingerprint,
      });
    }
    await writeState(next, ctx.env);
    state = next;
  }

  // 1) Checkout (first run) or re-validate + replay lifecycle (non-healthy resume).
  if (!applyCheckpoint) {
    if (pathMode === "empty") {
      // If a previous failed clone left a git dir, treat as existing — never delete.
      const pathInfo = await inspectRemotePath(ctx, state, remotePath);
      if (pathInfo.mode === "existing_git") {
        log("Remote path already has a git checkout; validating instead of deleting/cloning.");
        await inspectExistingCheckout(ctx, state, remotePath, releaseTag, commitSha);
      } else if (pathInfo.mode === "absent" || pathInfo.mode === "empty") {
        log(`Cloning ${PUBLIC_REPO_URL} at ${releaseTag} into ${remotePath}.`);
        const clone = await runSsh(
          ctx,
          state,
          buildRemoteCloneScript(remotePath, releaseTag, commitSha),
        );
        const head = clone.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
        if (head !== commitSha) {
          throw new Error(`Clone HEAD ${head} does not match planned commit ${commitSha}.`);
        }
      } else {
        throw new Error(
          `Cannot clone into ${remotePath}: ${pathInfo.detail}. Existing partial content is never deleted.`,
        );
      }
    } else {
      await inspectExistingCheckout(ctx, state, remotePath, releaseTag, commitSha);
    }
    await persistCheckpoint(APPLY_CHECKPOINT_CLONED);
  } else if (applyCheckpoint !== APPLY_CHECKPOINT_HEALTHY) {
    // Resume: always re-validate checkout; never fetch/reset/delete.
    await inspectExistingCheckout(ctx, state, remotePath, releaseTag, commitSha);
    // Re-transfer current local env and replay compose lifecycle so corrections apply.
    if (applyCheckpoint !== APPLY_CHECKPOINT_CLONED) {
      log(
        `Resetting resume checkpoint "${applyCheckpoint}" to "${APPLY_CHECKPOINT_CLONED}" to re-transfer env and replay config→pull→images→up→health (volumes/checkout preserved).`,
      );
      await persistCheckpoint(APPLY_CHECKPOINT_CLONED);
    }
  }

  // 2) Env transfer via SSH stdin only
  if (applyCheckpoint === APPLY_CHECKPOINT_CLONED) {
    const remoteEnvPath = `${assertSafeRemotePath(remotePath)}/.env`;
    const transferScript = buildRemoteEnvTransferScript(remoteEnvPath);
    log("Transferring deployment.env over SSH stdin to a mode-0600 temp file with atomic rename.");
    const transfer = await runSsh(ctx, state, transferScript, {
      stdin: envBody,
      redact: secrets,
    });
    assertArgvFreeOfSecrets(transfer.argv, secrets);
    // Verify mode without printing contents.
    const modeCheck = await runSsh(
      ctx,
      state,
      `stat -c '%a' ${posixSingleQuote(remoteEnvPath)} 2>/dev/null || stat -f '%OLp' ${posixSingleQuote(remoteEnvPath)}`,
      { redact: secrets },
    );
    const mode = modeCheck.stdout.trim();
    if (mode !== "600" && mode !== "0600") {
      throw new Error(`Remote .env mode is ${mode || "unknown"}; expected 600.`);
    }
    await persistCheckpoint(APPLY_CHECKPOINT_ENV, { remoteEnvMode: "600" });
  }

  // 3) compose config
  if (applyCheckpoint === APPLY_CHECKPOINT_ENV) {
    log("Running remote docker compose config --quiet.");
    await runSsh(
      ctx,
      state,
      `cd ${posixSingleQuote(remotePath)} && docker compose config --quiet`,
      { redact: secrets },
    );
    await persistCheckpoint(APPLY_CHECKPOINT_CONFIG);
  }

  // 4) pull
  if (applyCheckpoint === APPLY_CHECKPOINT_CONFIG) {
    log("Running remote docker compose pull.");
    await runSsh(ctx, state, `cd ${posixSingleQuote(remotePath)} && docker compose pull`, {
      redact: secrets,
    });
    await persistCheckpoint(APPLY_CHECKPOINT_PULLED);
  }

  // 5) image OCI revision labels before up
  if (applyCheckpoint === APPLY_CHECKPOINT_PULLED) {
    log("Verifying app/backup image OCI source-revision labels match planned commit.");
    await assertRemoteImageRevision(ctx, state, appImage, commitSha);
    await assertRemoteImageRevision(ctx, state, backupImage, commitSha);
    const remoteCompose = await runSsh(
      ctx,
      state,
      `cd ${posixSingleQuote(remotePath)} && cat compose.yaml`,
    );
    const remoteImages = extractComposeImageTags(remoteCompose.stdout, releaseTag);
    if (!remoteImages.matchesRelease) {
      throw new Error(`Remote compose image tags do not match release ${releaseTag} before up.`);
    }
    if (remoteImages.appImage !== appImage || remoteImages.backupImage !== backupImage) {
      throw new Error("Remote compose image refs do not match planned exact tag image refs.");
    }
    await persistCheckpoint(APPLY_CHECKPOINT_IMAGES, {
      appImageRevision: commitSha,
      backupImageRevision: commitSha,
    });
  }

  // 6) up
  if (applyCheckpoint === APPLY_CHECKPOINT_IMAGES) {
    log("Running remote docker compose up -d --wait.");
    await runSsh(ctx, state, `cd ${posixSingleQuote(remotePath)} && docker compose up -d --wait`, {
      redact: secrets,
    });
    await persistCheckpoint(APPLY_CHECKPOINT_UP);
  }

  // 7) health
  if (applyCheckpoint === APPLY_CHECKPOINT_UP) {
    log("Validating Compose service/backup health and public/private health endpoints.");
    const health = await validateDeployHealth(ctx, state, {
      domain,
      remotePath,
      secrets,
    });
    await persistCheckpoint(APPLY_CHECKPOINT_HEALTHY, { health });
    log(
      `Deploy apply complete for ${releaseTag} (${abbreviateSha(commitSha)}). continue can checkpoint deploy on live health evidence.`,
    );
    return { commitSha, health, state };
  }

  throw new Error(`Deploy apply stopped in unexpected checkpoint state: ${applyCheckpoint}`);
}

/**
 * @param {readonly string[]} argv
 * @param {readonly string[]} secrets
 */
export function assertArgvFreeOfSecrets(argv, secrets) {
  const joined = argv.join("\0");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4 && joined.includes(secret)) {
      throw new Error("Refusing to continue: a secret value appeared in process argv.");
    }
  }
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {string} imageRef
 * @param {string} commitSha
 */
export async function assertRemoteImageRevision(ctx, state, imageRef, commitSha) {
  const expected = assertFullCommitSha(commitSha);
  // Entire Go --format template must be one shell word.
  const result = await runSsh(ctx, state, buildRemoteImageInspectCommand(imageRef));
  const revision = result.stdout.trim();
  if (revision !== expected) {
    throw new Error(
      `Image ${imageRef} OCI label ${OCI_REVISION_LABEL}="${revision || "<missing>"}" does not equal planned commit ${expected}. Refusing moved registry tag.`,
    );
  }
  return revision;
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 * @param {{ domain: string, remotePath: string, secrets?: readonly string[] }} options
 */
export async function validateDeployHealth(ctx, state, options) {
  const remotePath = assertSafeRemotePath(options.remotePath);
  const domain = options.domain;
  const secrets = options.secrets ?? [];

  const ps = await runSsh(
    ctx,
    state,
    `cd ${posixSingleQuote(remotePath)} && docker compose ps --format json`,
    { redact: secrets },
  );
  const services = parseComposePsJson(ps.stdout);
  /** @type {Record<string, { state: string, health: string }>} */
  const serviceHealth = {};
  /** @type {string[]} */
  const needsInspect = [];
  // compose.yaml defines healthchecks only on api + backup. worker/caddy must be running;
  // public /health proves the caddy route. api + backup must be healthy.
  const healthcheckedServices = new Set(["api", "backup"]);
  for (const name of REQUIRED_SERVICES) {
    const entry = services.find((item) => item.service === name || item.name === name);
    if (!entry) {
      throw new Error(`Compose service "${name}" is missing from docker compose ps.`);
    }
    const running = /running/iu.test(entry.state) || /running/iu.test(entry.status);
    const health = entry.health || deriveHealthFromStatus(entry.status);
    if (!running) {
      throw new Error(
        `Compose service "${name}" is not running (state=${entry.state}, status=${entry.status}).`,
      );
    }
    if (!healthcheckedServices.has(name)) {
      serviceHealth[name] = { state: entry.state || entry.status, health: health || "running" };
      continue;
    }
    if (health === "healthy") {
      serviceHealth[name] = { state: entry.state || entry.status, health: "healthy" };
      continue;
    }
    if (health && health !== "none" && health !== "") {
      throw new Error(`Compose service "${name}" health is "${health}", expected healthy.`);
    }
    // Compose JSON lacked Health — inspect as a fallback for healthchecked services only.
    needsInspect.push(name);
    serviceHealth[name] = { state: entry.state || entry.status, health: "pending-inspect" };
  }
  if (needsInspect.length > 0) {
    const inspected = await Promise.all(
      needsInspect.map(async (name) => {
        const result = await runSsh(
          ctx,
          state,
          `cd ${posixSingleQuote(remotePath)} && docker compose ps -q ${posixSingleQuote(name)} | while read id; do docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"; done`,
          { redact: secrets },
        );
        return {
          name,
          value: result.stdout.trim().split(/\r?\n/u).at(-1) ?? "",
        };
      }),
    );
    for (const { name, value } of inspected) {
      if (value !== "healthy") {
        throw new Error(`Compose service "${name}" must be healthy (got "${value || "unknown"}").`);
      }
      serviceHealth[name] = {
        state: serviceHealth[name]?.state ?? "running",
        health: value,
      };
    }
  }

  // Public health from workstation (args only; no shell) — proves caddy routes /health.
  const publicHealth = await ctx.executor({
    command: "curl",
    args: ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", `https://${domain}/health`],
    redact: secrets,
  });
  const publicHealthCode = publicHealth.stdout.trim();
  if (publicHealthCode !== "200") {
    throw new Error(`Public /health returned HTTP ${publicHealthCode}, expected 200.`);
  }

  const publicDb = await ctx.executor({
    command: "curl",
    args: ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `https://${domain}/health/db`],
    redact: secrets,
    allowNonZero: true,
  });
  const publicDbCode = publicDb.stdout.trim();
  if (publicDbCode !== "404") {
    throw new Error(`Public /health/db returned HTTP ${publicDbCode}, expected 404.`);
  }

  // Private API /health/db success via compose exec
  await runSsh(
    ctx,
    state,
    `cd ${posixSingleQuote(remotePath)} && docker compose exec -T api bun -e ${posixSingleQuote("const r=await fetch('http://127.0.0.1:3000/health/db');if(!r.ok)process.exit(1)")}`,
    { redact: secrets },
  );

  return {
    services: serviceHealth,
    publicHealth: publicHealthCode,
    publicHealthDb: publicDbCode,
    // Key must not match sanitizePlanMetadata secretish patterns (e.g. "private").
    apiHealthDb: "ok",
    backupMandatory: true,
  };
}

/**
 * @param {string} stdout
 * @returns {Array<{ service: string, name: string, state: string, status: string, health: string }>}
 */
export function parseComposePsJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  // compose may emit NDJSON or a JSON array
  try {
    if (text.startsWith("[")) {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizePsEntry);
      }
    }
  } catch {
    // fall through to NDJSON
  }
  /** @type {Array<{ service: string, name: string, state: string, status: string, health: string }>} */
  const out = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(normalizePsEntry(JSON.parse(trimmed)));
    } catch {
      // ignore non-json lines
    }
  }
  return out;
}

/**
 * @param {any} entry
 */
function normalizePsEntry(entry) {
  const service = String(entry.Service ?? entry.service ?? entry.Name ?? entry.name ?? "");
  const name = String(entry.Name ?? entry.name ?? service);
  const state = String(entry.State ?? entry.state ?? "");
  const status = String(entry.Status ?? entry.status ?? "");
  const health = String(entry.Health ?? entry.health ?? deriveHealthFromStatus(status) ?? "");
  return { service, name, state, status, health };
}

/**
 * @param {string} status
 */
function deriveHealthFromStatus(status) {
  const match = /\((healthy|unhealthy|starting|none)\)/iu.exec(String(status ?? ""));
  return match?.[1]?.toLowerCase() ?? "";
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 */
export function listHumanGateProgress(state) {
  const stored = state.plans?.[DEPLOY_PLAN_KEY];
  const completed =
    stored && typeof stored === "object" && stored.completed && typeof stored.completed === "object"
      ? /** @type {Record<string, unknown>} */ (stored.completed)
      : {};
  return HUMAN_GATE_DEFINITIONS.map((gate) => {
    const already =
      typeof gate.isAlreadySatisfied === "function" ? gate.isAlreadySatisfied(state) : false;
    const done = already || completed[gate.id] != null;
    return {
      id: gate.id,
      title: gate.title,
      complete: done,
      autoSatisfied: already && completed[gate.id] == null,
    };
  });
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} initialState
 */
export async function runHumanGatesStep(ctx, initialState) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = initialState.installationId;
  let state = await loadState(installationId, ctx.env);
  let deployment = {};
  try {
    deployment = await loadDeploymentEnv(installationId, ctx.env);
  } catch {
    deployment = {};
  }

  // Persist auto-satisfied gates as nonsecret evidence without pretending console work.
  state = await ensureAutoSatisfiedGates(ctx, state);

  const progress = listHumanGateProgress(state);
  const next = progress.find((gate) => !gate.complete);
  if (!next) {
    const completedIds = progress.map((gate) => gate.id);
    return {
      verified: true,
      gates: completedIds,
      note: "All named human/external gates have nonsecret evidence.",
    };
  }

  const definition = HUMAN_GATE_DEFINITIONS.find((gate) => gate.id === next.id);
  if (!definition) {
    throw new Error(`Unknown human gate ${next.id}.`);
  }

  const requiredValues = definition.requiredValues(state);
  const prompt =
    definition.id === "r2_bucket"
      ? definition.buildPrompt(state, deployment)
      : definition.buildPrompt(state);
  const phrase = definition.confirmationPhrase(state);

  log(`Human/external gate (one next action): ${definition.title}`);
  log(prompt);
  log("Required nonsecret values:");
  for (const [key, value] of Object.entries(requiredValues)) {
    log(`  ${key}=${value}`);
  }
  log(
    "The coordinator will not open provider consoles or mark this complete without your evidence phrase.",
  );
  log(`Type exactly: ${phrase}`);
  const answer = (await ctx.io.prompt("Evidence confirmation: ")).trim();
  if (answer !== phrase) {
    throw new Error(`Evidence rejected for gate "${definition.id}". Type exactly: ${phrase}`);
  }

  const now = new Date().toISOString();
  const previous = state.plans?.[DEPLOY_PLAN_KEY];
  const completed =
    previous &&
    typeof previous === "object" &&
    previous.completed &&
    typeof previous.completed === "object"
      ? { .../** @type {Record<string, unknown>} */ (previous.completed) }
      : {};
  completed[definition.id] = sanitizePlanMetadata({
    completedAt: now,
    phrase,
    requiredValues,
  });

  /** @type {SetupState} */
  const nextState = {
    ...state,
    updatedAt: now,
    plans: {
      ...state.plans,
      [DEPLOY_PLAN_KEY]: sanitizePlanMetadata({
        completed,
        updatedAt: now,
      }),
    },
  };
  await writeState(nextState, ctx.env);
  state = nextState;

  const remaining = listHumanGateProgress(state).filter((gate) => !gate.complete);
  if (remaining.length === 0) {
    return {
      verified: true,
      gates: listHumanGateProgress(state).map((gate) => gate.id),
      lastGate: definition.id,
    };
  }

  log(
    `Recorded evidence for "${definition.id}". ${remaining.length} human/external gate(s) remain. Rerun continue for the next action.`,
  );
  return {
    verified: false,
    progress: true,
    completedGate: definition.id,
    remaining: remaining.map((gate) => gate.id),
  };
}

/**
 * @param {SetupContext} ctx
 * @param {SetupState} state
 */
async function ensureAutoSatisfiedGates(ctx, state) {
  const now = new Date().toISOString();
  const previous = state.plans?.[DEPLOY_PLAN_KEY];
  const completed =
    previous &&
    typeof previous === "object" &&
    previous.completed &&
    typeof previous.completed === "object"
      ? { .../** @type {Record<string, unknown>} */ (previous.completed) }
      : {};
  let changed = false;
  for (const gate of HUMAN_GATE_DEFINITIONS) {
    if (completed[gate.id] != null) continue;
    if (typeof gate.isAlreadySatisfied === "function" && gate.isAlreadySatisfied(state)) {
      completed[gate.id] = sanitizePlanMetadata({
        completedAt: now,
        autoSatisfied: true,
        requiredValues: gate.requiredValues(state),
        note: "Satisfied from existing nonsecret AWS production-access evidence.",
      });
      changed = true;
    }
  }
  if (!changed) return state;
  /** @type {SetupState} */
  const next = {
    ...state,
    updatedAt: now,
    plans: {
      ...state.plans,
      [DEPLOY_PLAN_KEY]: sanitizePlanMetadata({
        completed,
        updatedAt: now,
      }),
    },
  };
  await writeState(next, ctx.env);
  return next;
}

/**
 * Stage handler: one human gate action per continue, or full verified evidence when done.
 * @type {import('./main.mjs').StageHandler}
 */
export const humanGatesStageHandler = {
  async isEligible(ctx, state) {
    void ctx;
    return state.stages.aws_core?.status === "complete";
  },
  async run(ctx, state) {
    return runHumanGatesStep(ctx, state);
  },
};

/**
 * Deploy stage: checkpoint only after live health evidence matches the applied plan.
 * @type {import('./main.mjs').StageHandler}
 */
export const deployStageHandler = {
  async isEligible(ctx, state) {
    void ctx;
    return state.stages.human_gates?.status === "complete";
  },
  async run(ctx, state) {
    return runDeployStageVerification(ctx, state);
  },
};

/**
 * @param {SetupContext} ctx
 * @param {SetupState} initialState
 */
export async function runDeployStageVerification(ctx, initialState) {
  const log = ctx.io.log ?? (() => undefined);
  const installationId = initialState.installationId;
  const state = await loadState(installationId, ctx.env);
  const plan = state.plans?.[DEPLOY_PLAN_STORE_KEY];
  const deploy = state.deploy;
  if (plan == null || typeof plan !== "object") {
    throw new Error(
      "Deploy stage is blocked: no deploy plan/apply evidence. Run `pnpm nusend:setup deploy plan` then `deploy apply`.",
    );
  }
  if (plan.applyCheckpoint !== APPLY_CHECKPOINT_HEALTHY || plan.consumed !== true) {
    throw new Error(
      "Deploy stage is blocked: deploy plan has no completed healthy apply checkpoint.",
    );
  }
  if (deploy == null || typeof deploy !== "object" || Array.isArray(deploy)) {
    throw new Error("Deploy stage is blocked: complete state.deploy evidence is missing.");
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
  ];
  for (const field of requiredDeployFields) {
    if (typeof deploy[field] !== "string" || !deploy[field]) {
      throw new Error(`Deploy stage is blocked: state.deploy.${field} is missing.`);
    }
  }
  const planFingerprint = String(plan.fingerprint ?? "");
  if (!planFingerprint || fingerprintDeployPlan(plan) !== planFingerprint) {
    throw new Error("Deploy stage is blocked: healthy plan fingerprint is invalid.");
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
  ]) {
    if (deploy[field] !== plan[field]) {
      throw new Error(
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
      throw new Error(
        `Deploy stage is blocked: state.deploy.${field} does not match installation config.`,
      );
    }
  }

  // After proving the two durable records agree, use only the complete apply record below.
  const commitSha = String(deploy.commitSha);
  const releaseTag = String(deploy.releaseTag);
  const domain = String(deploy.domain);
  const remotePath = String(deploy.remotePath);
  const appImage = String(deploy.appImage);
  const backupImage = String(deploy.backupImage);

  // Live tag must still match — do not adopt moved tags silently.
  const liveSha = await resolveReleaseCommitSha(ctx, state, releaseTag);
  if (liveSha !== commitSha) {
    throw new Error(
      `Deploy stage is blocked: release tag ${releaseTag} moved to ${liveSha} (planned ${commitSha}).`,
    );
  }

  await inspectExistingCheckout(ctx, state, remotePath, releaseTag, commitSha);
  await assertRemoteImageRevision(ctx, state, appImage, commitSha);
  await assertRemoteImageRevision(ctx, state, backupImage, commitSha);

  let secrets = [];
  try {
    secrets = secretValuesFromEnv(await loadDeploymentEnv(installationId, ctx.env));
  } catch {
    secrets = [];
  }

  log("Re-validating live deploy health before checkpoint.");
  const health = await validateDeployHealth(ctx, state, { domain, remotePath, secrets });

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
}
