import { chmod, lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { SetupStoreError } from "../errors.ts";
import { SetupStore, SetupStoreLive, type SetupStoreService } from "../services/setup-store.ts";
import {
  PROVISIONER_POLICY_FILE_NAME,
  SECRET_ENV_KEYS,
  envFilePath,
  parseEnvFile,
  plainDeploymentEnv,
  policyArtifactPath,
  redactDeploymentEnv,
  sanitizePlanMetadata,
  serializeEnvFile,
  setupHome,
  stateFilePath,
  unwrapEnvValue,
  type SetupState,
  type SetupStateV2,
  type SsoMigrationBinding,
} from "./index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function testEnv(): { NUSEND_SETUP_HOME: string } {
  const directory = mkdtempSync(join(tmpdir(), "nusend-setup-cli-state-"));
  temporaryDirectories.push(directory);
  return { NUSEND_SETUP_HOME: directory };
}

function runStore<A>(effect: Effect.Effect<A, SetupStoreError, SetupStoreService>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(SetupStoreLive)));
}

function sampleConfig(overrides: Partial<SetupState["config"]> = {}): SetupState["config"] {
  return {
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
    ...overrides,
  };
}

function sampleStateV1(installationId = "demo"): SetupState {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    installationId,
    createdAt: now,
    updatedAt: now,
    config: sampleConfig(),
    stages: {
      init: {
        status: "complete",
        completedAt: now,
        evidence: { verified: true, installationId },
      },
      aws_core: {
        status: "complete",
        completedAt: now,
        evidence: {
          verified: true,
          stackName: `nusend-${installationId}`,
          changeSetName: "cs-demo-1",
          phase: "CREATE",
        },
      },
      deploy_apply: {
        status: "complete",
        completedAt: now,
        evidence: { verified: true, releaseTag: "v0.1.1" },
      },
    },
    plans: {
      aws_core: {
        kind: "aws",
        templateFingerprint: "fp-template-1",
        parameterFingerprint: "fp-params-1",
      },
      destroy: {
        kind: "destroy",
        stackFingerprint: "fp-stack-1",
      },
    },
    aws: {
      stack: {
        stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/nusend-demo/abc",
        stackName: `nusend-${installationId}`,
        accountId: "123456789012",
        region: "us-east-1",
      },
      stackCreation: { changeSetId: "cs-id-1" },
      runtimeAccessKeyId: "AKIAEXAMPLE",
      productionAccess: { requested: true },
      identity: { verificationStatus: "Success" },
    },
    deploy: {
      releaseTag: "v0.1.1",
      imageDigest: "sha256:abc",
      appliedAt: now,
    },
  };
}

function sampleBinding(overrides: Partial<SsoMigrationBinding> = {}): SsoMigrationBinding {
  return {
    type: "sso",
    profileName: "nusend-sso",
    ssoSessionName: "nusend-sso-session",
    accountId: "123456789012",
    roleName: "NusendProvisioner",
    identityCenterRegion: "us-west-2",
    partition: "aws",
    verifiedAccountId: "123456789012",
    workloadRegion: "us-east-1",
    ...overrides,
  };
}

const SECRET_FIXTURE_VALUES = {
  BETTER_AUTH_SECRET: "secret-better-auth-value-xyz",
  GOOGLE_CLIENT_SECRET: "secret-google-client-value-xyz",
  NUSEND_API_KEY_HASH_SECRET: "secret-api-key-hash-value-xyz",
  NUSEND_UNSUBSCRIBE_SECRET: "secret-unsubscribe-value-xyz",
  AWS_SECRET_ACCESS_KEY: "secret-aws-access-key-value-xyz",
  NUSEND_R2_SECRET_ACCESS_KEY: "secret-r2-access-key-value-xyz",
  NUSEND_RESTIC_PASSWORD: "secret-restic-password-value-xyz",
} as const;

