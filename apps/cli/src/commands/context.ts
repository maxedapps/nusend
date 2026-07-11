import { Result } from "effect";
import {
  normalizePermissions,
  parsePermission,
  type PermissionSet,
} from "@nusend/api-contract/permissions";

import { CliHttpError } from "../client/errors.js";
import { parseHttpTimeoutMs } from "../client/http.js";
import type { NusendApi } from "../client/nusend-api.js";
import type { ConfigFile } from "../config/profiles.js";
import type { FileCredentialStore } from "../credentials/file-store.js";

export const globalOptionRegistry = {
  "--base-url": { repeatable: false, takesValue: true },
  "--json": { repeatable: false, takesValue: false },
  "--profile": { repeatable: false, takesValue: true },
} as const;

export type GlobalOptions = {
  readonly baseUrl?: string;
  readonly json: boolean;
  readonly profile?: string;
};

export type CommandContext = {
  readonly api?: NusendApi;
  readonly config: ConfigFile;
  readonly env: NodeJS.ProcessEnv;
  readonly options: GlobalOptions;
  readonly store: FileCredentialStore;
};

export class UsageError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

export function requireApi(context: CommandContext): NusendApi {
  if (!context.api) throw new Error("Command API client was not configured.");
  return context.api;
}

export function parseGlobalOptions(args: string[]): {
  readonly options: GlobalOptions;
  readonly rest: string[];
} {
  const rest: string[] = [];
  const counts = new Map<string, number>();
  let baseUrl: string | undefined;
  let profile: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const definition = globalOptionRegistry[arg as keyof typeof globalOptionRegistry];
    if (!definition) {
      rest.push(arg);
      continue;
    }
    const count = (counts.get(arg) ?? 0) + 1;
    counts.set(arg, count);
    if (count > 1 && !definition.repeatable) {
      throw new UsageError(`Duplicate option: ${arg}`, 2);
    }
    if (arg === "--json") json = true;
    else if (arg === "--base-url") baseUrl = globalOptionValue(args, ++index, arg);
    else if (arg === "--profile") profile = globalOptionValue(args, ++index, arg);
  }
  return { options: { baseUrl, json, profile }, rest };
}

function globalOptionValue(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${name} requires a value.`, 2);
  }
  return value;
}

export function httpTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const parsed = parseHttpTimeoutMs(env.NUSEND_HTTP_TIMEOUT_MS);
  if (Result.isFailure(parsed)) throw new UsageError(parsed.failure, 2);
  return parsed.success;
}

export function selectedProfile(context: CommandContext): string {
  return (
    context.options.profile ??
    context.env.NUSEND_PROFILE ??
    context.config.activeProfile ??
    "default"
  );
}

export function commandPositionals(args: string[], valueOptions: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

export function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`Missing value for ${name}.`, 2);
  }
  return value;
}

export function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`Missing value for ${name}.`, 2);
    }
    values.push(value);
    index += 1;
  }
  return values;
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof UsageError) return error.exitCode;
  if (error instanceof CliHttpError) return error.status === 401 ? 3 : 4;
  return 1;
}

export function printError(error: unknown, json: boolean): void {
  const normalized = normalizeError(error);
  if (json) {
    console.error(
      JSON.stringify({ error: { code: normalized.code, message: normalized.message } }),
    );
    return;
  }

  console.error(`Error: ${normalized.message}`);
  if (normalized.hint) console.error(`Hint: ${normalized.hint}`);
}

function normalizeError(error: unknown): { code: string; hint?: string; message: string } {
  if (error instanceof UsageError) {
    return {
      code: error.exitCode === 3 ? "unauthenticated" : "usage",
      hint: error.message.startsWith("Authentication required")
        ? "Run `nusend login <base-url>` or set NUSEND_API_KEY."
        : undefined,
      message: error.message,
    };
  }
  if (error instanceof CliHttpError) {
    return {
      code: error.code,
      hint:
        error.status === 401 ? "Run `nusend login <base-url>` or set NUSEND_API_KEY." : undefined,
      message: error.message,
    };
  }
  return {
    code: "internal_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function permissionsFromArgs(args: string[], fallback: PermissionSet = {}): PermissionSet {
  const values = optionValues(args, "--permission");
  if (values.length === 0) return fallback;
  const permissions: Record<string, string[]> = {};
  for (const value of values) {
    const parsed = parsePermission(value);
    if (!parsed) throw new UsageError(`Invalid permission: ${value}`, 2);
    permissions[parsed.resource] = [...(permissions[parsed.resource] ?? []), parsed.action];
  }
  return normalizePermissions(permissions);
}
