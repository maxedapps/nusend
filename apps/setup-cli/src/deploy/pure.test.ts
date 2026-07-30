import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessRunnerLive } from "../process-runner.ts";
import {
  APP_IMAGE_REPOSITORY,
  APPLY_CHECKPOINT_CLONED,
  APPLY_CHECKPOINT_CONFIG,
  APPLY_CHECKPOINT_ENV,
  APPLY_CHECKPOINT_HEALTHY,
  APPLY_CHECKPOINT_IMAGES,
  APPLY_CHECKPOINT_PULLED,
  APPLY_CHECKPOINT_UP,
  BACKUP_IMAGE_REPOSITORY,
  DEPLOY_PHRASE_PREFIX,
  LOCAL_COMPOSE_PATH,
  OCI_REVISION_LABEL,
  PUBLIC_REPO_URL,
} from "./constants.ts";
import { HUMAN_GATE_DEFINITIONS, listHumanGateProgress } from "./human-gates.ts";
import {
  abbreviateSha,
  assertNoHostKeyBypass,
  assertSafeRemotePath,
  assertSshTarget,
  buildAppImageRef,
  buildBackupImageRef,
  buildComposeConfigDummyAssignments,
  buildDeployConfirmationPhrase,
  buildOpenSshArgs,
  buildOpenSshRemoteCommand,
  buildRemoteCloneScript,
  buildRemoteComposeConfigCommand,
  buildRemoteComposeConfigFromStdinCommand,
  buildRemoteEnvTransferScript,
  buildRemoteImageInspectCommand,
  extractComposeImageTags,
  fingerprintDeployPlan,
  isComposeVersionSupported,
  isPublicRepoOrigin,
  parseComposePsJson,
  parseComposeVersion,
  posixSingleQuote,
  validateDeployConfirmation,
} from "./pure.ts";
import { runCaptured } from "./ssh.ts";

const temporaryDirectories: string[] = [];
const PLANNED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function sampleState(installationId: string) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1 as const,
    installationId,
    createdAt: now,
    updatedAt: now,
    config: {
      releaseTag: "v0.1.1",
      domain: "mail.example.com",
      ingressMode: "direct" as const,
      ownerEmail: "owner@example.com",
      ownerName: "Owner",
      awsProfile: "nusend-provisioner",
      awsRegion: "us-east-1",
      awsAccountId: "123456789012",
      sesIdentity: "example.com",
      sesFromEmail: "sender@example.com",
      marketingEnabled: false,
      trackingEnabled: false,
      alertEmail: "alerts@example.com",
      route53HostedZoneId: null,
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      installationName: installationId,
    },
    stages: {
      init: {
        status: "complete" as const,
        completedAt: now,
        evidence: { verified: true, installationId },
      },
    },
    plans: {},
  };
}

