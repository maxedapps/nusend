import { randomBytes, randomInt } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { Schema } from "effect";

import type { StoredCredential } from "../credentials/store.js";
import {
  configDirectory,
  configPath,
  credentialsPath,
  localStateLockPath,
  localStateReaperMutexPath,
  type PathEnvironment,
} from "./paths.js";

// This cooperative protocol relies on every Nusend process honoring its mutex
// and on local-filesystem hard-link/rename semantics. It does not claim to stop
// arbitrary external filesystem mutation. Network mounts are unsupported.
export const LOCAL_STATE_LOCK_TIMEOUT_MS = 5_000;
const LOCAL_STATE_PUBLICATION_GRACE_MS = 1_000;
const MIN_RETRY_MS = 25;
const MAX_RETRY_MS = 250;
const LOCK_VERSION = 1;
const CONTENTION_MESSAGE = "Nusend local state is busy; another CLI process holds the lock.";
const MUTEX_GUIDANCE =
  "Nusend local-state reaper mutex may be orphaned or malformed; operator inspection is required before removing it.";
const RELEASE_GUIDANCE =
  "Nusend local-state ownership could not be restored or released safely; operator inspection is required.";

export const ConfigFileSchema = Schema.Struct({
  activeProfile: Schema.optional(Schema.String),
  profiles: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ baseUrl: Schema.String })),
  ),
});

export type ConfigFile = typeof ConfigFileSchema.Type;

export const CredentialFileSchema = Schema.Struct({
  credentials: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        apiKey: Schema.String,
        apiKeyId: Schema.optional(Schema.String),
        createdAt: Schema.optional(Schema.String),
        preview: Schema.optional(Schema.String),
      }),
    ),
  ),
});

export type CredentialFile = typeof CredentialFileSchema.Type;

type LockOwner = {
  readonly createdAt: number;
  readonly host: string;
  readonly pid: number;
  readonly token: string;
  readonly version: typeof LOCK_VERSION;
};

type ProtocolPurpose = "publish" | "reap" | "release";

type OwnerState =
  | { readonly kind: "Missing" }
  | { readonly kind: "Malformed" }
  | { readonly kind: "Owner"; readonly owner: LockOwner };

export type LocalStateLockTestHooks = {
  readonly afterLockContention?: () => Promise<void>;
  readonly afterMutexAcquired?: (purpose: ProtocolPurpose) => Promise<void>;
  readonly afterMutexContention?: (purpose: ProtocolPurpose) => Promise<void>;
  readonly afterReleaseRename?: () => Promise<void>;
  readonly beforeCandidateCleanup?: (input: {
    readonly candidate: string;
    readonly published: boolean;
  }) => Promise<void>;
  readonly beforeMutexRelease?: (purpose: ProtocolPurpose) => Promise<void>;
  readonly beforeReleaseRename?: () => Promise<void>;
};

export type LocalStateLockOptions = {
  readonly now?: () => number;
  readonly publicationGraceMs?: number;
  readonly retryDelayMs?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly testHooks?: LocalStateLockTestHooks;
  readonly timeoutMs?: number;
};

export type LocalStateMutationHooks = {
  readonly afterLockAcquired?: () => Promise<void>;
  readonly afterLockContention?: () => Promise<void>;
  readonly afterRename?: (destination: string) => Promise<void>;
  readonly beforeRename?: (destination: string, temporary: string) => Promise<void>;
};

export type LocalStateSnapshot = {
  readonly config: ConfigFile;
  readonly credentials: CredentialFile;
};

export type LocalStateSnapshotHooks = {
  readonly afterLockContention?: () => Promise<void>;
};

export class LocalStateContentionError extends Error {
  constructor() {
    super(CONTENTION_MESSAGE);
    this.name = "LocalStateContentionError";
  }
}

