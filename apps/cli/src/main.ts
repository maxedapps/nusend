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
  printError,
  UsageError,
  type CliRuntimeDependencies,
  type CommandContext,
} from "./commands/context.js";
import { helpText } from "./commands/help.js";
import { runLoginCommand } from "./commands/login.js";
import { runLogoutCommand } from "./commands/logout.js";
import { runMailingsCommand } from "./commands/mailings.js";
import { parseCliCommand, type CliCommand } from "./commands/options.js";
import { runWhoamiCommand } from "./commands/whoami.js";
import { loadLocalState, normalizeBaseUrl, type LocalState } from "./config/local-state.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

export type CliResult = { readonly exitCode: number };
export { printError };

const defaultRuntimeDependencies: CliRuntimeDependencies = {
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

type ExecutableCommand = Exclude<CliCommand, { readonly kind: "help" | "version" }>;

export async function runCli(
  args: readonly string[],
  env = process.env,
  runtime: CliRuntimeDependencies = defaultRuntimeDependencies,
): Promise<CliResult> {
  const command = parseCliCommand(args);
  if (command.kind === "help") {
    console.log(helpText);
    return { exitCode: 0 };
  }
  if (command.kind === "version") {
    console.log(VERSION);
    return { exitCode: 0 };
  }

  const baseContext: CommandContext = { env, json: command.json, runtime };
  if (command.kind === "login") {
    await runLoginCommand(command, baseContext);
    return { exitCode: 0 };
  }
  if (command.kind === "config-repair-permissions") {
    await runConfigCommand(baseContext);
    return { exitCode: 0 };
  }
  if (command.kind === "logout") {
    await runLogout(command, baseContext);
    return { exitCode: 0 };
  }

  const context = await authenticatedContext(command, baseContext);
  switch (command.kind) {
    case "whoami":
      await runWhoamiCommand(context);
      break;
    case "api-keys-list":
    case "api-keys-create":
    case "api-keys-revoke":
    case "api-keys-rotate":
      await runApiKeysCommand(command, context);
      break;
    case "contacts-list":
    case "contacts-get":
    case "contacts-create":
    case "contacts-update":
    case "contacts-delete":
      await runContactsCommand(command, context);
      break;
    case "mailings-list":
    case "mailings-get":
      await runMailingsCommand(command, context);
      break;
  }
  return { exitCode: 0 };
}

async function runLogout(
  command: Extract<CliCommand, { kind: "logout" }>,
  context: CommandContext,
) {
  if (context.env.NUSEND_API_KEY) {
    if (command.revoke) httpTimeoutMsFromEnv(context.env);
    await runLogoutCommand(command, context);
    return;
  }

  const state = await loadLocalState(context.env);
  let api: NusendApi | undefined;
  let revokeSetupError: unknown;
  if (command.revoke && state.credential) {
    httpTimeoutMsFromEnv(context.env);
    try {
      api = makeApi(
        resolveBaseUrl(command, context.env, state),
        state.credential.apiKey,
        context.env,
      );
    } catch (error) {
      revokeSetupError = error;
    }
  }
  await runLogoutCommand(command, { ...context, api }, state, revokeSetupError);
}

async function authenticatedContext(
  command: ExecutableCommand,
  context: CommandContext,
): Promise<CommandContext> {
  const environmentKey = context.env.NUSEND_API_KEY;
  const explicitBaseUrl = command.baseUrl ?? context.env.NUSEND_BASE_URL;
  const state = environmentKey && explicitBaseUrl ? {} : await loadLocalState(context.env);
  const apiKey = environmentKey ?? state.credential?.apiKey;
  if (!apiKey) {
    throw new UsageError(
      "Authentication required. Run `nusend login <base-url>` or set NUSEND_API_KEY.",
      3,
    );
  }
  return {
    ...context,
    api: makeApi(resolveBaseUrl(command, context.env, state), apiKey, context.env),
  };
}

function resolveBaseUrl(
  command: { readonly baseUrl?: string },
  env: NodeJS.ProcessEnv,
  state: LocalState,
): string {
  const value = command.baseUrl ?? env.NUSEND_BASE_URL ?? state.baseUrl;
  if (!value) {
    throw new UsageError(
      "Missing Nusend base URL. Run `nusend login <base-url>` or pass --base-url.",
      2,
    );
  }
  try {
    return normalizeBaseUrl(value);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid base URL.", 2);
  }
}

export async function runMain(
  args: readonly string[],
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

function makeApi(baseUrl: string, apiKey: string, env: NodeJS.ProcessEnv): NusendApi {
  return new NusendApi(
    new NusendHttpClient({ apiKey, baseUrl, timeoutMs: httpTimeoutMsFromEnv(env) }),
  );
}

if (isMainEntry(process.argv[1], import.meta.url)) {
  runMain(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
