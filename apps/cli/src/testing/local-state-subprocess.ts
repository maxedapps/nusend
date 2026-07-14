import { access, writeFile } from "node:fs/promises";

import {
  updateConfig,
  updateCredentials,
  updateLoginState,
  type LocalStateMutationHooks,
} from "../config/local-state.js";

const [operation, root, identity, attemptedPath, acquiredPath, releasePath, contendedPath] =
  process.argv.slice(2);
if (!operation || !root || !identity || !attemptedPath) {
  throw new Error("Missing local-state subprocess arguments.");
}

const env = { XDG_CONFIG_HOME: root };
await writeFile(attemptedPath, identity);

const hooks: LocalStateMutationHooks | undefined =
  acquiredPath || contendedPath
    ? {
        afterLockAcquired: acquiredPath
          ? async () => {
              await writeFile(acquiredPath, identity);
              if (releasePath) await waitForFile(releasePath, 5_000);
            }
          : undefined,
        afterLockContention: contendedPath
          ? async () => {
              await writeFile(contendedPath, identity);
            }
          : undefined,
      }
    : undefined;

if (operation === "profiles") {
  await updateConfig(
    (current) => ({
      ...current,
      profiles: {
        ...(current.profiles ?? {}),
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `${identity}-${index}`,
            { baseUrl: `https://${identity}-${index}.example.com` },
          ]),
        ),
      },
    }),
    env,
    hooks,
  );
} else if (operation === "credentials") {
  await updateCredentials(
    (current) => ({
      credentials: {
        ...(current.credentials ?? {}),
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `${identity}-${index}`,
            { apiKey: `nusend_${identity}_${index}` },
          ]),
        ),
      },
    }),
    env,
    hooks,
  );
} else if (operation === "login") {
  await updateLoginState(
    {
      baseUrl: `https://${identity}.example.com`,
      credential: { apiKey: `nusend_${identity}` },
      profile: "shared",
    },
    env,
    hooks,
  );
} else {
  throw new Error(`Unknown operation: ${operation}`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded polling coordinates real processes.
      await access(path);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling coordinates real processes.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