export async function loadConfigFile(env: PathEnvironment = process.env): Promise<ConfigFile> {
  const value = await readJsonOrFallback(configPath(env), { profiles: {} });
  return Schema.decodeUnknownSync(ConfigFileSchema)(value);
}

export async function loadCredentialFile(
  env: PathEnvironment = process.env,
): Promise<CredentialFile> {
  const path = credentialsPath(env);
  if (process.platform !== "win32") {
    await assertPrivatePath(dirname(path), "Credential directory", true);
    await assertPrivatePath(path, "Credential file", true);
  }
  const value = await readJsonOrFallback(path, { credentials: {} });
  return Schema.decodeUnknownSync(CredentialFileSchema)(value);
}

export async function loadLocalStateSnapshot(
  env: PathEnvironment = process.env,
  hooks: LocalStateSnapshotHooks = {},
): Promise<LocalStateSnapshot> {
  return withLocalStateLock(
    env,
    async () => ({
      config: await loadConfigFile(env),
      credentials: await loadCredentialFile(env),
    }),
    { testHooks: { afterLockContention: hooks.afterLockContention } },
  );
}

export async function updateConfig(
  transform: (current: ConfigFile) => ConfigFile,
  env: PathEnvironment = process.env,
  hooks: LocalStateMutationHooks = {},
): Promise<void> {
  await withLocalStateLock(
    env,
    async () => {
      await hooks.afterLockAcquired?.();
      const current = await loadConfigFile(env);
      const updated = Schema.decodeUnknownSync(ConfigFileSchema)(transform(current));
      await writeAtomicJson(configPath(env), updated, hooks);
    },
    mutationLockOptions(hooks),
  );
}

export async function updateCredentials(
  transform: (current: CredentialFile) => CredentialFile | undefined,
  env: PathEnvironment = process.env,
  hooks: LocalStateMutationHooks = {},
): Promise<boolean> {
  return withLocalStateLock(
    env,
    async () => {
      await hooks.afterLockAcquired?.();
      const current = await loadCredentialFile(env);
      const transformed = transform(current);
      if (transformed === undefined) return false;
      const updated = Schema.decodeUnknownSync(CredentialFileSchema)(transformed);
      await writeAtomicJson(credentialsPath(env), updated, hooks);
      return true;
    },
    mutationLockOptions(hooks),
  );
}

export async function updateLoginState(
  input: {
    readonly baseUrl: string;
    readonly credential: StoredCredential;
    readonly profile: string;
  },
  env: PathEnvironment = process.env,
  hooks: LocalStateMutationHooks = {},
): Promise<void> {
  await withLocalStateLock(
    env,
    async () => {
      await hooks.afterLockAcquired?.();
      const credentials = await loadCredentialFile(env);
      const config = await loadConfigFile(env);
      const updatedCredentials = Schema.decodeUnknownSync(CredentialFileSchema)({
        credentials: { ...(credentials.credentials ?? {}), [input.profile]: input.credential },
      });
      const updatedConfig = Schema.decodeUnknownSync(ConfigFileSchema)({
        activeProfile: config.activeProfile ?? input.profile,
        profiles: {
          ...(config.profiles ?? {}),
          [input.profile]: { baseUrl: input.baseUrl },
        },
      });

      // The shared lock prevents another cooperative CLI process from interleaving
      // these renames. A crash between them is intentionally not cross-file atomic.
      await writeAtomicJson(credentialsPath(env), updatedCredentials, hooks);
      await writeAtomicJson(configPath(env), updatedConfig, hooks);
    },
    mutationLockOptions(hooks),
  );
}

