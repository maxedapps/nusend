import { ErrorEnvelopeSchema } from "@nusend/api-contract";
import { Result, Schema } from "effect";

import { CliHttpError } from "./errors.js";

export type HttpClientOptions = {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
};

export class NusendHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
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

    const response = await this.fetchImpl(new URL(input.path, `${this.options.baseUrl}/`), {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers,
      method: input.method ?? "GET",
    });
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
      const envelope = Schema.decodeUnknownResult(ErrorEnvelopeSchema)(json);
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
