import { Result, Schema } from "effect";

import { CliHttpError } from "./errors.js";

export type HttpClientOptions = {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

export const defaultHttpTimeoutMs = 30_000;

export function parseHttpTimeoutMs(value: string | undefined): Result.Result<number, string> {
  if (value === undefined) return Result.succeed(defaultHttpTimeoutMs);
  if (!/^\d+$/.test(value)) {
    return Result.fail("NUSEND_HTTP_TIMEOUT_MS must be a decimal safe integer >= 1.");
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? Result.succeed(parsed)
    : Result.fail("NUSEND_HTTP_TIMEOUT_MS must be a decimal safe integer >= 1.");
}

// The server's error `code` is decoded as a plain string (not the closed contract
// enum) so an unknown/newer server code still surfaces the server's message
// instead of collapsing to a generic failure.
const ErrorEnvelopeLenientSchema = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

export class NusendHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? defaultHttpTimeoutMs;
  }

  async request<A, I = A>(input: {
    readonly body?: unknown;
    readonly method?: string;
    readonly path: string;
    readonly schema: Schema.Codec<A, I>;
  }): Promise<A> {
    const headers = new Headers({ accept: "application/json" });
    if (input.body !== undefined) headers.set("content-type", "application/json");
    if (this.options.apiKey) headers.set("x-api-key", this.options.apiKey);

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(input.path, `${this.options.baseUrl}/`), {
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        headers,
        method: input.method ?? "GET",
        // Never follow redirects: the API does not redirect, and following one
        // cross-origin would forward the x-api-key header.
        redirect: "error",
        // Bound the request so a black-holed server yields a machine-readable
        // error instead of hanging forever.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new CliHttpError(0, "timeout", `Request timed out after ${this.timeoutMs}ms.`);
      }
      // A blocked redirect (or other network failure) surfaces as a TypeError.
      throw new CliHttpError(0, "network_error", "Request failed to reach the server.");
    }
    let json: unknown;
    try {
      json = await readJson(response);
    } catch (error) {
      if (!response.ok) {
        throw new CliHttpError(
          response.status,
          "http_error",
          `Request failed with HTTP ${response.status}.`,
        );
      }
      throw error;
    }

    if (!response.ok) {
      const envelope = Schema.decodeUnknownResult(ErrorEnvelopeLenientSchema)(json);
      if (Result.isSuccess(envelope)) {
        throw new CliHttpError(
          response.status,
          envelope.success.error.code,
          envelope.success.error.message,
        );
      }
      throw new CliHttpError(
        response.status,
        "http_error",
        `Request failed with HTTP ${response.status}.`,
      );
    }

    return Schema.decodeUnknownSync(input.schema)(json);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  return JSON.parse(text) as unknown;
}