describe("SetupStore schema", () => {
  it("rejects unsupported schema versions", async () => {
    const env = testEnv();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.writeState(
          { ...sampleStateV1("demo"), schemaVersion: 99 } as unknown as SetupState,
          env,
        );
      }).pipe(Effect.provide(SetupStoreLive)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value).toBeInstanceOf(SetupStoreError);
        expect(error.value.reason === "version" || error.value.reason === "parse").toBe(true);
      }
    }
  });

  it("rejects schema v2 without awsAuth", async () => {
    const env = testEnv();
    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          return yield* store.writeState(
            { ...sampleStateV1("demo"), schemaVersion: 2 } as unknown as SetupState,
            env,
          );
        }),
      ),
    ).rejects.toThrow(/awsAuth|parse|state\.json/i);
  });
});

describe("SetupStore persistence", () => {
  it("writes private modes and loads state/env", async () => {
    const env = testEnv();
    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.writeState(sampleStateV1("demo"), env);
        yield* store.writeDeploymentEnv(
          "demo",
          {
            NUSEND_DOMAIN: "mail.example.com",
            BETTER_AUTH_SECRET: SECRET_FIXTURE_VALUES.BETTER_AUTH_SECRET,
          },
          env,
        );
        yield* store.writeCurrentPointer("demo", env);
      }),
    );

    expect(setupHome(env)).toBe(env.NUSEND_SETUP_HOME);
    if (process.platform !== "win32") {
      expect((await lstat(setupHome(env))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(setupHome(env), "demo"))).mode & 0o777).toBe(0o700);
      expect((await lstat(stateFilePath("demo", env))).mode & 0o777).toBe(0o600);
      expect((await lstat(envFilePath("demo", env))).mode & 0o777).toBe(0o600);
      expect((await lstat(join(setupHome(env), "current"))).mode & 0o777).toBe(0o600);
    }

    const loaded = await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.loadState("demo", env);
      }),
    );
    expect(loaded.installationId).toBe("demo");
    expect(loaded.schemaVersion).toBe(1);

    const deploymentEnv = await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.loadDeploymentEnv("demo", env);
      }),
    );
    expect(unwrapEnvValue(deploymentEnv.BETTER_AUTH_SECRET!)).toBe(
      SECRET_FIXTURE_VALUES.BETTER_AUTH_SECRET,
    );
    expect(Redacted.isRedacted(deploymentEnv.BETTER_AUTH_SECRET)).toBe(true);
    expect(String(deploymentEnv.BETTER_AUTH_SECRET)).not.toContain(
      SECRET_FIXTURE_VALUES.BETTER_AUTH_SECRET,
    );
  });

  it("recovers atomically when rename is interrupted", async () => {
    const env = testEnv();
    const original = sampleStateV1("demo");
    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.writeState(original, env);
      }),
    );
    const before = await readFile(stateFilePath("demo", env), "utf8");

    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          return yield* store.writeState(
            {
              ...original,
              updatedAt: "2026-02-01T00:00:00.000Z",
              config: { ...original.config, domain: "new.example.com" },
            },
            env,
            {
              beforeRename: async () => {
                throw new Error("before-rename sentinel");
              },
            },
          );
        }),
      ),
    ).rejects.toThrow(/before-rename sentinel/);

    expect(await readFile(stateFilePath("demo", env), "utf8")).toBe(before);
    const leftovers = (await readdir(join(setupHome(env), "demo"))).filter((name) =>
      name.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("reserves installation directories concurrently with one winner", async () => {
    const env = testEnv();
    const results = await Promise.allSettled([
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          return yield* store.reserveInstallationDirectory("race", env);
        }),
      ),
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          return yield* store.reserveInstallationDirectory("race", env);
        }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /already exists|concurrent|duplicate/i,
    );
  });

  it("writes provisioner policy artifact with mode 0600", async () => {
    const env = testEnv();
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [] }, null, 2);
    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.reserveInstallationDirectory("demo", env);
        yield* store.writePolicyArtifact("demo", policy, env);
      }),
    );
    const path = policyArtifactPath("demo", env);
    expect(path.endsWith(PROVISIONER_POLICY_FILE_NAME)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(`${policy}\n`);
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform !== "win32")("rejects broad permissions and symlinks", async () => {
    const env = testEnv();
    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.writeState(sampleStateV1("demo"), env);
        yield* store.writeDeploymentEnv("demo", { NUSEND_DOMAIN: "mail.example.com" }, env);
      }),
    );

    await chmod(stateFilePath("demo", env), 0o644);
    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          return yield* store.loadState("demo", env);
        }),
      ),
    ).rejects.toThrow(/too broad/);
    await chmod(stateFilePath("demo", env), 0o600);

    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.reserveInstallationDirectory("symlink-demo", env);
      }),
    );
    const target = join(setupHome(env), "symlink-demo", "target-policy.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await chmod(target, 0o600);
    const installPolicy = policyArtifactPath("symlink-demo", env);
    await symlink(target, installPolicy);

    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          return yield* store.writePolicyArtifact(
            "symlink-demo",
            JSON.stringify({ Version: "2012-10-17", Statement: [] }),
            env,
          );
        }),
      ),
    ).rejects.toThrow(/symlink/);
  });
});

