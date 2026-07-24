import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  APPLY_CHECKPOINT_CLONED,
  APPLY_CHECKPOINT_CONFIG,
  APPLY_CHECKPOINT_ENV,
  APPLY_CHECKPOINT_HEALTHY,
  APPLY_CHECKPOINT_IMAGES,
  APPLY_CHECKPOINT_PULLED,
  APPLY_CHECKPOINT_UP,
  APP_IMAGE_REPOSITORY,
  BACKUP_IMAGE_REPOSITORY,
  DEPLOY_PHRASE_PREFIX,
  DEPLOY_PLAN_KEY,
  DEPLOY_PLAN_STORE_KEY,
  HUMAN_GATE_DEFINITIONS,
  LOCAL_COMPOSE_PATH,
  OCI_REVISION_LABEL,
  PUBLIC_REPO_URL,
  abbreviateSha,
  assertArgvFreeOfSecrets,
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
  listHumanGateProgress,
  parseComposePsJson,
  parseComposeVersion,
  posixSingleQuote,
  runDeployApply,
  runDeployPlan,
  runDeployStageVerification,
  runHumanGatesStep,
  validateDeployConfirmation,
} from "./deploy.mjs";
import { runContinue, runSetup } from "./main.mjs";
import { runProcess } from "./process.mjs";
import {
  loadDeploymentEnv,
  loadState,
  secretValuesFromEnv,
  serializeEnvFile,
  writeCurrentPointer,
  writeDeploymentEnv,
  writeState,
} from "./state.mjs";

const temporaryDirectories: string[] = [];
const PLANNED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

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

    // Simulated OpenSSH join of remote argv (space-separated, no re-quote).
    const joined = args.slice(1).join(" ");
    expect(joined).toBe(remote);
    expect(joined).toContain("docker compose up -d --wait");

    // Multi-arg shape would break once OpenSSH joins without quotes.
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
    const result = await runProcess({
      command: "dash",
      args: ["-c", script],
      stdin: body,
    });
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
    // Spaces live only inside the single-quoted format word.
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
    expect(tags.appTag).toBe("v0.1.1");
    expect(tags.backupTag).toBe("v0.1.1");
    expect(tags.matchesRelease).toBe(true);
  });
});

describe("human gates", () => {
  it("defines named Google/DNS/R2/restic/alarm/SES gates with phrases", () => {
    const ids = HUMAN_GATE_DEFINITIONS.map((gate) => gate.id);
    expect(ids).toEqual([
      "google_oauth",
      "dns_firewall",
      "r2_bucket",
      "restic_escrow",
      "alarm_email",
      "ses_approval",
    ]);
    const state = sampleState("prod");
    const google = HUMAN_GATE_DEFINITIONS[0]!;
    expect(google.requiredValues(state)).toEqual({
      authorizedJavaScriptOrigin: "https://mail.example.com",
      authorizedRedirectUri: "https://mail.example.com/api/auth/callback/google",
    });
    expect(google.confirmationPhrase(state)).toBe("GOOGLE-OAUTH mail.example.com");
  });

  it("continue records one human-gate evidence action and does not complete the stage early", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true });
    const logs: string[] = [];
    const prompts: string[] = [];

    await runContinue({
      env,
      executor: async () => ok(""),
      io: testIo({
        log: (line) => logs.push(line),
        prompt: async (message) => {
          prompts.push(message);
          return "GOOGLE-OAUTH mail.example.com";
        },
      }),
    });

    const state = await loadState("prod", env);
    expect(state.stages.human_gates).toBeUndefined();
    expect(state.plans[DEPLOY_PLAN_KEY]?.completed).toMatchObject({
      google_oauth: expect.objectContaining({ phrase: "GOOGLE-OAUTH mail.example.com" }),
    });
    expect(logs.join("\n")).toMatch(/one next action|Recorded evidence|Rerun continue/i);
    expect(JSON.stringify(state)).not.toMatch(/google-client-secret|restic-password-value/i);
  });

  it("rejects mismatched human-gate evidence phrases", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true });
    await expect(
      runHumanGatesStep(
        {
          env,
          executor: async () => ok(""),
          io: testIo({ prompt: async () => "WRONG" }),
        } as any,
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/Evidence rejected|GOOGLE-OAUTH/);
  });

  it("auto-satisfies SES approval from nonsecret AWS evidence and finishes remaining gates", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", {
      awsCoreComplete: true,
      productionAccessEnabled: true,
    });

    // Complete every gate except SES (auto) via direct plan state, then one continue should finish.
    const state = await loadState("prod", env);
    const completed: Record<string, unknown> = {};
    for (const gate of HUMAN_GATE_DEFINITIONS) {
      if (gate.id === "ses_approval") continue;
      completed[gate.id] = {
        completedAt: "2026-01-02T00:00:00.000Z",
        phrase: gate.confirmationPhrase(state),
      };
    }
    await writeState(
      {
        ...state,
        plans: {
          ...state.plans,
          [DEPLOY_PLAN_KEY]: { completed, updatedAt: "2026-01-02T00:00:00.000Z" },
        },
      },
      env,
    );

    await runContinue({
      env,
      executor: async () => ok(""),
      io: testIo(),
    });

    const after = await loadState("prod", env);
    expect(after.stages.human_gates?.status).toBe("complete");
    expect(after.stages.human_gates?.evidence.verified).toBe(true);
    const progress = listHumanGateProgress(after);
    expect(progress.every((gate) => gate.complete)).toBe(true);
  });
});

