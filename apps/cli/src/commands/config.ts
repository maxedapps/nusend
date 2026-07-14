import { chmod, mkdir } from "node:fs/promises";

import { withLocalStateLock } from "../config/local-state.js";
import { configDirectory, configPath, credentialsPath } from "../config/paths.js";
import { printJson } from "../output/format.js";
import { UsageError, type CommandContext } from "./context.js";

export async function runConfigCommand(
  args: string[],
  context: CommandContext,
  platformName = process.platform,
): Promise<void> {
  if (args[0] !== "repair-permissions") {
    throw new UsageError("Unknown config command.", 2);
  }

  if (platformName === "win32") {
    if (context.options.json) printJson({ applicable: false, platform: "win32" });
    else console.log("Permission repair is not applicable on Windows.");
    return;
  }

  await withLocalStateLock(context.env, async () => {
    const directory = configDirectory(context.env);
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    await chmodIfPresent(configPath(context.env), 0o600);
    await chmodIfPresent(credentialsPath(context.env), 0o600);
  });

  if (context.options.json) printJson({ repaired: true });
  else console.log("Repaired Nusend config permissions.");
}

async function chmodIfPresent(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
