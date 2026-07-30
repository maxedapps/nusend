import { createInterface } from "node:readline";

import { Context, Effect, Layer } from "effect";

import { CancellationError, TerminalError } from "./errors.ts";

export interface TerminalService {
  readonly writeOut: (text: string) => Effect.Effect<void, TerminalError>;
  readonly writeErr: (text: string) => Effect.Effect<void, TerminalError>;
  readonly promptLine: (
    message: string,
  ) => Effect.Effect<string, TerminalError | CancellationError>;
  /** Secret prompt; live layer avoids echo on TTY. Never log the returned value. */
  readonly promptSecret: (
    message: string,
  ) => Effect.Effect<string, TerminalError | CancellationError>;
}

export const Terminal = Context.Service<TerminalService>("nusend/setup/Terminal");

function isAbortError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  return name === "AbortError" || code === "ABORT_ERR";
}

function mapPromptFailure(operation: string, cause: unknown): TerminalError | CancellationError {
  if (isAbortError(cause)) {
    return new CancellationError({ message: "Prompt cancelled." });
  }
  if (cause instanceof CancellationError || cause instanceof TerminalError) {
    return cause;
  }
  return new TerminalError({
    operation,
    message: `Failed to read ${operation} input.`,
    cause,
  });
}

function readSilentLine(input: NodeJS.ReadStream, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const wasRaw = input.isRaw;
    const chars: string[] = [];
    const onAbort = () => {
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          resolve(chars.join(""));
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          reject(new CancellationError({ message: "Prompt cancelled." }));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          chars.pop();
          continue;
        }
        chars.push(ch);
      }
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      input.off("data", onData);
      if (typeof input.setRawMode === "function") input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    input.setEncoding("utf8");
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function promptWithReadline(message: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });

    const onAbort = () => {
      rl.close();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    rl.question(message, (answer) => {
      signal.removeEventListener("abort", onAbort);
      rl.close();
      resolve(answer);
    });
  });
}

function makeLiveTerminal(): TerminalService {
  return {
    writeOut: (text) =>
      Effect.try({
        try: () => {
          process.stdout.write(text);
        },
        catch: (cause) =>
          new TerminalError({
            operation: "writeOut",
            message: "Failed to write to stdout.",
            cause,
          }),
      }),
    writeErr: (text) =>
      Effect.try({
        try: () => {
          process.stderr.write(text);
        },
        catch: (cause) =>
          new TerminalError({
            operation: "writeErr",
            message: "Failed to write to stderr.",
            cause,
          }),
      }),
    promptLine: (message) =>
      Effect.tryPromise({
        try: (signal) => promptWithReadline(message, signal),
        catch: (cause) => mapPromptFailure("promptLine", cause),
      }),
    promptSecret: (message) =>
      Effect.tryPromise({
        try: async (signal) => {
          const input = process.stdin;
          const output = process.stdout;
          if (typeof input.setRawMode === "function" && input.isTTY) {
            output.write(message);
            const value = await readSilentLine(input, signal);
            output.write("\n");
            return value;
          }
          return promptWithReadline(message, signal);
        },
        catch: (cause) => mapPromptFailure("promptSecret", cause),
      }),
  };
}

export const TerminalLive: Layer.Layer<TerminalService> =
  Layer.succeed(Terminal)(makeLiveTerminal());

export type TerminalFakeState = {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly prompts: string[];
  readonly secretPrompts: string[];
};

export type TerminalFakeOptions = {
  readonly answers?: readonly string[];
  readonly secretAnswers?: readonly string[];
};

export function TerminalFake(options: TerminalFakeOptions = {}): {
  readonly layer: Layer.Layer<TerminalService>;
  readonly state: TerminalFakeState;
} {
  const answers = [...(options.answers ?? [])];
  const secretAnswers = [...(options.secretAnswers ?? options.answers ?? [])];
  const state: TerminalFakeState = {
    stdout: [],
    stderr: [],
    prompts: [],
    secretPrompts: [],
  };

  const takeAnswer = (
    operation: "promptLine" | "promptSecret",
    message: string,
    pool: string[],
  ): Effect.Effect<string, TerminalError> =>
    Effect.gen(function* () {
      if (operation === "promptSecret") state.secretPrompts.push(message);
      else state.prompts.push(message);
      const next = pool.shift();
      if (next === undefined) {
        return yield* Effect.fail(
          new TerminalError({
            operation,
            message: `TerminalFake has no remaining scripted answers for ${operation}.`,
          }),
        );
      }
      return next;
    });

  const service: TerminalService = {
    writeOut: (text) =>
      Effect.sync(() => {
        state.stdout.push(text);
      }),
    writeErr: (text) =>
      Effect.sync(() => {
        state.stderr.push(text);
      }),
    promptLine: (message) => takeAnswer("promptLine", message, answers),
    promptSecret: (message) => takeAnswer("promptSecret", message, secretAnswers),
  };

  return {
    layer: Layer.succeed(Terminal)(service),
    state,
  };
}
