import { Effect } from "effect";

import { CancellationError, SetupCommandError, TerminalError } from "../errors.ts";
import { Terminal, type TerminalService } from "../terminal.ts";

export type PromptError = TerminalError | CancellationError | SetupCommandError;
export type PromptServices = TerminalService;

/** Optional validator: return an error message to retry, or null if OK. */
export type PromptValidate = (value: string) => string | null;

export function writeLine(message: string): Effect.Effect<void, TerminalError, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* Terminal;
    yield* terminal.writeOut(`${message}\n`);
  });
}

/**
 * Single prompt. Prefer `askUntil` for interactive flows that should recover from bad input.
 */
export function ask(
  message: string,
  allowEmpty = false,
): Effect.Effect<string, PromptError, PromptServices> {
  return Effect.gen(function* () {
    const terminal = yield* Terminal;
    const value = (yield* terminal.promptLine(message)).trim();
    if (!allowEmpty && value === "") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `A value is required for: ${message.trim()}`,
        }),
      );
    }
    return value;
  });
}

/**
 * Re-prompt until the value passes validation. Explains the problem and continues the wizard.
 */
export function askUntil(
  message: string,
  options: {
    readonly allowEmpty?: boolean;
    readonly validate?: PromptValidate;
    /** Shown once when empty and allowEmpty is false. */
    readonly emptyHint?: string;
  } = {},
): Effect.Effect<string, PromptError, PromptServices> {
  const allowEmpty = options.allowEmpty === true;
  const validate = options.validate;
  const emptyHint = options.emptyHint ?? "This value is required.";

  return Effect.gen(function* () {
    while (true) {
      const value = (yield* ask(message, true)).trim();
      if (value === "") {
        if (allowEmpty) return "";
        yield* writeLine(emptyHint);
        continue;
      }
      if (validate) {
        const problem = validate(value);
        if (problem != null) {
          yield* writeLine(problem);
          continue;
        }
      }
      return value;
    }
  });
}

export function askSecret(
  message: string,
  options: {
    readonly emptyHint?: string;
  } = {},
): Effect.Effect<string, PromptError, PromptServices> {
  const emptyHint = options.emptyHint ?? "A secret value is required.";
  return Effect.gen(function* () {
    const terminal = yield* Terminal;
    while (true) {
      const value = yield* terminal.promptSecret(message);
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed === "") {
        yield* writeLine(emptyHint);
        continue;
      }
      return trimmed;
    }
  });
}

export function askChoice(
  label: string,
  choices: readonly string[],
): Effect.Effect<string, PromptError, PromptServices> {
  const joined = choices.join("|");
  return Effect.gen(function* () {
    while (true) {
      const value = (yield* ask(`${label} (${joined}): `, true)).toLowerCase();
      if (value === "") {
        yield* writeLine(`Choose one of: ${choices.join(", ")}.`);
        continue;
      }
      if (!choices.includes(value)) {
        yield* writeLine(`“${value}” is not valid. Choose one of: ${choices.join(", ")}.`);
        continue;
      }
      return value;
    }
  });
}

export function askBoolean(
  label: string,
  defaultValue: boolean,
): Effect.Effect<boolean, PromptError, PromptServices> {
  return Effect.gen(function* () {
    const hint = defaultValue ? "Y/n" : "y/N";
    while (true) {
      const value = (yield* ask(`${label} [${hint}]: `, true)).toLowerCase();
      if (value === "") return defaultValue;
      if (["y", "yes"].includes(value)) return true;
      if (["n", "no"].includes(value)) return false;
      yield* writeLine("Please answer y or n.");
    }
  });
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export function looksLikeHostname(value: string): boolean {
  // Hostname only (no scheme/path). Labels separated by dots.
  if (value.length > 253 || value.includes("://") || value.includes("/") || value.includes(" ")) {
    return false;
  }
  return /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))*$/u.test(
    value,
  );
}