describe("deploy plan", () => {
  it("requires completed aws_core and human_gates before planning", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: false, humanGatesComplete: false });
    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: async () => ok(""),
      } as any),
    ).rejects.toThrow(/aws_core/);

    await seedInstallation(env, "prod2", { awsCoreComplete: true, humanGatesComplete: false });
    await writeCurrentPointer("prod2", env);
    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: async () => ok(""),
      } as any),
    ).rejects.toThrow(/human_gates/);
  });

  it("is read-only and persists planned commit/image metadata without secrets", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const logs: string[] = [];

    await runDeployPlan({
      env,
      io: testIo({ log: (line) => logs.push(line) }),
      executor: planExecutor(calls, { pathMode: "absent" }),
    } as any);

    const state = await loadState("prod", env);
    const plan = state.plans[DEPLOY_PLAN_STORE_KEY] as Record<string, unknown>;
    expect(plan.commitSha).toBe(PLANNED_SHA);
    expect(plan.abbreviatedSha).toBe(abbreviateSha(PLANNED_SHA));
    expect(plan.pathMode).toBe("empty");
    expect(plan.appImage).toBe(buildAppImageRef("v0.1.1"));
    expect(plan.backupImage).toBe(buildBackupImageRef("v0.1.1"));
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.composeReadiness).toMatchObject({
      mode: "local_compose_stdin_remote_render",
      remoteConfigQuiet: true,
      localComposeImageMatch: true,
    });
    expect(JSON.stringify(plan)).not.toMatch(
      /google-client-secret|restic-password-value|SecretAccessKey/i,
    );
    expect(logs.join("\n")).toMatch(/read-only/i);
    expect(logs.join("\n")).toMatch(/Compose render/i);

    // No mutating remote verbs in plan.
    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => /\b(mkdir|clone|pull|up|rm|mv|chmod|cat >)\b/u.test(line))).toBe(
      false,
    );
    expect(
      flat.every((line) => !/StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/u.test(line)),
    ).toBe(true);
    // Empty-path plan pipes local compose.yaml over SSH stdin for read-only compose config.
    const stdinConfig = calls.find((call) =>
      opensshJoinedRemote(call.argv).includes("docker compose -f - config --quiet"),
    );
    expect(stdinConfig).toBeTruthy();
    expect(stdinConfig?.stdin ?? "").toContain("ghcr.io/maxedapps/nusend:v0.1.1");
    expect(stdinConfig?.stdin ?? "").not.toMatch(/google-client-secret|restic-password-value/i);
    // SSH target is one argv element; remote command is exactly one OpenSSH-joined word.
    for (const call of calls.filter((entry) => entry.argv[0] === "ssh")) {
      expect(call.argv[1]).toBe("root@203.0.113.10");
      expect(call.argv).toHaveLength(3);
      expect(call.argv[2]).toMatch(/^sh -c '/);
    }
  });

  it("rejects unsafe target/path and unsupported compose/arch", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });

    // unsafe target
    {
      const state = await loadState("prod", env);
      await writeState(
        {
          ...state,
          config: { ...state.config, sshTarget: "root@host;evil" },
        },
        env,
      );
      await expect(
        runDeployPlan({
          env,
          io: testIo(),
          executor: async () => ok(""),
        } as any),
      ).rejects.toThrow(/unsafe|invalid/i);
    }

    await seedInstallation(env, "prod2", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("prod2", env);
    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], {
          pathMode: "absent",
          composeVersionText: "Docker Compose version v5.2.0",
        }),
      } as any),
    ).rejects.toThrow(/Compose 5\.2\.0 is too old/);

    await seedInstallation(env, "prod3", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("prod3", env);
    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], { pathMode: "absent", arch: "ppc64le" }),
      } as any),
    ).rejects.toThrow(/architecture/i);
  });

  it("validates existing checkout origin/tag/SHA/dirty and empty path parent", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });

    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], {
          pathMode: "existing_git",
          origin: "https://github.com/other/nusend.git",
        }),
      } as any),
    ).rejects.toThrow(/origin/i);

    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], {
          pathMode: "existing_git",
          dirty: true,
        }),
      } as any),
    ).rejects.toThrow(/dirty/i);

    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], {
          pathMode: "existing_git",
          head: OTHER_SHA,
        }),
      } as any),
    ).rejects.toThrow(/HEAD/i);

    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], {
          pathMode: "existing_git",
          branch: "main",
        }),
      } as any),
    ).rejects.toThrow(/branch/i);

    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], { pathMode: "nonempty_not_git" }),
      } as any),
    ).rejects.toThrow(/not usable|non-git|partial/i);
  });

  it("does not mutate when planning an existing clean checkout and runs dummy compose config", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor(calls, { pathMode: "existing_git" }),
    } as any);
    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => line.includes("docker compose config --quiet"))).toBe(true);
    expect(flat.some((line) => /\bgit clone\b|\bpull\b|\bup\b/u.test(line))).toBe(false);
    const state = await loadState("prod", env);
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({ pathMode: "existing" });
  });

  it("rejects existing checkout missing the exact local release tag", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await expect(
      runDeployPlan({
        env,
        io: testIo(),
        executor: planExecutor([], {
          pathMode: "existing_git",
          tagSha: "",
        }),
      } as any),
    ).rejects.toThrow(/missing local release tag|exact tag/i);
  });
});

