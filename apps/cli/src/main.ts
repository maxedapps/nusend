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
  parseGlobalOptions,
  printError,
  selectedProfile,
  UsageError,
  type CommandContext,
} from "./commands/context.js";
import { helpText } from "./commands/help.js";
import { runLoginCommand } from "./commands/login.js";
import { runLogoutCommand } from "./commands/logout.js";
import { runMailingsCommand } from "./commands/mailings.js";
import { runWhoamiCommand } from "./commands/whoami.js";
import { loadConfig, resolveProfile } from "./config/profiles.js";
import { FileCredentialStore } from "./credentials/file-store.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

export type CliResult = { readonly exitCode: number };
export { printError };

export async function runCli(args: string[], env = process.env): Promise<CliResult> {
  const parsed = parseGlobalOptions(expandEqualsSyntax(args));
  if (parsed.rest.length === 0 || parsed.rest.includes("--help") || parsed.rest.includes("-h")) {
    console.log(helpText);
    return { exitCode: 0 };
  }
  if (parsed.rest[0] === "--version" || parsed.rest[0] === "-v") {
    console.log(VERSION);
    return { exitCode: 0 };
  }

  const [command, ...rest] = parsed.rest;
  if (!command || !knownCommands.has(command))
    throw new UsageError(`Unknown command: ${command}`, 2);

  const store = new FileCredentialStore(env);
  const config = await loadConfig(env);
  const baseContext: CommandContext = { config, env, options: parsed.options, store };

  if (command === "login") await runLoginCommand(rest, baseContext);
  else if (command === "config") await runConfigCommand(rest, baseContext);
  else if (command === "logout") {
    const unknown = rest.find((token) => token !== "--revoke");
    if (unknown) throw new UsageError(`Unknown logout option: ${unknown}`, 2);
    const profile = selectedProfile(baseContext);
    const credential = await store.read(profile);
    let api: NusendApi | undefined;
    let revokeSetupError: unknown;
    if (rest.includes("--revoke") && credential) {
      try {
        api = makeApi(
          resolveProfileForCli({ ...parsed.options, config, env }).baseUrl,
          credential.apiKey,
        );
      } catch (error) {
        revokeSetupError = error;
      }
    }
    await runLogoutCommand(rest, { ...baseContext, api }, revokeSetupError);
  } else {
    if (command === "whoami" && rest.length > 0) {
      throw new UsageError(`whoami takes no arguments: ${rest[0]}`, 2);
    }
    const known = subcommands[command];
    if (known && (!rest[0] || !known.has(rest[0]))) {
      throw new UsageError(
        rest[0] ? `Unknown ${command} command: ${rest[0]}` : `Unknown ${command} command.`,
        2,
      );
    }
    const profileName = selectedProfile(baseContext);
    const credential = await store.read(profileName);
    if (!credential) {
      throw new UsageError(
        "Authentication required. Run `nusend login <base-url>` or set NUSEND_API_KEY.",
        3,
      );
    }
    const profile = resolveProfileForCli({ ...parsed.options, config, env });
    const context = { ...baseContext, api: makeApi(profile.baseUrl, credential.apiKey) };
    if (command === "whoami") await runWhoamiCommand(context);
    else if (command === "api-keys") await runApiKeysCommand(rest, context);
    else if (command === "contacts") await runContactsCommand(rest, context);
    else if (command === "mailings") await runMailingsCommand(rest, context);
  }
  return { exitCode: 0 };
}

export async function runMain(args: string[], env = process.env): Promise<CliResult> {
  try {
    return await runCli(args, env);
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

function makeApi(baseUrl: string, apiKey: string): NusendApi {
  return new NusendApi(new NusendHttpClient({ apiKey, baseUrl }));
}

const knownCommands = new Set([
  "api-keys",
  "config",
  "contacts",
  "login",
  "logout",
  "mailings",
  "whoami",
]);

const subcommands: Record<string, ReadonlySet<string>> = {
  "api-keys": new Set(["create", "list", "revoke", "rotate"]),
  contacts: new Set(["create", "delete", "get", "list", "update"]),
  mailings: new Set(["get", "list"]),
};

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
  runMain(process.argv.slice(2)).then(({ exitCode }) => process.exit(exitCode));
}
