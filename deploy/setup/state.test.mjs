import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertInstallationId,
  checkpointStage,
  envFilePath,
  INSTALLATION_ID_PATTERN,
  loadDeploymentEnv,
  loadState,
  parseEnvFile,
  parseState,
  resolveInstallationId,
  sanitizePlanMetadata,
  serializeEnvFile,
  setupHome,
  stateFilePath,
  writeAtomicFile,
  writeCurrentPointer,
  writeDeploymentEnv,
  writeState,
} from "./state.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("setup state and env", () => {
  it("uses NUSEND_SETUP_HOME and writes private modes", async () => {
    const env = testEnv();
    const state = sampleState("demo");
    await writeState(state, env);
    await writeDeploymentEnv(
      "demo",
      {
        NUSEND_DOMAIN: "mail.example.com",
        BETTER_AUTH_SECRET: "secret-value-one-two-three",
      },
      env,
    );
    await writeCurrentPointer("demo", env);

    expect(setupHome(env)).toBe(env.NUSEND_SETUP_HOME);
    if (process.platform !== "win32") {
      expect((await lstat(setupHome(env))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(setupHome(env), "demo"))).mode & 0o777).toBe(0o700);
      expect((await lstat(stateFilePath("demo", env))).mode & 0o777).toBe(0o600);
      expect((await lstat(envFilePath("demo", env))).mode & 0o777).toBe(0o600);
      expect((await lstat(join(setupHome(env), "current"))).mode & 0o777).toBe(0o600);
    }
    await expect(loadState("demo", env)).resolves.toMatchObject({ installationId: "demo" });
    await expect(resolveInstallationId(env)).resolves.toBe("demo");
    await expect(loadDeploymentEnv("demo", env)).resolves.toMatchObject({
      BETTER_AUTH_SECRET: "secret-value-one-two-three",
    });
  });

  it("prefers NUSEND_SETUP_INSTALLATION over the pointer", async () => {
    const env = testEnv();
    await writeState(sampleState("one"), env);
    await writeState(sampleState("two"), env);
    await writeCurrentPointer("one", env);
    await expect(resolveInstallationId({ ...env, NUSEND_SETUP_INSTALLATION: "two" })).resolves.toBe(
      "two",
    );
  });

  it("rejects unknown schema versions", () => {
    expect(() =>
      parseState({
        ...sampleState("demo"),
        schemaVersion: 99,
      }),
    ).throw(/Unsupported state schema version 99/);
  });

  it("rejects malformed JSON state and env on load", async () => {
    const env = testEnv();
    await mkdir(join(setupHome(env), "demo"), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(join(setupHome(env), "demo"), 0o700);
    }
    await writeFile(stateFilePath("demo", env), "{bad", { mode: 0o600 });
    await writeFile(envFilePath("demo", env), "not-valid", { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(stateFilePath("demo", env), 0o600);
      await chmod(envFilePath("demo", env), 0o600);
    }
    await expect(loadState("demo", env)).rejects.toThrow(/malformed JSON/);
    await expect(loadDeploymentEnv("demo", env)).rejects.toThrow(/expected KEY=VALUE/);
  });

  it("rejects env shell syntax and duplicates", () => {
    expect(() => parseEnvFile("export FOO=bar\n")).toThrow(/shell directives/);
    expect(() => parseEnvFile("FOO=$(whoami)\n")).toThrow(/shell expansion|unquoted/);
    expect(() => parseEnvFile("FOO=1\nFOO=2\n")).toThrow(/duplicate/);
    expect(parseEnvFile('FOO=bar\n# comment\nBAZ="a b"\n')).toEqual({
      FOO: "bar",
      BAZ: "a b",
    });
    expect(serializeEnvFile({ NUSEND_DOMAIN: "x", BETTER_AUTH_SECRET: "s p" })).toContain(
      'BETTER_AUTH_SECRET="s p"',
    );
  });

  it("serializes extra operational and known secret keys in stable order", () => {
    const serialized = serializeEnvFile({
      Z_EXTRA: "last",
      NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET: "previous secret",
      A_EXTRA: "first",
    });
    expect(serialized).toBe(
      'A_EXTRA=first\nNUSEND_UNSUBSCRIBE_PREVIOUS_SECRET="previous secret"\nZ_EXTRA=last\n',
    );
    expect(parseEnvFile(serialized)).toEqual({
      A_EXTRA: "first",
      NUSEND_UNSUBSCRIBE_PREVIOUS_SECRET: "previous secret",
      Z_EXTRA: "last",
    });
  });

  it("refuses checkpoints without verified evidence", async () => {
    const env = testEnv();
    const state = await writeState(sampleState("demo"), env);
    await expect(checkpointStage(state, "aws_core", { exitCode: 0 }, env)).rejects.toThrow(
      /verified evidence/,
    );
    const next = await checkpointStage(
      state,
      "aws_core",
      { verified: true, stackId: "stack-1", password: "nope" },
      env,
    );
    expect(next.stages.aws_core.evidence).toEqual({ verified: true, stackId: "stack-1" });
    expect(JSON.stringify(next)).not.toContain("nope");
  });

  it("sanitizes plan metadata secret-ish keys", () => {
    expect(
      sanitizePlanMetadata({
        arn: "a",
        AWS_SECRET_ACCESS_KEY: "x",
        nested: { token: "y", ok: 1 },
      }),
    ).toEqual({ arn: "a", nested: { ok: 1 } });
  });

  it("recovers atomically when rename is interrupted", async () => {
    const env = testEnv();
    const original = sampleState("demo");
    await writeState(original, env);
    const before = await readFile(stateFilePath("demo", env), "utf8");

    await expect(
      writeState(
        {
          ...original,
          updatedAt: new Date().toISOString(),
          config: { ...original.config, domain: "new.example.com" },
        },
        env,
        {
          beforeRename: async () => {
            throw new Error("before-rename sentinel");
          },
        },
      ),
    ).rejects.toThrow("before-rename sentinel");

    expect(await readFile(stateFilePath("demo", env), "utf8")).toBe(before);
    const leftovers = (await readdir(join(setupHome(env), "demo"))).filter((name) =>
      name.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("rejects broad permissions and symlinks", async () => {
    const env = testEnv();
    await writeState(sampleState("demo"), env);
    await writeDeploymentEnv("demo", { NUSEND_DOMAIN: "mail.example.com" }, env);

    await chmod(stateFilePath("demo", env), 0o644);
    await expect(loadState("demo", env)).rejects.toThrow(/too broad/);
    await chmod(stateFilePath("demo", env), 0o600);

    await chmod(envFilePath("demo", env), 0o644);
    await expect(loadDeploymentEnv("demo", env)).rejects.toThrow(/too broad/);
    await chmod(envFilePath("demo", env), 0o600);

    await chmod(join(setupHome(env), "demo"), 0o755);
    await expect(loadState("demo", env)).rejects.toThrow(/too broad/);
    await chmod(join(setupHome(env), "demo"), 0o700);

    // Refuse overwrite of a world-readable existing file.
    await chmod(stateFilePath("demo", env), 0o644);
    await expect(
      writeState({ ...sampleState("demo"), updatedAt: new Date().toISOString() }, env),
    ).rejects.toThrow(/too broad/);
    await chmod(stateFilePath("demo", env), 0o600);

    const linkDir = join(setupHome(env), "linky");
    await mkdir(linkDir, { mode: 0o700 });
    await chmod(linkDir, 0o700);
    const target = join(linkDir, "target-state.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await chmod(target, 0o600);
    const linkPath = join(linkDir, "state.json");
    await symlink(target, linkPath);
    await expect(writeAtomicFile(linkPath, "{}\n")).rejects.toThrow(/symlink/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects preexisting broad directory modes on write without repairing them",
    async () => {
      const env = testEnv();
      const home = setupHome(env);

      await chmod(home, 0o755);
      await expect(writeState(sampleState("demo"), env)).rejects.toThrow(/too broad/);
      expect((await lstat(home)).mode & 0o777).toBe(0o755);

      await chmod(home, 0o700);
      const installDir = join(home, "demo");
      await mkdir(installDir, { mode: 0o755 });
      await chmod(installDir, 0o755);
      await expect(writeState(sampleState("demo"), env)).rejects.toThrow(/too broad/);
      expect((await lstat(installDir)).mode & 0o777).toBe(0o755);
      await expect(
        writeDeploymentEnv("demo", { NUSEND_DOMAIN: "mail.example.com" }, env),
      ).rejects.toThrow(/too broad/);
      expect((await lstat(installDir)).mode & 0o777).toBe(0o755);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects intermediate setup-path symlinks on read and write",
    async () => {
      const base = testEnv().NUSEND_SETUP_HOME;
      const actualRoot = join(base, "actual");
      const actualSetup = join(actualRoot, "setup");
      await mkdir(actualSetup, { recursive: true, mode: 0o700 });
      await chmod(actualRoot, 0o700);
      await chmod(actualSetup, 0o700);

      const viaLink = join(base, "via-link");
      await symlink(actualRoot, viaLink);
      const linkedHome = join(viaLink, "setup");
      const linkedEnv = { NUSEND_SETUP_HOME: linkedHome };

      await expect(writeState(sampleState("demo"), linkedEnv)).rejects.toThrow(/symlink/);
      await expect(
        writeDeploymentEnv("demo", { NUSEND_DOMAIN: "mail.example.com" }, linkedEnv),
      ).rejects.toThrow(/symlink/);

      // Legitimate install under a real setup home, then poison an intermediate component.
      const realEnv = { NUSEND_SETUP_HOME: actualSetup };
      await writeState(sampleState("demo"), realEnv);
      await writeDeploymentEnv("demo", { NUSEND_DOMAIN: "mail.example.com" }, realEnv);

      const installDir = join(actualSetup, "demo");
      const relocated = join(actualSetup, "demo-real");
      await rename(installDir, relocated);
      await symlink(relocated, installDir);

      await expect(loadState("demo", realEnv)).rejects.toThrow(/symlink/);
      await expect(loadDeploymentEnv("demo", realEnv)).rejects.toThrow(/symlink/);
      await expect(
        writeState({ ...sampleState("demo"), updatedAt: new Date().toISOString() }, realEnv),
      ).rejects.toThrow(/symlink/);
    },
  );

  it("rejects invalid installation ids and release tags in state", () => {
    expect(() => parseState({ ...sampleState("../x"), installationId: "../x" })).toThrow(
      /Invalid installation id/,
    );
    expect(() =>
      parseState({
        ...sampleState("demo"),
        config: { ...sampleState("demo").config, releaseTag: "main" },
      }),
    ).toThrow(/Invalid release tag/);
  });

  it("accepts installation ids up to exactly 31 characters and rejects longer slugs", () => {
    const maxId = `a${"b".repeat(30)}`;
    const tooLong = `a${"b".repeat(31)}`;
    expect(maxId).toHaveLength(31);
    expect(tooLong).toHaveLength(32);
    expect(INSTALLATION_ID_PATTERN.test(maxId)).toBe(true);
    expect(INSTALLATION_ID_PATTERN.test(tooLong)).toBe(false);
    expect(assertInstallationId(maxId)).toBe(maxId);
    expect(assertInstallationId("demo")).toBe("demo");
    expect(assertInstallationId("a")).toBe("a");
    expect(assertInstallationId("prod-1")).toBe("prod-1");
    expect(() => assertInstallationId(tooLong)).toThrow(/max 31 characters/);
    expect(() => assertInstallationId("1bad")).toThrow(/Invalid installation id/);
    expect(() => assertInstallationId("Bad")).toThrow(/Invalid installation id/);
    expect(() => assertInstallationId("current")).toThrow(/Invalid installation id/);
  });

  it("keeps INSTALLATION_ID_PATTERN identical to the CloudFormation InstallationName AllowedPattern", () => {
    const stackPath = join(dirname(fileURLToPath(import.meta.url)), "../aws/nusend-stack.json");
    const stack = JSON.parse(readFileSync(stackPath, "utf8"));
    const allowedPattern = stack.Parameters.InstallationName.AllowedPattern;
    expect(allowedPattern).toBe("^[a-z][a-z0-9-]{0,30}$");
    expect(INSTALLATION_ID_PATTERN.source).toBe(allowedPattern);
    expect(INSTALLATION_ID_PATTERN.flags).toContain("u");
  });
});

function testEnv() {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-state-"));
  temporaryDirectories.push(directory);
  return { NUSEND_SETUP_HOME: directory };
}

function sampleState(installationId) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    installationId,
    createdAt: now,
    updatedAt: now,
    config: {
      releaseTag: "v0.1.1",
      domain: "mail.example.com",
      ingressMode: "direct",
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
    },
    stages: {
      init: {
        status: "complete",
        completedAt: now,
        evidence: { verified: true, installationId },
      },
    },
    plans: {},
  };
}