describe("deploy pure helpers", () => {
  it("quotes POSIX single-quoted remote fragments safely", () => {
    expect(posixSingleQuote("simple")).toBe("'simple'");
    expect(posixSingleQuote("a'b")).toBe(`'a'\\''b'`);
    expect(posixSingleQuote("")).toBe("''");
  });

  it("rejects unsafe SSH targets and remote paths", () => {
    expect(assertSshTarget("root@203.0.113.10")).toBe("root@203.0.113.10");
    expect(assertSshTarget("deploy.example.com")).toBe("deploy.example.com");
    expect(() => assertSshTarget("root@host;rm -rf /")).toThrow(/unsafe|invalid/i);
    expect(() => assertSshTarget("root@host || true")).toThrow(/unsafe|invalid/i);
    expect(() => assertSshTarget("user@host/../../etc")).toThrow(/conservative|invalid|unsafe/i);
    expect(assertSafeRemotePath("/srv/nusend")).toBe("/srv/nusend");
    expect(() => assertSafeRemotePath("/")).toThrow(/root/);
    expect(() => assertSafeRemotePath("/tmp/../etc")).toThrow(/relative/);
    expect(() => assertSafeRemotePath("/srv/nusend;id")).toThrow(/unsupported|relative|absolute/i);
  });

  it("builds exact deploy confirmation phrases", () => {
    const expected = {
      sshTarget: "root@203.0.113.10",
      domain: "mail.example.com",
      remotePath: "/srv/nusend",
      releaseTag: "v0.1.1",
      commitSha: PLANNED_SHA,
    };
    const phrase = buildDeployConfirmationPhrase(expected);
    expect(phrase).toBe(
      `DEPLOY root@203.0.113.10 mail.example.com /srv/nusend v0.1.1 ${abbreviateSha(PLANNED_SHA)}`,
    );
    expect(phrase.startsWith(DEPLOY_PHRASE_PREFIX)).toBe(true);
    expect(() => validateDeployConfirmation(phrase, expected)).not.toThrow();
    expect(() => validateDeployConfirmation("DEPLOY wrong", expected)).toThrow(
      /Confirmation rejected/,
    );
  });

  it("parses compose versions and supports 5.3+", () => {
    expect(parseComposeVersion("Docker Compose version v5.3.0")).toEqual({
      major: 5,
      minor: 3,
      patch: 0,
      raw: "5.3.0",
    });
    expect(isComposeVersionSupported({ major: 5, minor: 3, patch: 0 })).toBe(true);
    expect(isComposeVersionSupported({ major: 5, minor: 2, patch: 9 })).toBe(false);
    expect(isComposeVersionSupported({ major: 2, minor: 29, patch: 0 })).toBe(false);
  });

  it("recognizes public repo origins and image refs", () => {
    expect(isPublicRepoOrigin("https://github.com/maxedapps/nusend.git")).toBe(true);
    expect(isPublicRepoOrigin("https://github.com/maxedapps/nusend")).toBe(true);
    expect(isPublicRepoOrigin("https://github.com/other/nusend.git")).toBe(false);
    expect(buildAppImageRef("v0.1.1")).toBe(`${APP_IMAGE_REPOSITORY}:v0.1.1`);
    expect(buildBackupImageRef("v0.1.1")).toBe(`${BACKUP_IMAGE_REPOSITORY}:v0.1.1`);
  });

  it("builds OpenSSH argv as one safely quoted remote command after target", () => {
    const script = "cd '/srv/nusend' && docker compose up -d --wait";
    const remote = buildOpenSshRemoteCommand(script);
    expect(remote).toBe(`sh -c ${posixSingleQuote(script)}`);
    expect(remote.startsWith("sh -c '")).toBe(true);

    const args = buildOpenSshArgs("root@203.0.113.10", script);
    expect(args).toEqual(["root@203.0.113.10", remote]);
    expect(args).toHaveLength(2);

    const joined = args.slice(1).join(" ");
    expect(joined).toBe(remote);
    expect(joined).toContain("docker compose up -d --wait");

    const brokenJoin = ["sh", "-c", script].join(" ");
    expect(brokenJoin).toBe("sh -c cd '/srv/nusend' && docker compose up -d --wait");
    expect(brokenJoin).not.toBe(remote);
  });

  it("builds remote env transfer and clone scripts without embedding secrets", () => {
    const transfer = buildRemoteEnvTransferScript("/srv/nusend/.env");
    expect(transfer).toMatch(/umask 077/);
    expect(transfer).toMatch(/chmod 600/);
    expect(transfer).toMatch(/mv -f/);
    expect(transfer).toMatch(/mktemp/);
    expect(transfer).toContain(".env.tmp.XXXXXX");
    expect(transfer).not.toMatch(/\$RANDOM/);
    expect(transfer).not.toMatch(/scp|rsync/i);
    expect(transfer).not.toContain("super-secret-value");

    const clone = buildRemoteCloneScript("/srv/nusend", "v0.1.1", PLANNED_SHA);
    expect(clone).toContain(PUBLIC_REPO_URL);
    expect(clone).toContain("git clone");
    expect(clone).toContain(PLANNED_SHA);
    expect(clone).not.toMatch(/\brm -rf\b/);
  });

  it("runs env transfer script under dash with mktemp, stdin, and mode 0600", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nusend-env-xfer-"));
    temporaryDirectories.push(directory);
    const dest = join(directory, ".env");
    const script = buildRemoteEnvTransferScript(dest);
    const body = "NUSEND_DOMAIN=mail.example.com\nPLACEHOLDER=not-a-real-secret\n";
    const result = await Effect.runPromise(
      runCaptured({
        command: "dash",
        args: ["-c", script],
        stdin: body,
      }).pipe(Effect.provide(ProcessRunnerLive)),
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(dest, "utf8")).toBe(body);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(result.stdout).not.toMatch(/secret|password|token/i);
    expect(result.stderr).not.toMatch(/secret|password|token/i);
  });

  it("quotes the entire Docker Go --format template as one shell word", () => {
    const cmd = buildRemoteImageInspectCommand(`${APP_IMAGE_REPOSITORY}:v0.1.1`);
    const format = `{{ index .Config.Labels "${OCI_REVISION_LABEL}" }}`;
    const formatWord = `--format=${posixSingleQuote(format)}`;
    expect(cmd.startsWith(`docker image inspect ${formatWord} `)).toBe(true);
    expect(cmd).toContain(formatWord);
    expect(formatWord.startsWith("--format='")).toBe(true);
    expect(formatWord.endsWith("'")).toBe(true);
    expect(formatWord.includes(" index ")).toBe(true);
  });

  it("builds compose config dummy env without real secrets and rejects host-key bypass argv", () => {
    const state = sampleState("prod");
    const dummy = buildComposeConfigDummyAssignments(state);
    expect(dummy.BETTER_AUTH_SECRET).toMatch(/dummy/i);
    const cmd = buildRemoteComposeConfigCommand("/srv/nusend", dummy);
    expect(cmd).toContain("docker compose config --quiet");
    expect(cmd).toContain("cd '/srv/nusend'");
    const stdinCmd = buildRemoteComposeConfigFromStdinCommand(dummy);
    expect(stdinCmd).toContain("docker compose -f - config --quiet");
    expect(stdinCmd).not.toContain("cd ");
    expect(() =>
      assertNoHostKeyBypass(["ssh", "-o", "StrictHostKeyChecking=no", "host", "true"]),
    ).toThrow(/host-key/);
    expect(() =>
      assertNoHostKeyBypass(["ssh", "-o", "UserKnownHostsFile=/dev/null", "host", "true"]),
    ).toThrow(/host-key/);
    expect(() =>
      assertNoHostKeyBypass(["ssh", "root@host", buildOpenSshRemoteCommand("true")]),
    ).not.toThrow();
  });

  it("parses compose ps JSON/NDJSON", () => {
    const ndjson = [
      JSON.stringify({ Service: "api", State: "running", Health: "healthy" }),
      JSON.stringify({ Service: "worker", State: "running", Status: "Up" }),
      JSON.stringify({ Service: "caddy", State: "running", Health: "healthy" }),
      JSON.stringify({ Service: "backup", State: "running", Health: "healthy" }),
    ].join("\n");
    const parsed = parseComposePsJson(ndjson);
    expect(parsed.map((item) => item.service).sort()).toEqual(["api", "backup", "caddy", "worker"]);
  });

  it("fingerprints deploy plans stably", () => {
    const body = {
      commitSha: PLANNED_SHA,
      releaseTag: "v0.1.1",
      sshTarget: "root@203.0.113.10",
      remotePath: "/srv/nusend",
      domain: "mail.example.com",
      pathMode: "empty",
      architecture: "amd64",
      appImage: buildAppImageRef("v0.1.1"),
      backupImage: buildBackupImageRef("v0.1.1"),
      dockerVersion: "27.0.0",
      composeVersion: "5.3.2",
    };
    const a = fingerprintDeployPlan(body);
    const b = fingerprintDeployPlan(body);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDeployPlan({ ...body, commitSha: OTHER_SHA })).not.toBe(a);
  });

  it("extracts compose image tags from the local template", async () => {
    const body = await readFile(LOCAL_COMPOSE_PATH, "utf8");
    const tags = extractComposeImageTags(body, "v0.1.1");
    // Local compose may pin a different release; just ensure parsing works.
    expect(tags.appTag).toMatch(/^v/);
    expect(tags.backupTag).toMatch(/^v/);
  });
});

