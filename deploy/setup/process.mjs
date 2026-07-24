import { spawn } from "node:child_process";

/**
 * @typedef {object} RunProcessOptions
 * @property {string} command
 * @property {readonly string[]} [args]
 * @property {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @property {string} [cwd]
 * @property {string} [stdin]
 * @property {AbortSignal} [signal]
 * @property {readonly string[]} [redact]
 * @property {boolean} [allowNonZero]
 */

/**
 * @typedef {object} RunProcessResult
 * @property {number | null} exitCode
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {readonly string[]} argv
 */

/**
 * @param {string} text
 * @param {readonly string[]} [secrets]
 */
export function redactText(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Run a subprocess with argv arrays only (no shell).
 * Propagates exit codes and termination signals. Never logs secrets.
 *
 * @param {RunProcessOptions} options
 * @returns {Promise<RunProcessResult>}
 */
export function runProcess(options) {
  const command = options.command;
  if (typeof command !== "string" || command.length === 0) {
    return Promise.reject(new Error("runProcess requires a command string."));
  }
  const args = Object.freeze([...(options.args ?? [])].map(String));
  const redact = options.redact ?? [];
  const argv = Object.freeze([command, ...args]);

  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(options.env ?? {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        signal: options.signal,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    if (options.stdin != null) {
      child.stdin.end(String(options.stdin));
    } else {
      child.stdin.end();
    }

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    child.on("error", (error) => {
      const wrapped = new Error(`Failed to start ${command}: ${redactText(error.message, redact)}`);
      /** @type {any} */ (wrapped).cause = error;
      /** @type {any} */ (wrapped).argv = argv;
      finish(wrapped);
    });

    child.on("close", (exitCode, signal) => {
      /** @type {RunProcessResult} */
      const result = {
        exitCode,
        signal: signal ?? null,
        stdout,
        stderr,
        argv,
      };

      if (signal) {
        const error = new Error(`Command terminated by signal ${signal}: ${formatArgv(argv)}`);
        /** @type {any} */ (error).signal = signal;
        /** @type {any} */ (error).exitCode = exitCode;
        /** @type {any} */ (error).stdout = redactText(stdout, redact);
        /** @type {any} */ (error).stderr = redactText(stderr, redact);
        /** @type {any} */ (error).argv = argv;
        finish(error);
        return;
      }

      if (exitCode !== 0 && !options.allowNonZero) {
        const error = new Error(
          `Command failed (${exitCode}): ${formatArgv(argv)}\n${redactText(stderr || stdout, redact)}`,
        );
        /** @type {any} */ (error).exitCode = exitCode;
        /** @type {any} */ (error).signal = null;
        /** @type {any} */ (error).stdout = redactText(stdout, redact);
        /** @type {any} */ (error).stderr = redactText(stderr, redact);
        /** @type {any} */ (error).argv = argv;
        finish(error);
        return;
      }

      finish(null, result);
    });
  });
}

/**
 * @param {readonly string[]} argv
 */
function formatArgv(argv) {
  return argv.map(shellQuote).join(" ");
}

/**
 * @param {string} value
 */
function shellQuote(value) {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Default process executor used by the CLI.
 * @type {(options: RunProcessOptions) => Promise<RunProcessResult>}
 */
export const defaultProcessExecutor = runProcess;