describe("SetupStore migration v1→v2", () => {
  it("preserves stage/plan/aws/deploy evidence and byte-equivalent deployment.env", async () => {
    const env = testEnv();
    const v1 = sampleStateV1("demo");
    const envValues = {
      NUSEND_DOMAIN: "mail.example.com",
      NUSEND_OWNER_EMAIL: "owner@example.com",
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      ...SECRET_FIXTURE_VALUES,
      Z_EXTRA: "extra-op",
    };
    const originalEnvBody = serializeEnvFile(envValues);

    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.writeState(v1, env);
        yield* store.writeDeploymentEnv("demo", envValues, env);
      }),
    );

    const envBefore = await readFile(envFilePath("demo", env), "utf8");
    expect(envBefore).toBe(originalEnvBody);

    const migrated = await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        const loaded = yield* store.loadState("demo", env);
        return yield* store.migrateV1ToV2(loaded, sampleBinding(), env);
      }),
    );

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.awsAuth.type).toBe("sso");
    expect(migrated.awsAuth.profileName).toBe("nusend-sso");
    expect(migrated.awsAuth.identityCenterRegion).toBe("us-west-2");
    expect(migrated.config.awsRegion).toBe("us-east-1");
    expect(migrated.stages).toEqual(v1.stages);
    expect(migrated.plans).toEqual(v1.plans);
    expect(migrated.aws).toEqual(v1.aws);
    expect(migrated.deploy).toEqual(v1.deploy);
    expect(migrated.createdAt).toBe(v1.createdAt);

    const envAfter = await readFile(envFilePath("demo", env), "utf8");
    expect(envAfter).toBe(envBefore);
    expect(envAfter).toBe(originalEnvBody);

    const reloaded = await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.loadState("demo", env);
      }),
    );
    expect(reloaded.schemaVersion).toBe(2);
    expect((reloaded as SetupStateV2).awsAuth).toEqual(migrated.awsAuth);
    expect(reloaded.stages).toEqual(v1.stages);
    expect(reloaded.plans).toEqual(v1.plans);
    expect(reloaded.aws).toEqual(v1.aws);
    expect(reloaded.deploy).toEqual(v1.deploy);
  });

  it("refuses wrong-context migration (account/region/stack mismatch)", async () => {
    const env = testEnv();
    const v1 = sampleStateV1("demo");
    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.writeState(v1, env);
      }),
    );

    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          const loaded = yield* store.loadState("demo", env);
          return yield* store.migrateV1ToV2(
            loaded,
            sampleBinding({ verifiedAccountId: "999999999999", accountId: "999999999999" }),
            env,
          );
        }),
      ),
    ).rejects.toThrow(/does not match installation config\.awsAccountId/);

    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          const loaded = yield* store.loadState("demo", env);
          return yield* store.migrateV1ToV2(
            loaded,
            sampleBinding({ workloadRegion: "eu-west-1" }),
            env,
          );
        }),
      ),
    ).rejects.toThrow(/does not match installation config\.awsRegion/);

    const wrongStack = {
      ...v1,
      aws: {
        ...v1.aws,
        stack: {
          ...v1.aws!.stack,
          accountId: "111111111111",
        },
      },
    };
    await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.writeState(wrongStack, env);
      }),
    );
    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          const loaded = yield* store.loadState("demo", env);
          return yield* store.migrateV1ToV2(loaded, sampleBinding(), env);
        }),
      ),
    ).rejects.toThrow(/does not match immutable stack account/);

    // v1 must remain readable after failed migration attempts
    const stillV1 = await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        return yield* store.loadState("demo", env);
      }),
    );
    expect(stillV1.schemaVersion).toBe(1);
  });

  it("never downgrades v2 and refuses re-migration", async () => {
    const env = testEnv();
    const migrated = await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        yield* store.writeState(sampleStateV1("demo"), env);
        const loaded = yield* store.loadState("demo", env);
        return yield* store.migrateV1ToV2(loaded, sampleBinding(), env);
      }),
    );
    expect(migrated.schemaVersion).toBe(2);

    await expect(
      runStore(
        Effect.gen(function* () {
          const store = yield* SetupStore;
          return yield* store.migrateV1ToV2(migrated, sampleBinding(), env);
        }),
      ),
    ).rejects.toThrow(/already schema v2|refusing re-migration/i);
  });
});

