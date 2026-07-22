import { createServer, type Server } from "node:http";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { NusendHttpClient, type HttpHeaders } from "./http.js";

const OkSchema = Schema.Struct({ ok: Schema.Boolean });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function asFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return impl as unknown as typeof fetch;
}

describe("NusendHttpClient", () => {
  it("merges caller headers without allowing transport safety or API-key overrides", async () => {
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const client = new NusendHttpClient({
      apiKey: "transport-secret",
      baseUrl: "https://api.example.test/root",
      fetchImpl: asFetch(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return jsonResponse(200, { ok: true });
      }),
    });

    await client.request({
      body: { value: 1 },
      headers: {
        accept: "text/plain",
        "content-type": "text/plain",
        "Idempotency-Key": "mailing-1",
        "X-API-KEY": "caller-secret",
      },
      method: "POST",
      path: "/api/x",
      schema: OkSchema,
    });

    const headers = new Headers(capturedInit?.headers);
    expect(String(capturedUrl)).toBe("https://api.example.test/api/x");
    expect(capturedInit?.body).toBe('{"value":1}');
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("error");
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("mailing-1");
    expect(headers.get("x-api-key")).toBe("transport-secret");
  });

  it("does not let caller headers inject an API key into an unauthenticated client", async () => {
    let capturedHeaders: HttpHeaders | undefined;
    const client = new NusendHttpClient({
      baseUrl: "http://localhost",
      fetchImpl: asFetch(async (_url, init) => {
        capturedHeaders = init?.headers;
        return jsonResponse(200, { ok: true });
      }),
    });

    await client.request({
      headers: { "X-Api-Key": "caller-secret" },
      path: "/x",
      schema: OkSchema,
    });

    expect(new Headers(capturedHeaders).has("x-api-key")).toBe(false);
  });

  it("surfaces the server's code and message even for an unknown error code", async () => {
    const client = new NusendHttpClient({
      baseUrl: "http://localhost",
      fetchImpl: asFetch(async () =>
        jsonResponse(400, { error: { code: "some_future_code", message: "very specific detail" } }),
      ),
    });

    await expect(client.request({ path: "/x", schema: OkSchema })).rejects.toMatchObject({
      code: "some_future_code",
      message: "very specific detail",
    });
  });

  it("blocks a real redirect without forwarding the API key to its target", async () => {
    let targetRequests = 0;
    let forwardedApiKey: string | undefined;
    const target = createServer((request, response) => {
      targetRequests += 1;
      const header = request.headers["x-api-key"];
      forwardedApiKey = Array.isArray(header) ? header.join(",") : header;
      response.end(JSON.stringify({ ok: true }));
    });
    const targetOrigin = await listen(target);
    const redirect = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", `${targetOrigin}/target`);
      response.end();
    });
    const redirectOrigin = await listen(redirect);

    try {
      const client = new NusendHttpClient({ apiKey: "secret-api-key", baseUrl: redirectOrigin });
      await expect(client.request({ path: "/redirect", schema: OkSchema })).rejects.toMatchObject({
        code: "network_error",
      });
      expect(targetRequests).toBe(0);
      expect(forwardedApiKey).toBeUndefined();
    } finally {
      await Promise.all([close(redirect), close(target)]);
    }
  });

  it("maps a generic network rejection to a machine-readable error", async () => {
    const client = new NusendHttpClient({
      baseUrl: "http://localhost",
      fetchImpl: asFetch(() => Promise.reject(new TypeError("fetch failed"))),
    });

    await expect(client.request({ path: "/x", schema: OkSchema })).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("times out a hung request with a machine-readable timeout error", async () => {
    const client = new NusendHttpClient({
      baseUrl: "http://localhost",
      // Respect the abort signal like the real fetch does.
      fetchImpl: asFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
      timeoutMs: 5,
    });

    await expect(client.request({ path: "/x", schema: OkSchema })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("returns decoded data on success", async () => {
    const client = new NusendHttpClient({
      baseUrl: "http://localhost",
      fetchImpl: asFetch(async () => jsonResponse(200, { ok: true })),
    });

    await expect(client.request({ path: "/x", schema: OkSchema })).resolves.toEqual({ ok: true });
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
