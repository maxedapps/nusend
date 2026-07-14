import { ConfigFileSchema, loadConfigFile, updateConfig, type ConfigFile } from "./local-state.js";
import type { PathEnvironment } from "./paths.js";

export { ConfigFileSchema, updateConfig, type ConfigFile };

export async function loadConfig(env: PathEnvironment = process.env): Promise<ConfigFile> {
  return loadConfigFile(env);
}

export function resolveProfile(input: {
  readonly baseUrl?: string;
  readonly config: ConfigFile;
  readonly env?: PathEnvironment;
  readonly profile?: string;
}): { baseUrl: string; profile: string } {
  const env = input.env ?? process.env;
  const profile = input.profile ?? env.NUSEND_PROFILE ?? input.config.activeProfile ?? "default";
  const baseUrl = input.baseUrl ?? env.NUSEND_BASE_URL ?? input.config.profiles?.[profile]?.baseUrl;
  if (!baseUrl)
    throw new Error("Missing Nusend base URL. Run `nusend login <base-url>` or pass --base-url.");
  return { baseUrl: normalizeBaseUrl(baseUrl), profile };
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Base URL must be http(s).");
  if (!/^\/+$/u.test(url.pathname)) {
    throw new Error(
      `Base URL must not include a path (got ${url.pathname}). Deploy Nusend at a domain root, e.g. https://nusend.example.com.`,
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/u, "");
}