export async function withLocalStateLock<T>(
  env: PathEnvironment,
  action: () => Promise<T>,
  options: LocalStateLockOptions = {},
): Promise<T> {
  const release = await acquireLocalStateLock(env, options);
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function acquireLocalStateLock(
  env: PathEnvironment = process.env,
  options: LocalStateLockOptions = {},
): Promise<() => Promise<void>> {
  const directory = configDirectory(env);
  await ensurePrivateDirectory(directory);
  const lockPath = localStateLockPath(env);
  const runtime = lockRuntime(options);
  const deadline = runtime.now() + runtime.timeoutMs;

  while (true) {
    if (runtime.now() >= deadline) {
      // eslint-disable-next-line no-await-in-loop -- timeout classification must inspect mutex state.
      await assertMutexSafeAtTimeout(env);
      throw new LocalStateContentionError();
    }

    const contender = makeOwner(runtime.now());
    // Every publication holds the protocol mutex, so release/reaping can move and
    // inspect the canonical lock without a cooperative publisher filling the gap.
    // eslint-disable-next-line no-await-in-loop -- lock attempts must be serialized.
    const mutex = await tryAcquireProtocolMutex(env, contender, "publish", runtime);
    if (!mutex) {
      // eslint-disable-next-line no-await-in-loop -- contention retries are deliberately paced.
      await sleepUntilRetry(deadline, runtime);
      continue;
    }

    let publication: PublicationResult | undefined;
    let mutexReleaseError: unknown;
    try {
      // eslint-disable-next-line no-await-in-loop -- each publication attempt is serialized.
      publication = await tryPublishOwner(lockPath, contender, runtime.testHooks);
    } finally {
      try {
        // eslint-disable-next-line no-await-in-loop -- the attempt must release its protocol mutex.
        await mutex.release();
      } catch (error) {
        mutexReleaseError = error;
      }
    }

    if (mutexReleaseError) {
      if (publication?.published) {
        // eslint-disable-next-line no-await-in-loop -- failed mutex release rolls back owned publication.
        await rollbackOwnedCanonicalLock(lockPath, contender.token);
        // eslint-disable-next-line no-await-in-loop -- rollback also owns deferred candidate cleanup.
        await cleanupDeferredCandidate(publication.deferredCandidate, contender.token);
      }
      throw mutexReleaseError;
    }

    if (publication?.published) {
      return makeRelease(env, contender.token, publication.deferredCandidate, options);
    }

    // eslint-disable-next-line no-await-in-loop -- this observes the actual EEXIST attempt.
    await runtime.testHooks.afterLockContention?.();
    // eslint-disable-next-line no-await-in-loop -- recovery is part of this acquisition attempt.
    const reaped = await tryReapDeadOwner(env, contender, runtime.publicationGraceMs, runtime);
    if (!reaped) {
      // eslint-disable-next-line no-await-in-loop -- contention retries are deliberately paced.
      await sleepUntilRetry(deadline, runtime);
    }
  }
}

type LockRuntime = {
  readonly now: () => number;
  readonly publicationGraceMs: number;
  readonly retryDelayMs: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly testHooks: LocalStateLockTestHooks;
  readonly timeoutMs: number;
};

type ProtocolMutex = { readonly release: () => Promise<void> };

type PublicationResult = {
  readonly deferredCandidate?: string;
  readonly published: boolean;
};

function lockRuntime(options: LocalStateLockOptions): LockRuntime {
  return {
    now: options.now ?? Date.now,
    publicationGraceMs: options.publicationGraceMs ?? LOCAL_STATE_PUBLICATION_GRACE_MS,
    retryDelayMs: options.retryDelayMs ?? (() => randomInt(MIN_RETRY_MS, MAX_RETRY_MS + 1)),
    sleep: options.sleep ?? defaultSleep,
    testHooks: options.testHooks ?? {},
    timeoutMs: options.timeoutMs ?? LOCAL_STATE_LOCK_TIMEOUT_MS,
  };
}

function mutationLockOptions(hooks: LocalStateMutationHooks): LocalStateLockOptions {
  return { testHooks: { afterLockContention: hooks.afterLockContention } };
}

async function tryAcquireProtocolMutex(
  env: PathEnvironment,
  owner: LockOwner,
  purpose: ProtocolPurpose,
  runtime: LockRuntime,
): Promise<ProtocolMutex | null> {
  const mutexPath = localStateReaperMutexPath(env);
  try {
    await mkdir(mutexPath, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    await runtime.testHooks.afterMutexContention?.(purpose);
    const state = await readOwnerState(join(mutexPath, "owner.json"));
    if (state.kind === "Malformed") throw new Error(MUTEX_GUIDANCE, { cause: error });
    if (state.kind === "Owner" && !isActiveSameHostOwner(state.owner)) {
      throw new Error(MUTEX_GUIDANCE, { cause: error });
    }
    // A missing owner can be the tiny mkdir-to-owner-file publication window.
    // It is retried, but if it persists the timeout classifier fails closed.
    return null;
  }

  const ownerPath = join(mutexPath, "owner.json");
  try {
    await writeSyncedFile(ownerPath, owner);
    await runtime.testHooks.afterMutexAcquired?.(purpose);
  } catch (error) {
    await unlink(ownerPath).catch((cleanupError: unknown) => {
      if (!isNotFound(cleanupError)) throw cleanupError;
    });
    await rmdir(mutexPath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      try {
        await runtime.testHooks.beforeMutexRelease?.(purpose);
        await unlink(ownerPath);
        await rmdir(mutexPath);
        released = true;
      } catch (error) {
        throw new Error(MUTEX_GUIDANCE, { cause: error });
      }
    },
  };
}

async function acquireProtocolMutexWithWait(
  env: PathEnvironment,
  purpose: ProtocolPurpose,
  options: LocalStateLockOptions,
): Promise<ProtocolMutex> {
  const runtime = lockRuntime(options);
  const deadline = runtime.now() + runtime.timeoutMs;
  while (true) {
    if (runtime.now() >= deadline) {
      // eslint-disable-next-line no-await-in-loop -- timeout classification must inspect mutex state.
      await assertMutexSafeAtTimeout(env);
      throw new LocalStateContentionError();
    }
    const owner = makeOwner(runtime.now());
    // eslint-disable-next-line no-await-in-loop -- mutex acquisition is a bounded serial retry.
    const mutex = await tryAcquireProtocolMutex(env, owner, purpose, runtime);
    if (mutex) return mutex;
    // eslint-disable-next-line no-await-in-loop -- mutex acquisition is deliberately paced.
    await sleepUntilRetry(deadline, runtime);
  }
}

async function tryPublishOwner(
  lockPath: string,
  owner: LockOwner,
  hooks: LocalStateLockTestHooks,
): Promise<PublicationResult> {
  const candidate = join(
    dirname(lockPath),
    `${basename(lockPath)}.candidate-${process.pid}-${owner.token}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let failure: unknown;
  let published = false;
  try {
    handle = await open(candidate, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(candidate, lockPath);
    published = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) failure = publicationError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let deferredCandidate: string | undefined;
  try {
    await hooks.beforeCandidateCleanup?.({ candidate, published });
    await unlink(candidate);
  } catch (error) {
    if (isNotFound(error)) {
      // Nothing remains to clean.
    } else if (published) {
      // Publication ownership must not be lost merely because its second hard
      // link could not be removed. The release capability owns deferred cleanup.
      deferredCandidate = candidate;
    } else if (!failure) {
      failure = error;
    }
  }

  if (failure) throw failure;
  return { deferredCandidate, published };
}

function publicationError(error: unknown): unknown {
  if (hasCode(error, "EPERM") || hasCode(error, "ENOTSUP")) {
    return new Error(
      `Nusend cannot safely publish its local-state lock on this filesystem (${errorCode(error)}). Network or unsupported filesystems are not supported.`,
      { cause: error },
    );
  }
  return error;
}

async function tryReapDeadOwner(
  env: PathEnvironment,
  contender: LockOwner,
  publicationGraceMs: number,
  runtime: LockRuntime,
): Promise<boolean> {
  const lockPath = localStateLockPath(env);
  const observed = await readLockOwner(lockPath);
  if (!observed || !isRecoverableDeadOwner(observed, publicationGraceMs, runtime.now())) {
    return false;
  }

  const mutex = await tryAcquireProtocolMutex(env, contender, "reap", runtime);
  if (!mutex) return false;

  let tombstone: string | undefined;
  try {
    const current = await readLockOwner(lockPath);
    if (
      current &&
      sameOwner(current, observed) &&
      isRecoverableDeadOwner(current, publicationGraceMs, runtime.now())
    ) {
      const target = uniqueTombstone(lockPath, "reap", contender.token);
      try {
        await rename(lockPath, target);
        tombstone = target;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  } catch (error) {
    await mutex.release();
    throw error;
  }

  // A failed mutex release leaves the tombstone intact. Deleting it first would
  // destroy the only recoverable owner record while publication remains blocked.
  await mutex.release();
  if (tombstone) await unlink(tombstone);
  return tombstone !== undefined;
}

function isRecoverableDeadOwner(
  owner: LockOwner,
  publicationGraceMs: number,
  now: number,
): boolean {
  if (owner.host !== hostname() || now - owner.createdAt < publicationGraceMs) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (hasCode(error, "EPERM")) return false;
    return hasCode(error, "ESRCH");
  }
}

function isActiveSameHostOwner(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

async function assertMutexSafeAtTimeout(env: PathEnvironment): Promise<void> {
  const mutexPath = localStateReaperMutexPath(env);
  try {
    await stat(mutexPath);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  const state = await readOwnerState(join(mutexPath, "owner.json"));
  if (state.kind !== "Owner" || !isActiveSameHostOwner(state.owner)) {
    throw new Error(MUTEX_GUIDANCE);
  }
}

function makeRelease(
  env: PathEnvironment,
  token: string,
  deferredCandidate: string | undefined,
  options: LocalStateLockOptions,
): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    await releaseLocalStateOwnership(env, token, deferredCandidate, options);
    released = true;
  };
}

async function releaseLocalStateOwnership(
  env: PathEnvironment,
  token: string,
  deferredCandidate: string | undefined,
  options: LocalStateLockOptions,
): Promise<void> {
  const lockPath = localStateLockPath(env);
  const mutex = await acquireProtocolMutexWithWait(env, "release", options);
  let tombstone: string | undefined;
  let ownedTombstone = false;
  let operationError: unknown;

  try {
    await options.testHooks?.beforeReleaseRename?.();
    const target = uniqueTombstone(lockPath, "release", token);
    try {
      await rename(lockPath, target);
      tombstone = target;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await options.testHooks?.afterReleaseRename?.();

    if (tombstone) {
      const moved = await readLockOwner(tombstone);
      if (moved?.token === token) {
        ownedTombstone = true;
      } else {
        try {
          // Hard-link restoration is exclusive: it never overwrites a lock that
          // appeared through non-cooperative external mutation.
          await link(tombstone, lockPath);
          await unlink(tombstone);
          tombstone = undefined;
        } catch (error) {
          operationError = new Error(RELEASE_GUIDANCE, { cause: error });
        }
      }
    }
  } catch (error) {
    operationError = new Error(RELEASE_GUIDANCE, { cause: error });
  }

  // If this fails, preserve every tombstone for operator recovery.
  await mutex.release();
  if (operationError) throw operationError;
  if (ownedTombstone && tombstone) await unlink(tombstone);
  await cleanupDeferredCandidate(deferredCandidate, token);
}

async function rollbackOwnedCanonicalLock(lockPath: string, token: string): Promise<void> {
  const tombstone = uniqueTombstone(lockPath, "rollback", token);
  try {
    await rename(lockPath, tombstone);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const moved = await readLockOwner(tombstone);
  if (moved?.token === token) {
    await unlink(tombstone);
    return;
  }
  try {
    await link(tombstone, lockPath);
    await unlink(tombstone);
  } catch (error) {
    throw new Error(RELEASE_GUIDANCE, { cause: error });
  }
}

async function cleanupDeferredCandidate(
  candidate: string | undefined,
  token: string,
): Promise<void> {
  if (!candidate) return;
  const state = await readOwnerState(candidate);
  if (state.kind === "Missing") return;
  if (state.kind !== "Owner" || state.owner.token !== token) {
    throw new Error(RELEASE_GUIDANCE);
  }
  try {
    await unlink(candidate);
  } catch (error) {
    if (!isNotFound(error)) throw new Error(RELEASE_GUIDANCE, { cause: error });
  }
}

async function sleepUntilRetry(deadline: number, runtime: LockRuntime): Promise<void> {
  const remaining = deadline - runtime.now();
  if (remaining <= 0) return;
  await runtime.sleep(Math.min(remaining, clampRetryDelay(runtime.retryDelayMs())));
}

function uniqueTombstone(lockPath: string, purpose: string, token: string): string {
  return join(
    dirname(lockPath),
    `${basename(lockPath)}.${purpose}-tombstone-${process.pid}-${token}-${randomToken()}`,
  );
}

async function writeAtomicJson(
  destination: string,
  value: unknown,
  hooks: LocalStateMutationHooks,
): Promise<void> {
  const temporary = `${destination}.tmp-${process.pid}-${randomToken()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.(destination, temporary);
    await rename(temporary, destination);
    await hooks.afterRename?.(destination);
    await syncDirectory(dirname(destination));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (hasCode(error, "EINVAL") || hasCode(error, "ENOTSUP") || hasCode(error, "EBADF")) {
    return true;
  }
  return (
    process.platform === "win32" &&
    (hasCode(error, "EPERM") || hasCode(error, "EACCES") || hasCode(error, "EISDIR"))
  );
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function writeSyncedFile(path: string, value: unknown): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readJsonOrFallback(path: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return fallback;
    throw error;
  }
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  const state = await readOwnerState(path);
  return state.kind === "Owner" ? state.owner : null;
}

async function readOwnerState(path: string): Promise<OwnerState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { kind: "Missing" };
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLockOwner(parsed) ? { kind: "Owner", owner: parsed } : { kind: "Malformed" };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "Malformed" };
    throw error;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null) return false;
  return (
    Reflect.get(value, "version") === LOCK_VERSION &&
    typeof Reflect.get(value, "token") === "string" &&
    Reflect.get(value, "token").length > 0 &&
    typeof Reflect.get(value, "pid") === "number" &&
    Number.isSafeInteger(Reflect.get(value, "pid")) &&
    Reflect.get(value, "pid") > 0 &&
    typeof Reflect.get(value, "host") === "string" &&
    Reflect.get(value, "host").length > 0 &&
    typeof Reflect.get(value, "createdAt") === "number" &&
    Number.isFinite(Reflect.get(value, "createdAt"))
  );
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return (
    left.version === right.version &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.host === right.host &&
    left.createdAt === right.createdAt
  );
}

async function assertPrivatePath(
  path: string,
  label: string,
  allowMissing: boolean,
): Promise<void> {
  try {
    const mode = (await stat(path)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${label} permissions are too broad. Run \`nusend config repair-permissions\`.`,
      );
    }
  } catch (error) {
    if (allowMissing && isNotFound(error)) return;
    throw error;
  }
}

function makeOwner(createdAt: number): LockOwner {
  return {
    createdAt,
    host: hostname(),
    pid: process.pid,
    token: randomToken(),
    version: LOCK_VERSION,
  };
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}

function clampRetryDelay(value: number): number {
  if (!Number.isFinite(value)) return MAX_RETRY_MS;
  return Math.max(MIN_RETRY_MS, Math.min(MAX_RETRY_MS, Math.trunc(value)));
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    typeof Reflect.get(error, "code") === "string"
    ? String(Reflect.get(error, "code"))
    : "unknown";
}