describe("deploy apply", () => {
  it("rejects missing/stale/fingerprint mismatch/moved git tag and confirmation mismatch", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });

    await expect(
      runDeployApply({
        env,
        io: testIo(),
        executor: async () => ok(""),
      } as any),
    ).rejects.toThrow(/No stored deploy plan/);

    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "absent" }),
    } as any);

    // confirmation mismatch
    await expect(
      runDeployApply({
        env,
        io: testIo({ prompt: async () => "DEPLOY wrong" }),
        executor: applyExecutor({}),
      } as any),
    ).rejects.toThrow(/Confirmation rejected/);

    // moved tag after plan
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({ lsRemoteSha: OTHER_SHA }),
      } as any),
    ).rejects.toThrow(/moved|now points/i);

    // fingerprint mismatch via config change after plan
    const state = await loadState("prod", env);
    await writeState(
      {
        ...state,
        config: { ...state.config, domain: "other.example.com" },
        plans: {
          ...state.plans,
          [DEPLOY_PLAN_STORE_KEY]: {
            ...(state.plans[DEPLOY_PLAN_STORE_KEY] as object),
            domain: "other.example.com",
          },
        },
      },
      env,
    );
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "other.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({}),
      } as any),
    ).rejects.toThrow(/fingerprint|does not match/i);
  });

  it("clones empty targets, validates existing, transfers env via stdin only, and refuses dirty/wrong origin", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const deployment = await (await import("./state.mjs")).loadDeploymentEnv("prod", env);
    const secrets = secretValuesFromEnv(deployment);

    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "absent" }),
    } as any);

    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    await runDeployApply({
      env,
      io: testIo({
        prompt: async () =>
          buildDeployConfirmationPhrase({
            sshTarget: "root@203.0.113.10",
            domain: "mail.example.com",
            remotePath: "/srv/nusend",
            releaseTag: "v0.1.1",
            commitSha: PLANNED_SHA,
          }),
      }),
      executor: applyExecutor({ calls, pathModeAfterPlan: "absent" }),
    } as any);

    const state = await loadState("prod", env);
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_HEALTHY,
      consumed: true,
    });
    expect(state.deploy).toMatchObject({
      commitSha: PLANNED_SHA,
      releaseTag: "v0.1.1",
    });

    // Env transfer used stdin and never argv secrets.
    const transfer = calls.find((call) => call.argv.join(" ").includes(".env.tmp"));
    expect(transfer).toBeTruthy();
    expect(transfer?.stdin).toContain("BETTER_AUTH_SECRET=");
    assertArgvFreeOfSecrets(transfer?.argv ?? [], secrets);
    for (const secret of secrets) {
      expect(transfer?.argv.join(" ") ?? "").not.toContain(secret);
    }

    // No scp/rsync, no host-key disable, no down -v / delete checkout
    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => /\bscp\b|\brsync\b/u.test(line))).toBe(false);
    expect(
      flat.some((line) => /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/u.test(line)),
    ).toBe(false);
    expect(flat.some((line) => /down\s+-v|\brm\s+-rf\b/u.test(line))).toBe(false);
    expect(flat.some((line) => line.includes("git clone"))).toBe(true);
    expect(flat.some((line) => line.includes("docker compose pull"))).toBe(true);
    expect(flat.some((line) => line.includes("docker compose up -d --wait"))).toBe(true);

    // Existing dirty refusal
    await seedInstallation(env, "dirty", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("dirty", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    // Force dirty at apply time
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({ dirtyAtApply: true, pathModeAfterPlan: "existing_git" }),
      } as any),
    ).rejects.toThrow(/dirty/i);
  });

  it("refuses moved image labels and compose config/pull/up failures", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);

    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          imageRevision: OTHER_SHA,
        }),
      } as any),
    ).rejects.toThrow(new RegExp(OCI_REVISION_LABEL));

    await seedInstallation(env, "cfg", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("cfg", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          failAt: "config",
        }),
      } as any),
    ).rejects.toThrow(/config/i);

    await seedInstallation(env, "pull", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("pull", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          failAt: "pull",
        }),
      } as any),
    ).rejects.toThrow(/pull/i);

    await seedInstallation(env, "up", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("up", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          failAt: "up",
        }),
      } as any),
    ).rejects.toThrow(/up/i);
  });

  it("validates every health outcome and resumes from checkpoints without moved-tag adoption", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);

    // Fail public health first
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          publicHealthCode: "500",
        }),
      } as any),
    ).rejects.toThrow(/Public \/health/);

    // Checkpoint should be at UP (health failed after up)
    let state = await loadState("prod", env);
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_UP,
      consumed: false,
    });

    // Resume succeeds without confirmation prompt when checkpoint present
    let prompted = false;
    await runDeployApply({
      env,
      io: testIo({
        prompt: async () => {
          prompted = true;
          return "nope";
        },
      }),
      executor: applyExecutor({ pathModeAfterPlan: "existing_git" }),
    } as any);
    expect(prompted).toBe(false);
    state = await loadState("prod", env);
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_HEALTHY,
      consumed: true,
    });

    // Public db must be 404
    await seedInstallation(env, "db404", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("db404", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          publicDbCode: "200",
        }),
      } as any),
    ).rejects.toThrow(/Public \/health\/db/);

    // Missing backup service
    await seedInstallation(env, "backup", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("backup", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          missingService: "backup",
        }),
      } as any),
    ).rejects.toThrow(/backup/);

    // Unhealthy api
    await seedInstallation(env, "apihealth", { awsCoreComplete: true, humanGatesComplete: true });
    await writeCurrentPointer("apihealth", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          apiHealth: "unhealthy",
        }),
      } as any),
    ).rejects.toThrow(/api/i);

    // worker+caddy need only running; compose has no healthcheck on them. public /health proves caddy.
    await seedInstallation(env, "runningonly", {
      awsCoreComplete: true,
      humanGatesComplete: true,
    });
    await writeCurrentPointer("runningonly", env);
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await runDeployApply({
      env,
      io: testIo({
        prompt: async () =>
          buildDeployConfirmationPhrase({
            sshTarget: "root@203.0.113.10",
            domain: "mail.example.com",
            remotePath: "/srv/nusend",
            releaseTag: "v0.1.1",
            commitSha: PLANNED_SHA,
          }),
      }),
      executor: applyExecutor({
        pathModeAfterPlan: "existing_git",
        caddyHealth: "",
        workerHealth: "",
      }),
    } as any);
    const runningOnly = await loadState("runningonly", env);
    expect(runningOnly.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_HEALTHY,
    });
  });

  it("resume after failure re-transfers current local env and replays up without confirmation/clone/delete", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);

    await expect(
      runDeployApply({
        env,
        io: testIo({
          prompt: async () =>
            buildDeployConfirmationPhrase({
              sshTarget: "root@203.0.113.10",
              domain: "mail.example.com",
              remotePath: "/srv/nusend",
              releaseTag: "v0.1.1",
              commitSha: PLANNED_SHA,
            }),
        }),
        executor: applyExecutor({
          pathModeAfterPlan: "existing_git",
          failAt: "up",
        }),
      } as any),
    ).rejects.toThrow(/up/i);

    const failed = await loadState("prod", env);
    expect(failed.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_IMAGES,
      consumed: false,
    });

    // Correct local deployment.env before resume.
    const deployment = await loadDeploymentEnv("prod", env);
    deployment.NUSEND_OWNER_NAME = "Resume Corrected Owner";
    await writeDeploymentEnv("prod", deployment, env);

    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    let prompted = false;
    await runDeployApply({
      env,
      io: testIo({
        prompt: async () => {
          prompted = true;
          return "nope";
        },
      }),
      executor: applyExecutor({ calls, pathModeAfterPlan: "existing_git" }),
    } as any);
    expect(prompted).toBe(false);

    const transferCalls = calls.filter((call) =>
      opensshJoinedRemote(call.argv).includes(".env.tmp"),
    );
    expect(transferCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      transferCalls.some((call) => (call.stdin ?? "").includes("Resume Corrected Owner")),
    ).toBe(true);

    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => line.includes("docker compose up -d --wait"))).toBe(true);
    expect(flat.some((line) => line.includes("git clone"))).toBe(false);
    expect(flat.some((line) => /\brm\s+-rf\b|down\s+-v/u.test(line))).toBe(false);

    // OpenSSH argv shape on env transfer (one remote command word after target).
    for (const call of transferCalls) {
      expect(call.argv[0]).toBe("ssh");
      expect(call.argv[1]).toBe("root@203.0.113.10");
      expect(call.argv).toHaveLength(3);
      expect(call.argv[2]).toBe(
        buildOpenSshRemoteCommand(buildRemoteEnvTransferScript("/srv/nusend/.env")),
      );
    }

    const after = await loadState("prod", env);
    expect(after.plans[DEPLOY_PLAN_STORE_KEY]).toMatchObject({
      applyCheckpoint: APPLY_CHECKPOINT_HEALTHY,
      consumed: true,
    });
  });

  it("treats partial clone as existing and never deletes it", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "absent" }),
    } as any);
    const calls: Array<{ argv: string[] }> = [];
    await runDeployApply({
      env,
      io: testIo({
        prompt: async () =>
          buildDeployConfirmationPhrase({
            sshTarget: "root@203.0.113.10",
            domain: "mail.example.com",
            remotePath: "/srv/nusend",
            releaseTag: "v0.1.1",
            commitSha: PLANNED_SHA,
          }),
      }),
      // Plan said empty, but apply discovers existing git (partial prior clone)
      executor: applyExecutor({
        calls,
        pathModeAfterPlan: "existing_git",
      }),
    } as any);
    const flat = calls.map((call) => call.argv.join(" "));
    expect(flat.some((line) => line.includes("git clone"))).toBe(false);
    expect(flat.some((line) => /\brm\s+-rf\b/u.test(line))).toBe(false);
  });

  it("continue checkpoints deploy only after live health evidence", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await runDeployApply({
      env,
      io: testIo({
        prompt: async () =>
          buildDeployConfirmationPhrase({
            sshTarget: "root@203.0.113.10",
            domain: "mail.example.com",
            remotePath: "/srv/nusend",
            releaseTag: "v0.1.1",
            commitSha: PLANNED_SHA,
          }),
      }),
      executor: applyExecutor({ pathModeAfterPlan: "existing_git" }),
    } as any);

    await runContinue({
      env,
      io: testIo(),
      executor: applyExecutor({ pathModeAfterPlan: "existing_git" }),
    });

    const state = await loadState("prod", env);
    expect(state.stages.deploy?.status).toBe("complete");
    expect(state.stages.deploy?.evidence.verified).toBe(true);
    expect(state.stages.deploy?.evidence.commitSha).toBe(PLANNED_SHA);
    expect(state.stages.deploy?.evidence.health).toMatchObject({
      publicHealth: "200",
      publicHealthDb: "404",
      apiHealthDb: "ok",
    });
  });

  it("deploy stage verification fails without healthy apply evidence", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await expect(
      runDeployStageVerification(
        {
          env,
          io: testIo(),
          executor: async () => ok(""),
        } as any,
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/no deploy plan|blocked/i);
  });

  it("rejects hybrid, unhealthy, and mismatched deploy stage evidence before live verification", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    await runDeployPlan({
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await runDeployApply({
      env,
      io: testIo({
        prompt: async () =>
          buildDeployConfirmationPhrase({
            sshTarget: "root@203.0.113.10",
            domain: "mail.example.com",
            remotePath: "/srv/nusend",
            releaseTag: "v0.1.1",
            commitSha: PLANNED_SHA,
          }),
      }),
      executor: applyExecutor({ pathModeAfterPlan: "existing_git" }),
    } as any);
    const applied = await loadState("prod", env);
    const neverLive = async () => {
      throw new Error("live verification must not run");
    };

    await writeState({ ...applied, deploy: undefined } as any, env);
    await expect(
      runDeployStageVerification(
        { env, io: testIo(), executor: neverLive } as any,
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/state\.deploy.*missing/i);

    await writeState(
      {
        ...applied,
        plans: {
          ...applied.plans,
          [DEPLOY_PLAN_STORE_KEY]: {
            ...applied.plans[DEPLOY_PLAN_STORE_KEY],
            applyCheckpoint: APPLY_CHECKPOINT_UP,
          },
        },
      },
      env,
    );
    await expect(
      runDeployStageVerification(
        { env, io: testIo(), executor: neverLive } as any,
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/healthy apply checkpoint/i);

    await writeState({ ...applied, deploy: { ...applied.deploy, commitSha: OTHER_SHA } }, env);
    await expect(
      runDeployStageVerification(
        { env, io: testIo(), executor: neverLive } as any,
        await loadState("prod", env),
      ),
    ).rejects.toThrow(/state\.deploy\.commitSha.*healthy plan/i);
  });

  it("main dispatch wires deploy plan/apply", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const result = await runSetup(["deploy", "plan"], {
      env,
      io: testIo(),
      executor: planExecutor([], { pathMode: "absent" }),
    });
    expect(result.exitCode).toBe(0);
    const state = await loadState("prod", env);
    expect(state.plans[DEPLOY_PLAN_STORE_KEY]).toBeTruthy();
  });

  it("keeps command/argv/log secrecy for env material", async () => {
    const env = testEnv();
    await seedInstallation(env, "prod", { awsCoreComplete: true, humanGatesComplete: true });
    const deployment = await (await import("./state.mjs")).loadDeploymentEnv("prod", env);
    const secrets = secretValuesFromEnv(deployment);
    const logs: string[] = [];
    const calls: Array<{ argv: string[]; stdin?: string }> = [];

    await runDeployPlan({
      env,
      io: testIo({ log: (line) => logs.push(line) }),
      executor: planExecutor([], { pathMode: "existing_git" }),
    } as any);
    await runDeployApply({
      env,
      io: testIo({
        log: (line) => logs.push(line),
        prompt: async () =>
          buildDeployConfirmationPhrase({
            sshTarget: "root@203.0.113.10",
            domain: "mail.example.com",
            remotePath: "/srv/nusend",
            releaseTag: "v0.1.1",
            commitSha: PLANNED_SHA,
          }),
      }),
      executor: applyExecutor({ calls, pathModeAfterPlan: "existing_git" }),
    } as any);

    const logText = logs.join("\n");
    for (const secret of secrets) {
      expect(logText).not.toContain(secret);
    }
    for (const call of calls) {
      assertArgvFreeOfSecrets(call.argv, secrets);
    }
    // serialized env only on stdin of transfer
    const bodies = calls.map((call) => call.stdin ?? "").join("");
    expect(bodies).toContain(serializeEnvFile(deployment).trim().split("\n")[0]!);
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

function testEnv() {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-deploy-"));
  temporaryDirectories.push(directory);
  return { NUSEND_SETUP_HOME: directory, HOME: directory };
}

function testIo(
  overrides: {
    log?: (line: string) => void;
    error?: (line: string) => void;
    prompt?: (message: string) => Promise<string>;
    promptSecret?: (message: string) => Promise<string>;
  } = {},
) {
  return {
    prompt: overrides.prompt ?? (async () => ""),
    promptSecret: overrides.promptSecret ?? (async () => ""),
    log: overrides.log ?? (() => undefined),
    error: overrides.error ?? (() => undefined),
  };
}

function ok(stdout: string, exitCode = 0, stderr = "", argv: string[] = []) {
  return {
    exitCode,
    signal: null as null,
    stdout,
    stderr,
    argv,
  };
}

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

async function seedInstallation(
  env: { NUSEND_SETUP_HOME: string },
  installationId: string,
  options: {
    awsCoreComplete?: boolean;
    humanGatesComplete?: boolean;
    productionAccessEnabled?: boolean;
  } = {},
) {
  const base = sampleState(installationId);
  if (options.awsCoreComplete) {
    base.stages.aws_core = {
      status: "complete",
      completedAt: "2026-01-02T00:00:00.000Z",
      evidence: { verified: true, stackId: "stack" },
    };
  }
  if (options.humanGatesComplete) {
    base.stages.human_gates = {
      status: "complete",
      completedAt: "2026-01-03T00:00:00.000Z",
      evidence: {
        verified: true,
        gates: HUMAN_GATE_DEFINITIONS.map((gate) => gate.id),
      },
    };
  }
  if (options.productionAccessEnabled) {
    (base as any).aws = {
      productionAccess: {
        productionAccessEnabled: true,
        status: "granted",
        reviewStatus: "GRANTED",
      },
    };
  }
  await writeState(base, env);
  await writeDeploymentEnv(
    installationId,
    {
      NUSEND_DOMAIN: "mail.example.com",
      NUSEND_INGRESS_MODE: "direct",
      NUSEND_OWNER_EMAIL: "owner@example.com",
      NUSEND_OWNER_NAME: "Owner",
      BETTER_AUTH_SECRET: "better-auth-secret-value-xxxxxxxx",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-client-secret-value",
      NUSEND_API_KEY_HASH_SECRET: "api-key-hash-secret-value-xxxxxx",
      NUSEND_UNSUBSCRIBE_SECRET: "unsubscribe-secret-value-xxxxxx",
      AWS_ACCESS_KEY_ID: "AKIATESTACCESSKEY0001",
      AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-value-xxxx",
      AWS_REGION: "us-east-1",
      NUSEND_SES_FROM_EMAIL: "sender@example.com",
      NUSEND_SES_TRANSACTIONAL_CONFIGURATION_SET: "nusend-prod-transactional",
      NUSEND_SES_FEEDBACK_TOPIC_ARNS: "arn:aws:sns:us-east-1:123456789012:topic",
      NUSEND_RESTIC_REPOSITORY: "s3:https://abc.r2.cloudflarestorage.com/bucket/nusend",
      NUSEND_R2_ACCESS_KEY_ID: "r2-access",
      NUSEND_R2_SECRET_ACCESS_KEY: "r2-secret-value-xxxxxx",
      NUSEND_RESTIC_PASSWORD: "restic-password-value-xxxxxx",
    },
    env,
  );
  await writeCurrentPointer(installationId, env);
}

function composeYamlFixture() {
  return [
    "name: nusend",
    "x-app-image: &app-image ghcr.io/maxedapps/nusend:v0.1.1",
    "x-backup-image: &backup-image ghcr.io/maxedapps/nusend-backup:v0.1.1",
    "services:",
    "  api:",
    "    image: *app-image",
    "  backup:",
    "    image: *backup-image",
  ].join("\n");
}

function planExecutor(
  calls: Array<{ argv: string[]; stdin?: string }>,
  options: {
    pathMode?: "absent" | "empty" | "existing_git" | "nonempty_not_git";
    composeVersionText?: string;
    arch?: string;
    origin?: string;
    head?: string;
    dirty?: boolean;
    branch?: string;
    tagSha?: string;
    lsRemoteSha?: string;
  },
) {
  return async ({
    command,
    args,
    stdin,
  }: {
    command: string;
    args?: readonly string[];
    stdin?: string;
  }) => {
    const argv = [command, ...(args ?? [])];
    calls.push({ argv, stdin });
    const joined = argv.join(" ");
    const remote = opensshJoinedRemote(argv);
    const respond = (stdout: string, exitCode = 0, stderr = "") =>
      ok(stdout, exitCode, stderr, argv);

    if (command === "git" && args?.[0] === "ls-remote") {
      const sha = options.lsRemoteSha ?? PLANNED_SHA;
      return ok(`${sha}\trefs/tags/v0.1.1\n`, 0, "", argv);
    }

    if (command !== "ssh") {
      throw new Error(`unexpected command: ${joined}`);
    }
    assertNoHostKeyBypass(argv);
    assertOpenSshArgvShape(argv);

    if (remote.includes("uname")) {
      return respond(`Linux\n${options.arch ?? "x86_64"}\n`);
    }
    if (remote.includes("docker version")) {
      return respond("27.0.0\n");
    }
    if (remote.includes("docker compose version")) {
      return respond(options.composeVersionText ?? "Docker Compose version v5.3.2\n");
    }
    if (remote.includes("ss -lnt") || remote.includes("NO_PORT_TOOL")) {
      return respond("LISTEN 0 128 0.0.0.0:22\n");
    }
    if (remote.includes("path=") && remote.includes("ABSENT_WRITABLE_PARENT")) {
      if (options.pathMode === "absent") return respond("ABSENT_WRITABLE_PARENT\n");
      if (options.pathMode === "empty") return respond("EMPTY_DIRECTORY\n");
      if (options.pathMode === "existing_git") return respond("EXISTING_GIT\n");
      if (options.pathMode === "nonempty_not_git") return respond("NONEMPTY_NOT_GIT\n");
      return respond("ABSENT_WRITABLE_PARENT\n");
    }
    if (remote.includes("remote get-url origin")) {
      const tagSha = options.tagSha === undefined ? (options.head ?? PLANNED_SHA) : options.tagSha;
      if (options.dirty) {
        return respond(
          [
            `ORIGIN:${options.origin ?? PUBLIC_REPO_URL}`,
            "PORCELAIN: M README.md",
            `HEAD:${options.head ?? PLANNED_SHA}`,
            `BRANCH:${options.branch ?? ""}`,
            `TAG_SHA:${tagSha}`,
          ].join("\n") + "\n",
        );
      }
      return respond(
        [
          `ORIGIN:${options.origin ?? PUBLIC_REPO_URL}`,
          "PORCELAIN:",
          `HEAD:${options.head ?? PLANNED_SHA}`,
          `BRANCH:${options.branch ?? ""}`,
          `TAG_SHA:${tagSha}`,
        ].join("\n") + "\n",
      );
    }
    if (remote.includes("docker compose") && remote.includes("config --quiet")) {
      return respond("");
    }
    if (remote.includes("cat compose.yaml")) {
      return respond(composeYamlFixture());
    }

    throw new Error(`unexpected remote script: ${remote}`);
  };
}

function applyExecutor(options: {
  calls?: Array<{ argv: string[]; stdin?: string }>;
  pathModeAfterPlan?: "absent" | "empty" | "existing_git";
  lsRemoteSha?: string;
  imageRevision?: string;
  failAt?: "config" | "pull" | "up" | "private-db";
  publicHealthCode?: string;
  publicDbCode?: string;
  missingService?: string;
  apiHealth?: string;
  caddyHealth?: string;
  workerHealth?: string;
  dirtyAtApply?: boolean;
}) {
  const calls = options.calls ?? [];
  let cloned = options.pathModeAfterPlan === "existing_git";

  return async ({
    command,
    args,
    stdin,
  }: {
    command: string;
    args?: readonly string[];
    stdin?: string;
  }) => {
    const argv = [command, ...(args ?? [])];
    calls.push({ argv, stdin });
    const joined = argv.join(" ");
    const remote = opensshJoinedRemote(argv);
    const respond = (stdout: string, exitCode = 0, stderr = "") =>
      ok(stdout, exitCode, stderr, argv);

    if (command === "git" && args?.[0] === "ls-remote") {
      return ok(`${options.lsRemoteSha ?? PLANNED_SHA}\trefs/tags/v0.1.1\n`, 0, "", argv);
    }

    if (command === "curl") {
      const url = args?.[args.length - 1] ?? "";
      if (url.endsWith("/health/db")) {
        return respond(options.publicDbCode ?? "404");
      }
      if (url.endsWith("/health")) {
        const code = options.publicHealthCode ?? "200";
        // runDeployApply checks stdout even on success path; simulate success with wrong code
        return respond(code);
      }
      throw new Error(`unexpected curl: ${joined}`);
    }

    if (command !== "ssh") {
      throw new Error(`unexpected command: ${joined}`);
    }
    assertNoHostKeyBypass(argv);
    assertOpenSshArgvShape(argv);

    if (remote.includes("path=") && remote.includes("ABSENT_WRITABLE_PARENT")) {
      if (cloned || options.pathModeAfterPlan === "existing_git") return respond("EXISTING_GIT\n");
      if (options.pathModeAfterPlan === "empty") return respond("EMPTY_DIRECTORY\n");
      return respond("ABSENT_WRITABLE_PARENT\n");
    }

    if (remote.includes("git clone")) {
      cloned = true;
      return respond(`${PLANNED_SHA}\n`);
    }

    if (remote.includes("remote get-url origin")) {
      if (options.dirtyAtApply) {
        return respond(
          [
            `ORIGIN:${PUBLIC_REPO_URL}`,
            "PORCELAIN: M file",
            `HEAD:${PLANNED_SHA}`,
            "BRANCH:",
            `TAG_SHA:${PLANNED_SHA}`,
          ].join("\n") + "\n",
        );
      }
      return respond(
        [
          `ORIGIN:${PUBLIC_REPO_URL}`,
          "PORCELAIN:",
          `HEAD:${PLANNED_SHA}`,
          "BRANCH:",
          `TAG_SHA:${PLANNED_SHA}`,
        ].join("\n") + "\n",
      );
    }

    if (
      remote.includes(".env.tmp") ||
      remote.includes('cat >"$tmp"') ||
      remote.includes("mktemp")
    ) {
      return respond("");
    }
    if (remote.includes("stat -c") || remote.includes("stat -f")) {
      return respond("600\n");
    }
    if (remote.includes("docker compose config --quiet")) {
      if (options.failAt === "config") {
        throw Object.assign(new Error("Command failed (1): compose config"), {
          exitCode: 1,
          stdout: "",
          stderr: "config error",
          argv,
        });
      }
      return respond("");
    }
    if (remote.includes("docker compose pull")) {
      if (options.failAt === "pull") {
        throw Object.assign(new Error("Command failed (1): compose pull"), {
          exitCode: 1,
          stdout: "",
          stderr: "pull error",
          argv,
        });
      }
      return respond("pulled\n");
    }
    if (remote.includes("docker image inspect")) {
      return respond(`${options.imageRevision ?? PLANNED_SHA}\n`);
    }
    if (remote.includes("cat compose.yaml")) {
      return respond(composeYamlFixture());
    }
    if (remote.includes("docker compose up -d --wait")) {
      if (options.failAt === "up") {
        throw Object.assign(new Error("Command failed (1): compose up"), {
          exitCode: 1,
          stdout: "",
          stderr: "up error",
          argv,
        });
      }
      return respond("up\n");
    }
    if (remote.includes("docker compose ps --format json")) {
      const workerEntry =
        options.workerHealth === ""
          ? { Service: "worker", State: "running", Status: "Up" }
          : {
              Service: "worker",
              State: "running",
              Status: "Up",
              ...(options.workerHealth ? { Health: options.workerHealth } : {}),
            };
      const caddyEntry =
        options.caddyHealth === ""
          ? { Service: "caddy", State: "running", Status: "Up" }
          : {
              Service: "caddy",
              State: "running",
              Health: options.caddyHealth ?? "healthy",
            };
      const services = [
        {
          Service: "api",
          State: "running",
          Health: options.apiHealth ?? "healthy",
        },
        workerEntry,
        caddyEntry,
        { Service: "backup", State: "running", Health: "healthy" },
      ].filter((entry) => entry.Service !== options.missingService);
      return respond(services.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }
    if (remote.includes("docker compose ps -q")) {
      return respond("healthy\n");
    }
    if (remote.includes("health/db")) {
      if (options.failAt === "private-db") {
        throw Object.assign(new Error("Command failed (1): private db"), {
          exitCode: 1,
          stdout: "",
          stderr: "db down",
          argv,
        });
      }
      return respond("");
    }

    throw new Error(`unexpected remote script: ${remote}`);
  };
}

/**
 * Reflect real OpenSSH behavior: every argv after the destination is joined with
 * spaces into one remote command string (no per-arg quoting).
 */
function opensshJoinedRemote(argv: string[]) {
  if (argv[0] !== "ssh") return "";
  return argv.slice(2).join(" ");
}

function assertOpenSshArgvShape(argv: string[]) {
  // Deploy always passes: ssh <target> <one remote command word>
  expect(argv[0]).toBe("ssh");
  expect(argv).toHaveLength(3);
  expect(argv[2]).toMatch(/^sh -c '/);
}
