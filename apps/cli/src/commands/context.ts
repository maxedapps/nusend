import { Result } from "effect";

import { CliHttpError } from "../client/errors.js";
import { parseHttpTimeoutMs } from "../client/http.js";
import type { NusendApi } from "../client/nusend-api.js";

export type CliRuntimeDependencies = {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
};

export type CommandContext = {
  readonly api?: NusendApi;
  readonly env: NodeJS.ProcessEnv;
  readonly json: boolean;
  readonly runtime: CliRuntimeDependencies;
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

export function httpTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const parsed = parseHttpTimeoutMs(env.NUSEND_HTTP_TIMEOUT_MS);
  if (Result.isFailure(parsed)) throw new UsageError(parsed.failure, 2);
  return parsed.success;
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
