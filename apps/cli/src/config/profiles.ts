import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Schema } from "effect";

import { configPath, type PathEnvironment } from "./paths.js";

export const ConfigFileSchema = Schema.Struct({
  activeProfile: Schema.optional(Schema.String),
  profiles: Schema.optional(
    Schema.Record(Schema.String, Schema.Struct({ baseUrl: Schema.String })),
  ),
});

export type ConfigFile = typeof ConfigFileSchema.Type;

export async function loadConfig(env: PathEnvironment = process.env): Promise<ConfigFile> {
  try {
    const raw = await readFile(configPath(env), "utf8");
    return Schema.decodeUnknownSync(ConfigFileSchema)(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return { profiles: {} };
    throw error;
  }
}

export async function saveConfig(
  config: ConfigFile,
  env: PathEnvironment = process.env,
): Promise<void> {
  const path = configPath(env);
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
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
  if (!/^\/+$/.test(url.pathname)) {
    throw new Error(
      `Base URL must not include a path (got ${url.pathname}). Deploy Nusend at a domain root, e.g. https://nusend.example.com.`,
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
