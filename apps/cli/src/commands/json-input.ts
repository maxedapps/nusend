import { readFile } from "node:fs/promises";
import { stdin as defaultStdin } from "node:process";

import { UsageError } from "./context.js";

export type JsonFileSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "stdin" };

export type JsonInputDependencies = {
  readonly readStdin?: () => Promise<string>;
  readonly readTextFile?: (path: string) => Promise<string>;
};

export async function loadJsonInput(
  source: JsonFileSource,
  deps: JsonInputDependencies = {},
): Promise<unknown> {
  const text = await readJsonText(source, deps);
  if (text.trim() === "") {
    throw new UsageError(
      source.kind === "stdin"
        ? "JSON input from stdin is empty."
        : `JSON file is empty: ${source.path}`,
      2,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UsageError(
      source.kind === "stdin"
        ? "JSON input from stdin is malformed."
        : `JSON file is malformed: ${source.path}`,
      2,
    );
  }
}

async function readJsonText(source: JsonFileSource, deps: JsonInputDependencies): Promise<string> {
  if (source.kind === "stdin") {
    return (deps.readStdin ?? readStdinText)();
  }

  const readTextFile = deps.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  try {
    return await readTextFile(source.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Unable to read JSON file ${source.path}: ${detail}`, 2);
  }
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    defaultStdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    defaultStdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    defaultStdin.on("error", reject);
    defaultStdin.resume();
  });
}
