import { Effect } from "effect";

import {
  OCI_REVISION_LABEL,
  PUBLIC_REPO_URL,
  REQUIRED_COMPOSE_MAJOR,
  REQUIRED_COMPOSE_MINOR,
  REQUIRED_SERVICES,
  SUPPORTED_ARCHITECTURES,
} from "./constants.ts";
import { assertReleaseTag } from "../state/schema.ts";
import {
  assertFullCommitSha,
  assertSafeRemotePath,
  buildRemoteImageInspectCommand,
  deriveHealthFromStatus,
  isComposeVersionSupported,
  isPublicRepoOrigin,
  isSupportedArchitecture,
  normalizeArchitecture,
  parseComposePsJson,
  parseComposeVersion,
  posixSingleQuote,
} from "./pure.ts";
import {
  failCommand,
  runCaptured,
  runSsh,
  trySyncCommand,
  type DeployProcessError,
  type DeployProcessServices,
} from "./ssh.ts";
import type { SetupState } from "../state/schema.ts";

export type PathInspectResult = {
  readonly mode: "absent" | "empty" | "existing_git" | "error";
  readonly detail: string;
  readonly code: string;
};

export type CheckoutInspectResult = {
  readonly origin: string;
  readonly head: string;
  readonly branch: string | null;
  readonly tagSha: string;
  readonly clean: true;
};

export type RuntimeInspectResult = {
  readonly kernel: "linux";
  readonly architecture: string;
  readonly architectureRaw: string;
  readonly dockerVersion: string;
  readonly composeVersion: string;
  readonly ports: {
    readonly toolOutputPresent: boolean;
    readonly listening80: boolean;
    readonly listening443: boolean;
    readonly note: string;
  };
};

export function resolveReleaseCommitSha(
  releaseTag: string,
): Effect.Effect<string, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    const tag = yield* trySyncCommand(() => assertReleaseTag(releaseTag));
    const result = yield* runCaptured({
      command: "git",
      args: ["ls-remote", "--tags", "--refs", PUBLIC_REPO_URL, `refs/tags/${tag}`],
    });
    const lines = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return yield* failCommand(`Release tag ${tag} was not found on ${PUBLIC_REPO_URL}.`);
    }
    if (lines.length !== 1) {
      return yield* failCommand(
        `Release tag ${tag} resolved to ${lines.length} refs; expected exactly one immutable tag.`,
      );
    }
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+)$/u.exec(lines[0] ?? "");
    if (!match) {
      return yield* failCommand(`Could not parse git ls-remote output for ${tag}: ${lines[0]}`);
    }
    if (match[2] !== tag) {
      return yield* failCommand(
        `git ls-remote returned unexpected tag ${match[2]} (wanted ${tag}).`,
      );
    }
    return yield* trySyncCommand(() => assertFullCommitSha(match[1] ?? ""));
  });
}

export function inspectRemotePath(
  state: SetupState,
  remotePath: string,
): Effect.Effect<PathInspectResult, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    const path = yield* trySyncCommand(() => assertSafeRemotePath(remotePath));
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
    const result = yield* runSsh(state, script);
    const code = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
    let mode: PathInspectResult["mode"] = "error";
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
  });
}

