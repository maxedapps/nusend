import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOY_PLAN_KEY = "human_gates";
export const DEPLOY_PLAN_STORE_KEY = "deploy";
export const PUBLIC_REPO_URL = "https://github.com/maxedapps/nusend.git";
export const PUBLIC_REPO_ORIGINS = Object.freeze([
  "https://github.com/maxedapps/nusend.git",
  "https://github.com/maxedapps/nusend",
  "git@github.com:maxedapps/nusend.git",
  "git@github.com:maxedapps/nusend",
  "ssh://git@github.com/maxedapps/nusend.git",
  "ssh://git@github.com/maxedapps/nusend",
]);
export const APP_IMAGE_REPOSITORY = "ghcr.io/maxedapps/nusend";
export const BACKUP_IMAGE_REPOSITORY = "ghcr.io/maxedapps/nusend-backup";
export const OCI_REVISION_LABEL = "org.opencontainers.image.revision";
export const DEPLOY_PHRASE_PREFIX = "DEPLOY";
export const REQUIRED_COMPOSE_MAJOR = 5;
export const REQUIRED_COMPOSE_MINOR = 3;
export const SUPPORTED_ARCHITECTURES = Object.freeze(["x86_64", "amd64", "aarch64", "arm64"]);
export const REQUIRED_SERVICES = Object.freeze(["api", "worker", "caddy", "backup"]);

export const APPLY_CHECKPOINT_CLONED = "cloned";
export const APPLY_CHECKPOINT_ENV = "env_transferred";
export const APPLY_CHECKPOINT_CONFIG = "compose_config";
export const APPLY_CHECKPOINT_PULLED = "pulled";
export const APPLY_CHECKPOINT_IMAGES = "images_verified";
export const APPLY_CHECKPOINT_UP = "up";
export const APPLY_CHECKPOINT_HEALTHY = "healthy";

/** Repo-root compose.yaml (apps/setup-cli/src/deploy → ../../../../compose.yaml). */
export function defaultLocalComposePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "compose.yaml");
}

export const LOCAL_COMPOSE_PATH = defaultLocalComposePath();
