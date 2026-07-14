#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { NusendHttpClient } from "./client/http.js";
import { NusendApi } from "./client/nusend-api.js";
import { runApiKeysCommand } from "./commands/api-keys.js";
import { runConfigCommand } from "./commands/config.js";
import { runContactsCommand } from "./commands/contacts.js";
import {
  exitCodeForError,
  httpTimeoutMsFromEnv,
  parseGlobalOptions,
  printError,
  selectedProfile,
  UsageError,
  type CliRuntimeDependencies,
  type CommandContext,
} from "./commands/context.js";
import { helpText } from "./commands/help.js";
import { runLoginCommand } from "./commands/login.js";
import { runLogoutCommand } from "./commands/logout.js";
import { runMailingsCommand } from "./commands/mailings.js";
import { runWhoamiCommand } from "./commands/whoami.js";
import { validateCommandGrammar } from "./commands/options.js";
import { loadLocalStateSnapshot } from "./config/local-state.js";
import { loadConfig, resolveProfile } from "./config/profiles.js";
import { FileCredentialStore } from "./credentials/file-store.js";
import type { StoredCredential } from "./credentials/store.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

export type CliResult = { readonly exitCode: number };
export { printError };

const defaultRuntimeDependencies: CliRuntimeDependencies = {
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function runCli(
  args: string[],
  env = process.env,
  runtime: CliRuntimeDependencies = defaultRuntimeDependencies,
): Promise<CliResult> {
  const parsed = parseGlobalOptions(expandEqualsSyntax(args));
  const helpCount = parsed.rest.filter((token) => token === "--help" || token === "-h").length;
  const versionCount = parsed.rest.filter(
    (token) => token === "--version" || token === "-v",
  ).length;
  if (helpCount > 1) throw new UsageError("Duplicate option: --help", 2);
  if (versionCount > 1) throw new UsageError("Duplicate option: --version", 2);
  if (helpCount > 0 && versionCount > 0) {
    throw new UsageError("--help and --version cannot be combined.", 2);
  }
  if (parsed.rest.length === 0 || helpCount === 1) {
    console.log(helpText);
    return { exitCode: 0 };
  }
  if (parsed.rest[0] === "--version" || parsed.rest[0] === "-v") {
    console.log(VERSION);
    return { exitCode: 0 };
  }

  validateCommandGrammar(parsed.rest);
  const [command, ...rest] = parsed.rest;
  const store = new FileCredentialStore(env);

  // Login and config repair are local setup commands. They neither need nor
  // should wait for an authenticated config/credential snapshot.
  if (command === "login" || command === "config") {
    const config = await loadConfig(env);
    const context: CommandContext = { config, env, options: parsed.options, runtime, store };
    if (command === "login") await runLoginCommand(rest, context);
    else await runConfigCommand(rest, context);
    return { exitCode: 0 };
  }

  // An environment credential has explicit precedence and does not participate
  // in the two-file login commit, so preserve its file-store bypass behavior.
  if (env.NUSEND_API_KEY) {
    const config = await loadConfig(env);
    const baseContext: CommandContext = { config, env, options: parsed.options, runtime, store };
    if (command === "logout") {
      const unknown = rest.find((token) => token !== "--revoke");
      if (unknown) throw new UsageError(`Unknown logout option: ${unknown}`, 2);
      if (rest.includes("--revoke")) httpTimeoutMsFromEnv(env);
      await runLogoutCommand(rest, baseContext);
      return { exitCode: 0 };
    }
    const profile = resolveProfileForCli({ ...parsed.options, config, env });
    const context = {
      ...baseContext,
      api: makeApi(profile.baseUrl, env.NUSEND_API_KEY, env),
    };
    if (command === "whoami") await runWhoamiCommand(context);
    else if (command === "api-keys") await runApiKeysCommand(rest, context);
    else if (command === "contacts") await runContactsCommand(rest, context);
    else if (command === "mailings") await runMailingsCommand(rest, context);
    return { exitCode: 0 };
  }

  // The lock is released before API construction or network work. Reading both
  // files in one critical section prevents pairing a newly-renamed credential
  // with the previous profile URL during login's intentional two-file commit.
  const snapshot = await loadLocalStateSnapshot(env, {
    afterLockContention: runtime.afterLocalStateContention,
  });
  const baseContext: CommandContext = {
    config: snapshot.config,
    env,
    options: parsed.options,
    runtime,
    store,
  };
  const profileName = selectedProfile(baseContext);
  const fileCredential = snapshot.credentials.credentials?.[profileName] ?? null;
  const credential: StoredCredential | null = fileCredential;

  if (command === "logout") {
    const unknown = rest.find((token) => token !== "--revoke");
    if (unknown) throw new UsageError(`Unknown logout option: ${unknown}`, 2);
    let api: NusendApi | undefined;
    let revokeSetupError: unknown;
    if (rest.includes("--revoke") && credential) {
      // Validate the shared HTTP timeout outside best-effort revoke setup so an
      // invalid CLI environment remains a usage error instead of being swallowed.
      httpTimeoutMsFromEnv(env);
      try {
        api = makeApi(
          resolveProfileForCli({ ...parsed.options, config: snapshot.config, env }).baseUrl,
          credential.apiKey,
          env,
        );
      } catch (error) {
        revokeSetupError = error;
      }
    }
    await runLogoutCommand(rest, { ...baseContext, api }, revokeSetupError, {
      credential,
      storedCredentialKept: fileCredential !== null,
    });
    return { exitCode: 0 };
  }

  if (!credential) {
    throw new UsageError(
      "Authentication required. Run `nusend login <base-url>` or set NUSEND_API_KEY.",
      3,
    );
  }
  const profile = resolveProfileForCli({ ...parsed.options, config: snapshot.config, env });
  const context = { ...baseContext, api: makeApi(profile.baseUrl, credential.apiKey, env) };
  if (command === "whoami") await runWhoamiCommand(context);
  else if (command === "api-keys") await runApiKeysCommand(rest, context);
  else if (command === "contacts") await runContactsCommand(rest, context);
  else if (command === "mailings") await runMailingsCommand(rest, context);
  return { exitCode: 0 };
}

export async function runMain(
  args: string[],
  env = process.env,
  runtime: CliRuntimeDependencies = defaultRuntimeDependencies,
): Promise<CliResult> {
  try {
    return await runCli(args, env, runtime);
  } catch (error) {
    const exitCode = exitCodeForError(error);
    printError(
      error,
      args.some((arg) => arg === "--json" || arg.startsWith("--json=")),
    );
    return { exitCode };
  }
}

export function isMainEntry(argv1: string | undefined, importMetaUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === importMetaUrl;
  } catch {
    return pathToFileURL(argv1).href === importMetaUrl;
  }
}

function resolveProfileForCli(
  input: Parameters<typeof resolveProfile>[0],
): ReturnType<typeof resolveProfile> {
  try {
    return resolveProfile(input);
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : "Invalid profile configuration.",
      2,
    );
  }
}

function makeApi(baseUrl: string, apiKey: string, env: NodeJS.ProcessEnv): NusendApi {
  return new NusendApi(
    new NusendHttpClient({ apiKey, baseUrl, timeoutMs: httpTimeoutMsFromEnv(env) }),
  );
}

const booleanOptions = new Set(["--help", "--json", "--no-expiry", "--revoke", "--version"]);

function expandEqualsSyntax(args: string[]): string[] {
  const expanded: string[] = [];
  for (const arg of args) {
    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (separator < 0) {
      expanded.push(arg);
      continue;
    }
    const name = arg.slice(0, separator);
    if (booleanOptions.has(name)) throw new UsageError(`${name} does not take a value.`, 2);
    const value = arg.slice(separator + 1);
    if (value === "") throw new UsageError(`${name} requires a value.`, 2);
    expanded.push(name, value);
  }
  return expanded;
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  // Set exitCode and let the process exit naturally instead of process.exit(),
  // which discards buffered stdout writes and truncates large piped --json output.
  runMain(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
