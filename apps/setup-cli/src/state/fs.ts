import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import { SetupStoreError } from "../errors.ts";

export type AtomicWriteHooks = {
  readonly beforeRename?: (destination: string, temporary: string) => Promise<void>;
};

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}

export function isNotFound(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function storeError(
  message: string,
  reason: SetupStoreError["reason"],
  cause?: unknown,
): SetupStoreError {
  return new SetupStoreError({ message, reason, cause });
}

function mapFsError(error: unknown, message: string): SetupStoreError {
  if (error instanceof SetupStoreError) return error;
  if (error instanceof Error && /symlink|too broad|Refusing|Expected/u.test(error.message)) {
    const reason = /symlink/u.test(error.message)
      ? "permission"
      : /too broad/u.test(error.message)
        ? "permission"
        : "io";
    return storeError(error.message, reason, error);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return storeError(`${message}: ${detail}`, "io", error);
}

/**
 * Reject symlinks among existing components of a path.
 * Missing trailing components are allowed (create paths).
 * Root-level platform compatibility symlinks (macOS /tmp,/var,/etc) are permitted.
 */
export function assertSymlinkFreePath(
  targetPath: string,
  label: string,
): Effect.Effect<void, SetupStoreError> {
  return Effect.tryPromise({
    try: async () => {
      if (process.platform === "win32") return;
      if (typeof targetPath !== "string" || targetPath.length === 0) {
        throw storeError(`${label} path is required.`, "invalid-input");
      }

      const absolute = targetPath.startsWith("/") ? targetPath : join(process.cwd(), targetPath);
      const segments = absolute.split("/").filter((segment) => segment.length > 0);
      let current = absolute.startsWith("/") ? "/" : "";

      for (const segment of segments) {
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        let info;
        try {
          info = await lstat(current);
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        if (info.isSymbolicLink()) {
          const platformAliases = new Set(["/etc", "/tmp", "/var"]);
          if (process.platform !== "darwin" || !platformAliases.has(current)) {
            throw storeError(
              `${label} path must not contain a symlink (${current}).`,
              "permission",
            );
          }
        }
      }
    },
    catch: (error) => mapFsError(error, `${label} symlink check failed`),
  });
}

export function ensurePrivateDirectory(directory: string): Effect.Effect<void, SetupStoreError> {
  return Effect.gen(function* () {
    yield* assertSymlinkFreePath(directory, "Directory");
    yield* Effect.tryPromise({
      try: async () => {
        if (process.platform === "win32") {
          await mkdir(directory, { mode: 0o700, recursive: true });
          return;
        }

        try {
          const existing = await lstat(directory);
          if (existing.isSymbolicLink()) {
            throw storeError(`Refusing to use symlinked directory ${directory}.`, "permission");
          }
          if (!existing.isDirectory()) {
            throw storeError(`Expected a directory at ${directory}.`, "io");
          }
          const existingMode = existing.mode & 0o777;
          if ((existingMode & 0o077) !== 0) {
            throw storeError(
              `Directory permissions for ${directory} are too broad (${existingMode.toString(8)}); expected 0700.`,
              "permission",
            );
          }
          return;
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }

        await mkdir(directory, { mode: 0o700, recursive: true });
        const info = await lstat(directory);
        if (info.isSymbolicLink()) {
          throw storeError(`Refusing to use symlinked directory ${directory}.`, "permission");
        }
        if (!info.isDirectory()) {
          throw storeError(`Expected a directory at ${directory}.`, "io");
        }
        await chmod(directory, 0o700);
        const mode = (await stat(directory)).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw storeError(
            `Directory permissions for ${directory} are too broad (${mode.toString(8)}); expected 0700.`,
            "permission",
          );
        }
      },
      catch: (error) => mapFsError(error, `Failed to ensure private directory ${directory}`),
    });
  });
}

export function assertPrivateDirectory(
  path: string,
  label: string,
): Effect.Effect<void, SetupStoreError> {
  return Effect.gen(function* () {
    if (process.platform === "win32") return;
    yield* assertSymlinkFreePath(path, label);
    yield* Effect.tryPromise({
      try: async () => {
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        if (info.isSymbolicLink()) {
          throw storeError(`${label} must not be a symlink (${path}).`, "permission");
        }
        if (!info.isDirectory()) {
          throw storeError(`${label} must be a directory (${path}).`, "io");
        }
        const mode = info.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw storeError(
            `${label} permissions are too broad (${mode.toString(8)}). Expected mode 0700 at ${path}.`,
            "permission",
          );
        }
      },
      catch: (error) => mapFsError(error, `${label} directory check failed`),
    });
  });
}

export function assertPrivateFile(
  path: string,
  label: string,
): Effect.Effect<void, SetupStoreError> {
  return Effect.gen(function* () {
    if (process.platform === "win32") return;
    yield* assertSymlinkFreePath(path, label);
    yield* Effect.tryPromise({
      try: async () => {
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        if (info.isSymbolicLink()) {
          throw storeError(`${label} must not be a symlink (${path}).`, "permission");
        }
        if (!info.isFile()) {
          throw storeError(`${label} must be a regular file (${path}).`, "io");
        }
        const mode = info.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw storeError(
            `${label} permissions are too broad (${mode.toString(8)}). Expected mode 0600 at ${path}.`,
            "permission",
          );
        }
      },
      catch: (error) => mapFsError(error, `${label} file check failed`),
    });
  });
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].some((code) => hasCode(error, code))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function writeAtomicFile(
  destination: string,
  body: string,
  options: { readonly mode?: number; readonly hooks?: AtomicWriteHooks } = {},
): Effect.Effect<void, SetupStoreError> {
  const mode = options.mode ?? 0o600;
  const hooks = options.hooks ?? {};
  const directory = dirname(destination);

  return Effect.gen(function* () {
    yield* assertSymlinkFreePath(destination, "Destination");
    yield* Effect.tryPromise({
      try: async () => {
        try {
          const existing = await lstat(destination);
          if (existing.isSymbolicLink()) {
            throw storeError(`Refusing to overwrite symlink at ${destination}.`, "permission");
          }
          if (process.platform !== "win32") {
            const existingMode = existing.mode & 0o777;
            if ((existingMode & 0o077) !== 0) {
              throw storeError(
                `Refusing to overwrite ${destination}: permissions ${existingMode.toString(8)} are too broad (expected mode 0600).`,
                "permission",
              );
            }
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }

        const temporary = `${destination}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
        let handle: FileHandle | undefined;
        try {
          handle = await open(temporary, "wx", mode);
          await handle.writeFile(body, "utf8");
          await handle.sync();
          await handle.close();
          handle = undefined;
          await hooks.beforeRename?.(destination, temporary);
          await rename(temporary, destination);
          if (process.platform !== "win32") await chmod(destination, mode);
          await syncDirectory(directory);
        } finally {
          await handle?.close().catch(() => undefined);
          await unlink(temporary).catch((error) => {
            if (!isNotFound(error)) throw error;
          });
        }
      },
      catch: (error) => mapFsError(error, `Atomic write failed for ${destination}`),
    });
  });
}

export function readUtf8File(path: string): Effect.Effect<string, SetupStoreError> {
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (error) => {
      if (isNotFound(error)) {
        return storeError(`File not found: ${path}`, "not-found", error);
      }
      return mapFsError(error, `Failed to read ${path}`);
    },
  });
}

export function mkdirExclusive(directory: string): Effect.Effect<void, SetupStoreError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { mode: 0o700 });
    },
    catch: (error) => {
      if (hasCode(error, "EEXIST")) {
        return storeError(
          `Installation directory already exists at ${directory}. Refusing concurrent or duplicate initialization.`,
          "conflict",
          error,
        );
      }
      return mapFsError(error, `Failed to create directory ${directory}`);
    },
  });
}

export function removeDirectoryRecursive(directory: string): Effect.Effect<void, SetupStoreError> {
  return Effect.tryPromise({
    try: () => rm(directory, { force: true, recursive: true }),
    catch: (error) => mapFsError(error, `Failed to remove ${directory}`),
  });
}

export function pathExists(path: string): Effect.Effect<boolean, SetupStoreError> {
  return Effect.tryPromise({
    try: async () => {
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    catch: (error) => mapFsError(error, `Failed to stat ${path}`),
  });
}