describe("SetupStore secrets and public status", () => {
  it("round-trips secrets through protected env and redacts in status/public fixtures", async () => {
    const env = testEnv();
    const v1 = sampleStateV1("demo");
    const envValues = {
      NUSEND_DOMAIN: "mail.example.com",
      ...SECRET_FIXTURE_VALUES,
    };

    const { status, deploymentEnv, envBody } = await runStore(
      Effect.gen(function* () {
        const store = yield* SetupStore;
        const written = yield* store.writeState(v1, env);
        yield* store.writeDeploymentEnv("demo", envValues, env);
        const loadedEnv = yield* store.loadDeploymentEnv("demo", env);
        const statusView = store.publicStatusView(written);
        return {
          status: statusView,
          deploymentEnv: loadedEnv,
          envBody: serializeEnvFile(plainDeploymentEnv(loadedEnv)),
        };
      }),
    );

    // Secrets are redacted in memory.
    for (const key of Object.keys(SECRET_FIXTURE_VALUES) as Array<
      keyof typeof SECRET_FIXTURE_VALUES
    >) {
      expect(Redacted.isRedacted(deploymentEnv[key])).toBe(true);
      expect(unwrapEnvValue(deploymentEnv[key]!)).toBe(SECRET_FIXTURE_VALUES[key]);
    }

    // Protected env serialization may contain secrets (this is the allowed path).
    for (const value of Object.values(SECRET_FIXTURE_VALUES)) {
      expect(envBody).toContain(value);
    }

    // Status/public fixtures must never contain secret values.
    const statusJson = JSON.stringify(status);
    for (const value of Object.values(SECRET_FIXTURE_VALUES)) {
      expect(statusJson).not.toContain(value);
    }

    // Grep-style: SECRET_ENV_KEYS values never appear in status/public fixtures.
    for (const key of SECRET_ENV_KEYS) {
      const value = SECRET_FIXTURE_VALUES[key as keyof typeof SECRET_FIXTURE_VALUES];
      if (value) {
        expect(statusJson).not.toContain(value);
      }
    }

    // sanitizePlanMetadata strips secret-shaped keys from nested plan metadata.
    expect(
      sanitizePlanMetadata({
        ok: 1,
        BETTER_AUTH_SECRET: SECRET_FIXTURE_VALUES.BETTER_AUTH_SECRET,
        nested: { token: "nope", region: "us-east-1" },
      }),
    ).toEqual({ ok: 1, nested: { region: "us-east-1" } });

    // On-disk env remains parseable and byte-stable for known ordering.
    const disk = await readFile(envFilePath("demo", env), "utf8");
    expect(parseEnvFile(disk).BETTER_AUTH_SECRET).toBe(SECRET_FIXTURE_VALUES.BETTER_AUTH_SECRET);
  });

  it("redacts secrets through redactDeploymentEnv helper", () => {
    const redacted = redactDeploymentEnv({
      NUSEND_DOMAIN: "mail.example.com",
      BETTER_AUTH_SECRET: SECRET_FIXTURE_VALUES.BETTER_AUTH_SECRET,
    });
    expect(redacted.NUSEND_DOMAIN).toBe("mail.example.com");
    expect(Redacted.isRedacted(redacted.BETTER_AUTH_SECRET)).toBe(true);
    expect(String(redacted.BETTER_AUTH_SECRET)).not.toContain(
      SECRET_FIXTURE_VALUES.BETTER_AUTH_SECRET,
    );
  });
});