export function inspectExistingCheckout(
  state: SetupState,
  remotePath: string,
  releaseTag: string,
  commitSha: string,
): Effect.Effect<CheckoutInspectResult, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    const path = yield* trySyncCommand(() => assertSafeRemotePath(remotePath));
    const tag = yield* trySyncCommand(() => assertReleaseTag(releaseTag));
    const expected = yield* trySyncCommand(() => assertFullCommitSha(commitSha));
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
    const result = yield* runSsh(state, script);
    const fields: Record<string, string> = {};
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
      return yield* failCommand(
        `Existing checkout origin "${origin}" is not the public Nusend repository. Refusing to adopt or update it.`,
      );
    }
    if (porcelain.trim() !== "") {
      return yield* failCommand(
        "Existing checkout has a dirty worktree. Commit/clean it manually; deploy will not reset or discard changes.",
      );
    }
    if (head !== expected) {
      return yield* failCommand(
        `Existing checkout HEAD ${head || "unknown"} does not match planned commit ${expected}. Deploy will not fetch/reset.`,
      );
    }
    if (branch) {
      return yield* failCommand(
        `Existing checkout is on branch "${branch}". Deploy requires a clean detached HEAD or exact tag at ${expected}.`,
      );
    }
    if (!tagSha) {
      return yield* failCommand(
        `Existing checkout is missing local release tag ${tag}. Deploy requires the exact tag to resolve to planned commit ${expected}.`,
      );
    }
    if (tagSha !== expected) {
      return yield* failCommand(
        `Local tag ${tag} points at ${tagSha}, not planned commit ${expected}. Refusing moved/mismatched tag.`,
      );
    }
    return {
      origin,
      head,
      branch: branch || null,
      tagSha,
      clean: true as const,
    };
  });
}

export function inspectRemoteRuntime(
  state: SetupState,
): Effect.Effect<RuntimeInspectResult, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    const uname = yield* runSsh(state, "uname -s; uname -m");
    const lines = uname.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const kernel = lines[0] ?? "";
    const archRaw = lines[1] ?? "";
    if (!/^linux$/iu.test(kernel)) {
      return yield* failCommand(`Remote kernel must be Linux (got "${kernel}").`);
    }
    if (!isSupportedArchitecture(archRaw)) {
      return yield* failCommand(
        `Remote architecture "${archRaw}" is unsupported. Require one of: ${SUPPORTED_ARCHITECTURES.join(", ")}.`,
      );
    }

    const docker = yield* runSsh(state, "docker version --format '{{.Server.Version}}'");
    const dockerVersion = docker.stdout.trim();
    if (!dockerVersion) {
      return yield* failCommand("Could not read remote Docker server version.");
    }

    const compose = yield* runSsh(state, "docker compose version");
    const composeText = `${compose.stdout}\n${compose.stderr}`;
    const composeVersion = parseComposeVersion(composeText);
    if (!composeVersion) {
      return yield* failCommand(
        `Could not parse remote Docker Compose version from: ${composeText.trim()}`,
      );
    }
    if (!isComposeVersionSupported(composeVersion)) {
      return yield* failCommand(
        `Docker Compose ${composeVersion.raw} is too old; require ${REQUIRED_COMPOSE_MAJOR}.${REQUIRED_COMPOSE_MINOR}+.`,
      );
    }

    const ports = yield* runSsh(
      state,
      "if command -v ss >/dev/null 2>&1; then ss -lnt 2>/dev/null || true; elif command -v netstat >/dev/null 2>&1; then netstat -lnt 2>/dev/null || true; else echo 'NO_PORT_TOOL'; fi",
      { allowNonZero: true },
    );
    const portText = ports.stdout;
    return {
      kernel: "linux" as const,
      architecture: normalizeArchitecture(archRaw),
      architectureRaw: archRaw,
      dockerVersion,
      composeVersion: composeVersion.raw,
      ports: {
        toolOutputPresent: portText.trim() !== "" && !portText.includes("NO_PORT_TOOL"),
        listening80: /:80\b/u.test(portText),
        listening443: /:443\b/u.test(portText),
        note: "informational only; deploy does not open firewall ports",
      },
    };
  });
}

export function assertRemoteImageRevision(
  state: SetupState,
  imageRef: string,
  commitSha: string,
): Effect.Effect<string, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    const expected = yield* trySyncCommand(() => assertFullCommitSha(commitSha));
    const result = yield* runSsh(state, buildRemoteImageInspectCommand(imageRef));
    const revision = result.stdout.trim();
    if (revision !== expected) {
      return yield* failCommand(
        `Image ${imageRef} OCI label ${OCI_REVISION_LABEL}="${revision || "<missing>"}" does not equal planned commit ${expected}. Refusing moved registry tag.`,
      );
    }
    return revision;
  });
}