describe("checkpoint constants", () => {
  it("exposes ordered apply checkpoints", () => {
    expect([
      APPLY_CHECKPOINT_CLONED,
      APPLY_CHECKPOINT_ENV,
      APPLY_CHECKPOINT_CONFIG,
      APPLY_CHECKPOINT_PULLED,
      APPLY_CHECKPOINT_IMAGES,
      APPLY_CHECKPOINT_UP,
      APPLY_CHECKPOINT_HEALTHY,
    ]).toEqual([
      "cloned",
      "env_transferred",
      "compose_config",
      "pulled",
      "images_verified",
      "up",
      "healthy",
    ]);
  });
});

describe("human gate definitions", () => {
  it("covers the named external gates without secretish plan keys", () => {
    const ids = HUMAN_GATE_DEFINITIONS.map((g) => g.id);
    expect(ids).toEqual([
      "google_oauth",
      "dns_firewall",
      "r2_bucket",
      "restic_escrow",
      "alarm_email",
      "ses_approval",
    ]);
    const state = sampleState("prod");
    const progress = listHumanGateProgress(state);
    expect(progress.every((g) => !g.complete)).toBe(true);
    expect(HUMAN_GATE_DEFINITIONS[0]!.confirmationPhrase(state)).toBe(
      "GOOGLE-OAUTH mail.example.com",
    );
  });
});
