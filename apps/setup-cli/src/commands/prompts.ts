import { Effect } from "effect";

import { CancellationError, SetupCommandError, TerminalError } from "../errors.ts";
import { Terminal, type TerminalService } from "../terminal.ts";

export function writeLine(message: string): Effect.Effect<void, TerminalError, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* Terminal;
    yield* terminal.writeOut(`${message}\n`);
  });
}

export function ask(
  message: string,
  allowEmpty = false,
): Effect.Effect<string, TerminalError | CancellationError | SetupCommandError, TerminalService> {
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

export function askSecret(
  message: string,
): Effect.Effect<string, TerminalError | CancellationError | SetupCommandError, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* Terminal;
    const value = yield* terminal.promptSecret(message);
    if (typeof value !== "string" || value.trim() === "") {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `A secret value is required for: ${message.trim()}`,
        }),
      );
    }
    return value.trim();
  });
}

export function askChoice(
  label: string,
  choices: readonly string[],
): Effect.Effect<string, TerminalError | CancellationError | SetupCommandError, TerminalService> {
  return Effect.gen(function* () {
    const value = (yield* ask(`${label} (${choices.join("|")}): `)).toLowerCase();
    if (!choices.includes(value)) {
      return yield* Effect.fail(
        new SetupCommandError({
          message: `Expected one of: ${choices.join(", ")}.`,
        }),
      );
    }
    return value;
  });
}

export function askBoolean(
  label: string,
  defaultValue: boolean,
): Effect.Effect<boolean, TerminalError | CancellationError | SetupCommandError, TerminalService> {
  return Effect.gen(function* () {
    const hint = defaultValue ? "Y/n" : "y/N";
    const value = (yield* ask(`${label} [${hint}]: `, true)).toLowerCase();
    if (value === "") return defaultValue;
    if (["y", "yes"].includes(value)) return true;
    if (["n", "no"].includes(value)) return false;
    return yield* Effect.fail(
      new SetupCommandError({
        message: "Please answer yes or no.",
      }),
    );
  });
}
