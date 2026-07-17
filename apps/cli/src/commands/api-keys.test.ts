import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../main.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("api-keys commands", () => {
  it("uses explicit expiry modes and the injected clock for the default", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json(
        {
          apiKey: {
            createdAt: "2026-07-09T00:00:00.000Z",
            expiresAt: body.expiresAt,
            id: `key_${bodies.length}`,
            key: `nusend_raw_${bodies.length}`,
            lastUsedAt: null,
            name: body.name,
            permissions: body.permissions,
            preview: `nusend…${bodies.length}`,
            revokedAt: null,
          },
        },
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(
      ["api-keys", "create", "--name", "none", "--no-expiry", "--permission", "contacts:read"],
      cliEnv(),
    );
    await runCli(
      [
        "api-keys",
        "create",
        "--name",
        "explicit",
        "--expires-at",
        "2099-01-01T00:00:00.000Z",
        "--permission",
        "contacts:read",
      ],
      cliEnv(),
    );
    await runCli(["api-keys", "create", "--name", "default"], cliEnv(), {
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      sleep: async () => undefined,
    });

    expect(bodies).toEqual([
      expect.objectContaining({ expiresAt: null, name: "none" }),
      expect.objectContaining({ expiresAt: "2099-01-01T00:00:00.000Z", name: "explicit" }),
      expect.objectContaining({ expiresAt: "2027-01-01T00:00:00.000Z", name: "default" }),
    ]);
  });

  it("rejects a flag as an option value", async () => {
    await expect(
      runCli(["api-keys", "create", "--name", "--no-expiry"], cliEnv()),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: "--name requires a value.",
    });
  });

  it("passes list pagination flags through and hints at more results", async () => {
    const urls: string[] = [];
    let nextOffset: number | null = 2;
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Response.json({
        items: [apiKey("listed", undefined)],
        pagination: { limit: 2, nextOffset, offset: 0 },
      });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["api-keys", "list", "--limit", "2", "--offset", "0"], cliEnv());
    expect(urls[0]).toBe("https://mail.example.com/api/api-keys?limit=2&offset=0");
    expect(log.mock.calls.flat().join("\n")).toContain(
      "More keys available: rerun with --offset 2.",
    );

    log.mockClear();
    nextOffset = null;
    await runCli(["api-keys", "list"], cliEnv());
    expect(urls[1]).toBe("https://mail.example.com/api/api-keys");
    expect(log.mock.calls.flat().join("\n")).not.toContain("More keys available");
  });

  it("lists keys", async () => {
    const { requests } = installKeyLifecycleFetch();

    await runCli(["api-keys", "list"], cliEnv());

    expect(requests).toEqual([{ method: "GET", url: "https://mail.example.com/api/api-keys" }]);
  });

  it("revokes a key", async () => {
    const { requests } = installKeyLifecycleFetch();

    await runCli(["api-keys", "revoke", "key_1"], cliEnv());

    expect(requests).toEqual([
      { method: "DELETE", url: "https://mail.example.com/api/api-keys/key_1" },
    ]);
  });

  it("rotates a key and prints its secret once", async () => {
    const { log, requests } = installKeyLifecycleFetch();

    await runCli(["api-keys", "rotate", "key_1"], cliEnv());

    expect(requests).toEqual([
      { method: "POST", url: "https://mail.example.com/api/api-keys/key_1/rotate" },
    ]);
    const output = log.mock.calls.flat().join("\n");
    expect(output.match(/nusend_rotated_secret/g)).toHaveLength(1);
  });
});

function installKeyLifecycleFetch() {
  const requests: { method: string; url: string }[] = [];
  globalThis.fetch = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/rotate")) {
      return Response.json({ apiKey: apiKey("rotated", "nusend_rotated_secret") });
    }
    return Response.json({
      items: [apiKey("listed", undefined)],
      pagination: { limit: 50, nextOffset: null, offset: 0 },
    });
  }) as unknown as typeof fetch;
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return { log, requests };
}

function apiKey(name: string, key: string | undefined) {
  return {
    createdAt: "2026-07-09T00:00:00.000Z",
    expiresAt: null,
    id: "key_1",
    ...(key === undefined ? {} : { key }),
    lastUsedAt: null,
    name,
    permissions: { contacts: ["read"] },
    preview: "nusend…test",
    revokedAt: null,
  };
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    NUSEND_API_KEY: "nusend_test",
    NUSEND_BASE_URL: "https://mail.example.com",
  };
}