export type DeployHealthResult = {
  readonly services: Record<string, { state: string; health: string }>;
  readonly publicHealth: string;
  readonly publicHealthDb: string;
  readonly apiHealthDb: string;
  readonly backupMandatory: true;
};

export function validateDeployHealth(
  state: SetupState,
  options: {
    readonly domain: string;
    readonly remotePath: string;
    readonly secrets?: readonly string[];
  },
): Effect.Effect<DeployHealthResult, DeployProcessError, DeployProcessServices> {
  return Effect.gen(function* () {
    const remotePath = yield* trySyncCommand(() => assertSafeRemotePath(options.remotePath));
    const domain = options.domain;
    const secrets = options.secrets ?? [];

    const ps = yield* runSsh(
      state,
      `cd ${posixSingleQuote(remotePath)} && docker compose ps --format json`,
      { redact: secrets },
    );
    const services = parseComposePsJson(ps.stdout);
    const serviceHealth: Record<string, { state: string; health: string }> = {};
    const needsInspect: string[] = [];
    const healthcheckedServices = new Set(["api", "backup"]);
    for (const name of REQUIRED_SERVICES) {
      const entry = services.find((item) => item.service === name || item.name === name);
      if (!entry) {
        return yield* failCommand(`Compose service "${name}" is missing from docker compose ps.`);
      }
      const running = /running/iu.test(entry.state) || /running/iu.test(entry.status);
      const health = entry.health || deriveHealthFromStatus(entry.status);
      if (!running) {
        return yield* failCommand(
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
        return yield* failCommand(
          `Compose service "${name}" health is "${health}", expected healthy.`,
        );
      }
      needsInspect.push(name);
      serviceHealth[name] = { state: entry.state || entry.status, health: "pending-inspect" };
    }
    if (needsInspect.length > 0) {
      for (const name of needsInspect) {
        const result = yield* runSsh(
          state,
          `cd ${posixSingleQuote(remotePath)} && docker compose ps -q ${posixSingleQuote(name)} | while read id; do docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"; done`,
          { redact: secrets },
        );
        const value = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "";
        if (value !== "healthy") {
          return yield* failCommand(
            `Compose service "${name}" must be healthy (got "${value || "unknown"}").`,
          );
        }
        serviceHealth[name] = {
          state: serviceHealth[name]?.state ?? "running",
          health: value,
        };
      }
    }

    const publicHealth = yield* runCaptured({
      command: "curl",
      args: ["-fsS", "-o", "/dev/null", "-w", "%{http_code}", `https://${domain}/health`],
      redact: secrets,
    });
    const publicHealthCode = publicHealth.stdout.trim();
    if (publicHealthCode !== "200") {
      return yield* failCommand(`Public /health returned HTTP ${publicHealthCode}, expected 200.`);
    }

    const publicDb = yield* runCaptured({
      command: "curl",
      args: ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `https://${domain}/health/db`],
      redact: secrets,
      allowNonZero: true,
    });
    const publicDbCode = publicDb.stdout.trim();
    if (publicDbCode !== "404") {
      return yield* failCommand(`Public /health/db returned HTTP ${publicDbCode}, expected 404.`);
    }

    yield* runSsh(
      state,
      `cd ${posixSingleQuote(remotePath)} && docker compose exec -T api bun -e ${posixSingleQuote("const r=await fetch('http://127.0.0.1:3000/health/db');if(!r.ok)process.exit(1)")}`,
      { redact: secrets },
    );

    return {
      services: serviceHealth,
      publicHealth: publicHealthCode,
      publicHealthDb: publicDbCode,
      apiHealthDb: "ok",
      backupMandatory: true as const,
    };
  });
}
