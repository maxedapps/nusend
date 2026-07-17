import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";

import { configDirectory, statePath, type PathEnvironment } from "./paths.js";

export type StoredCredential = {
  readonly apiKey: string;
  readonly apiKeyId?: string;
  readonly createdAt?: string;
  readonly preview?: string;
};

export const LocalStateSchema = Schema.Struct({
  baseUrl: Schema.optional(Schema.String),
  credential: Schema.optional(
    Schema.Struct({
      apiKey: Schema.String,
      apiKeyId: Schema.optional(Schema.String),
      createdAt: Schema.optional(Schema.String),
      preview: Schema.optional(Schema.String),
    }),
  ),
});

export type LocalState = typeof LocalStateSchema.Type;

export type LocalStateMutationHooks = {
  readonly afterRename?: (destination: string) => Promise<void>;
  readonly beforeRename?: (destination: string, temporary: string) => Promise<void>;
};

export async function loadLocalState(env: PathEnvironment = process.env): Promise<LocalState> {
  const path = statePath(env);
  await assertPrivateStatePath(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
  return Schema.decodeUnknownSync(LocalStateSchema)(JSON.parse(raw));
}

// Login may replace readable malformed JSON/schema, but it must first prove that
// the existing path can be read. Filesystem and permission-policy failures never
// become an empty state and therefore can never authorize a write.
export async function writeLoginState(
  input: { readonly baseUrl: string; readonly credential: StoredCredential },
  env: PathEnvironment = process.env,
  hooks: LocalStateMutationHooks = {},
): Promise<void> {
  await inspectExistingStateForLogin(env);
  await writeAtomicState(input, env, hooks);
}

export async function removeStoredCredential(
  env: PathEnvironment = process.env,
  hooks: LocalStateMutationHooks = {},
): Promise<boolean> {
  const current = await loadLocalState(env);
  if (!current.credential) return false;
  await writeAtomicState({ baseUrl: current.baseUrl }, env, hooks);
  return true;
}

export async function repairLocalStatePermissions(
  env: PathEnvironment = process.env,
  platformName = process.platform,
): Promise<boolean> {
  if (platformName === "win32") return false;
  const directory = configDirectory(env);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  try {
    await chmod(statePath(env), 0o600);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return true;
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must be http(s).");
  }
  if (!/^\/+$/u.test(url.pathname)) {
    throw new Error(
      `Base URL must not include a path (got ${url.pathname}). Deploy Nusend at a domain root, e.g. https://nusend.example.com.`,
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/u, "");
}

async function inspectExistingStateForLogin(env: PathEnvironment): Promise<void> {
  const path = statePath(env);
  await assertPrivateStatePath(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  try {
    Schema.decodeUnknownSync(LocalStateSchema)(JSON.parse(raw));
  } catch {
    // Login replaces only readable malformed content after authorization.
  }
}

async function writeAtomicState(
  state: LocalState,
  env: PathEnvironment,
  hooks: LocalStateMutationHooks,
): Promise<void> {
  const destination = statePath(env);
  const directory = dirname(destination);
  await ensurePrivateDirectory(directory);
  const validated = Schema.decodeUnknownSync(LocalStateSchema)(state);
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.beforeRename?.(destination, temporary);
    await rename(temporary, destination);
    if (process.platform !== "win32") await chmod(destination, 0o600);
    await syncDirectory(directory);
    await hooks.afterRename?.(destination);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (["EINVAL", "ENOTSUP", "EBADF"].some((code) => hasCode(error, code))) return true;
  return (
    process.platform === "win32" &&
    ["EPERM", "EACCES", "EISDIR"].some((code) => hasCode(error, code))
  );
}

async function assertPrivateStatePath(path: string): Promise<void> {
  if (process.platform === "win32") return;
  await assertPrivatePath(dirname(path), "State directory");
  await assertPrivatePath(path, "State file");
}

async function assertPrivatePath(path: string, label: string): Promise<void> {
  try {
    const mode = (await stat(path)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `${label} permissions are too broad. Run \`nusend config repair-permissions\`.`,
      );
    }
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
