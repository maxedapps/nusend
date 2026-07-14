import { homedir, platform } from "node:os";
import { join } from "node:path";

export type PathEnvironment = Partial<Record<string, string | undefined>>;

export function configDirectory(
  env: PathEnvironment = process.env,
  platformName = platform(),
): string {
  if (platformName === "win32") {
    return join(env.APPDATA ?? env.LOCALAPPDATA ?? join(homedir(), "AppData", "Roaming"), "Nusend");
  }

  return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "nusend");
}

export function configPath(env: PathEnvironment = process.env): string {
  return join(configDirectory(env), "config.json");
}

export function credentialsPath(env: PathEnvironment = process.env): string {
  return join(configDirectory(env), "credentials.json");
}

export function localStateLockPath(env: PathEnvironment = process.env): string {
  return join(configDirectory(env), "local-state.lock");
}

export function localStateReaperMutexPath(env: PathEnvironment = process.env): string {
  return join(configDirectory(env), "local-state-reaper");
}
