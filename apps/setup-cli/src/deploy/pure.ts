import { createHash } from "node:crypto";

import { assertAbsolutePosixPath, assertReleaseTag } from "../state/schema.ts";
import type { SetupState } from "../state/schema.ts";
import {
  APP_IMAGE_REPOSITORY,
  BACKUP_IMAGE_REPOSITORY,
  DEPLOY_PHRASE_PREFIX,
  OCI_REVISION_LABEL,
  PUBLIC_REPO_ORIGINS,
  PUBLIC_REPO_URL,
  REQUIRED_COMPOSE_MAJOR,
  REQUIRED_COMPOSE_MINOR,
  SUPPORTED_ARCHITECTURES,
} from "./constants.ts";

export function posixSingleQuote(value: string): string {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

export function buildOpenSshRemoteCommand(remoteCommand: string): string {
  return `sh -c ${posixSingleQuote(remoteCommand)}`;
}

export function buildOpenSshArgs(target: string, remoteCommand: string): string[] {
  return [assertSshTarget(target), buildOpenSshRemoteCommand(remoteCommand)];
}

export function assertSshTarget(target: string): string {
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

export function assertSafeRemotePath(path: string): string {
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

export function assertFullCommitSha(sha: string): string {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`Expected a 40-hex commit SHA (got "${sha}").`);
  }
  return sha;
}

export function abbreviateSha(sha: string): string {
  return assertFullCommitSha(sha).slice(0, 7);
}

export function normalizeGitOrigin(origin: string): string {
  return String(origin ?? "")
    .trim()
    .replace(/\/+$/u, "")
    .toLowerCase();
}

export function isPublicRepoOrigin(origin: string): boolean {
  const normalized = normalizeGitOrigin(origin);
  return PUBLIC_REPO_ORIGINS.some((allowed) => normalizeGitOrigin(allowed) === normalized);
}

export function parseComposeVersion(text: string): {
  major: number;
  minor: number;
  patch: number;
  raw: string;
} | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(text ?? ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export function isComposeVersionSupported(version: {
  major: number;
  minor: number;
  patch: number;
}): boolean {
  if (version.major > REQUIRED_COMPOSE_MAJOR) return true;
  if (version.major < REQUIRED_COMPOSE_MAJOR) return false;
  return version.minor >= REQUIRED_COMPOSE_MINOR;
}

export function isSupportedArchitecture(arch: string): boolean {
  const normalized = String(arch ?? "")
    .trim()
    .toLowerCase();
  return (SUPPORTED_ARCHITECTURES as readonly string[]).includes(normalized);
}

export function normalizeArchitecture(arch: string): string {
  const value = String(arch ?? "")
    .trim()
    .toLowerCase();
  if (value === "x86_64" || value === "amd64") return "amd64";
  if (value === "aarch64" || value === "arm64") return "arm64";
  return value;
}

export function buildAppImageRef(tag: string): string {
  return `${APP_IMAGE_REPOSITORY}:${assertReleaseTag(tag)}`;
}

export function buildBackupImageRef(tag: string): string {
  return `${BACKUP_IMAGE_REPOSITORY}:${assertReleaseTag(tag)}`;
}

export function buildDeployConfirmationPhrase(input: {
  sshTarget: string;
  domain: string;
  remotePath: string;
  releaseTag: string;
  commitSha: string;
}): string {
  const sha = abbreviateSha(input.commitSha);
  return `${DEPLOY_PHRASE_PREFIX} ${assertSshTarget(input.sshTarget)} ${input.domain} ${assertSafeRemotePath(input.remotePath)} ${assertReleaseTag(input.releaseTag)} ${sha}`;
}

export function validateDeployConfirmation(
  answer: string,
  expected: {
    sshTarget: string;
    domain: string;
    remotePath: string;
    releaseTag: string;
    commitSha: string;
  },
): string {
  const phrase = buildDeployConfirmationPhrase(expected);
  if (String(answer ?? "").trim() !== phrase) {
    throw new Error(`Confirmation rejected. Type exactly: ${phrase}`);
  }
  return phrase;
}

export function extractComposeImageTags(
  composeBody: string,
  releaseTag: string,
): {
  appTag: string | null;
  backupTag: string | null;
  appImage: string | null;
  backupImage: string | null;
  matchesRelease: boolean;
} {
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

export function buildComposeConfigDummyAssignments(state: SetupState): Record<string, string> {
  const values: Record<string, string> = {
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

export function buildDummyEnvAssignments(dummyEnv: Record<string, string>): string {
  return Object.entries(dummyEnv)
    .map(([key, value]) => `${key}=${posixSingleQuote(value)}`)
    .join(" ");
}

export function buildRemoteComposeConfigCommand(
  remotePath: string,
  dummyEnv: Record<string, string>,
): string {
  const assignments = buildDummyEnvAssignments(dummyEnv);
  return `cd ${posixSingleQuote(remotePath)} && env ${assignments} docker compose config --quiet`;
}

export function buildRemoteComposeConfigFromStdinCommand(dummyEnv: Record<string, string>): string {
  const assignments = buildDummyEnvAssignments(dummyEnv);
  return `env ${assignments} docker compose -f - config --quiet`;
}

export function buildRemoteEnvTransferScript(remoteEnvPath: string): string {
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

export function buildRemoteImageInspectCommand(imageRef: string): string {
  const format = `{{ index .Config.Labels "${OCI_REVISION_LABEL}" }}`;
  return `docker image inspect --format=${posixSingleQuote(format)} ${posixSingleQuote(imageRef)}`;
}

export function buildRemoteCloneScript(
  remotePath: string,
  releaseTag: string,
  commitSha: string,
): string {
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

export function fingerprintDeployPlan(planBody: Record<string, unknown>): string {
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

export function assertArgvFreeOfSecrets(argv: readonly string[], secrets: readonly string[]): void {
  const joined = argv.join("\0");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4 && joined.includes(secret)) {
      throw new Error("Refusing to continue: a secret value appeared in process argv.");
    }
  }
}

export type ComposePsEntry = {
  service: string;
  name: string;
  state: string;
  status: string;
  health: string;
};

export function parseComposePsJson(stdout: string): ComposePsEntry[] {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  try {
    if (text.startsWith("[")) {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(normalizePsEntry);
      }
    }
  } catch {
    // fall through to NDJSON
  }
  const out: ComposePsEntry[] = [];
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

function normalizePsEntry(entry: Record<string, unknown>): ComposePsEntry {
  const service = String(entry.Service ?? entry.service ?? entry.Name ?? entry.name ?? "");
  const name = String(entry.Name ?? entry.name ?? service);
  const state = String(entry.State ?? entry.state ?? "");
  const status = String(entry.Status ?? entry.status ?? "");
  const health = String(entry.Health ?? entry.health ?? deriveHealthFromStatus(status) ?? "");
  return { service, name, state, status, health };
}

export function deriveHealthFromStatus(status: string): string {
  const match = /\((healthy|unhealthy|starting|none)\)/iu.exec(String(status ?? ""));
  return match?.[1]?.toLowerCase() ?? "";
}
