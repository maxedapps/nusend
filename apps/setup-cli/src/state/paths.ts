import { homedir } from "node:os";
import { join } from "node:path";

import {
  CURRENT_POINTER_NAME,
  ENV_FILE_NAME,
  INSTALLATION_ID_PATTERN,
  PROVISIONER_POLICY_FILE_NAME,
  STATE_FILE_NAME,
} from "./constants.ts";

export type PathEnvironment = Partial<Record<string, string | undefined>>;

export function setupHome(env: PathEnvironment = process.env): string {
  const override = env.NUSEND_SETUP_HOME?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || homedir();
  return join(home, ".config", "nusend", "setup");
}

export function assertInstallationId(installationId: string): string {
  if (
    typeof installationId !== "string" ||
    !INSTALLATION_ID_PATTERN.test(installationId) ||
    installationId === CURRENT_POINTER_NAME
  ) {
    throw new Error(
      `Invalid installation id "${installationId}". Use a conservative slug: lowercase letter, then 0-30 lowercase letters, digits, or hyphens (max 31 characters).`,
    );
  }
  return installationId;
}

export function installationDirectory(
  installationId: string,
  env: PathEnvironment = process.env,
): string {
  return join(setupHome(env), assertInstallationId(installationId));
}

export function stateFilePath(installationId: string, env: PathEnvironment = process.env): string {
  return join(installationDirectory(installationId, env), STATE_FILE_NAME);
}

export function envFilePath(installationId: string, env: PathEnvironment = process.env): string {
  return join(installationDirectory(installationId, env), ENV_FILE_NAME);
}

export function policyArtifactPath(
  installationId: string,
  env: PathEnvironment = process.env,
): string {
  return join(installationDirectory(installationId, env), PROVISIONER_POLICY_FILE_NAME);
}

export function currentPointerPath(env: PathEnvironment = process.env): string {
  return join(setupHome(env), CURRENT_POINTER_NAME);
}
