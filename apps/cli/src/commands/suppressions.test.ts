import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, runMain } from "../main.js";
import { parseCliCommand } from "./options.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("suppressions commands", () => {
  it("passes every list filter and prints continuation hints", async () => {
    const requests = installSuppressionFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(
      [
        "suppressions",
        "list",
        "--email",
        "user@example.com",
        "--scope",
        "list",
        "--reason",
        "manual",
        "--list-id",
        "list_1",
        "--limit",
        "3",
        "--offset",
        "6",
      ],
      cliEnv(),
    );

    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://mail.example.com/api/suppressions?email=user%40example.com&limit=3&listId=list_1&offset=6&reason=manual&scope=list",
      },
    ]);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "suppression_1\tuser@example.com\tlist\tmanual\tlist=list_1",
    );
    expect(log.mock.calls.flat().join("\n")).toContain(
      "More results available: rerun with --offset 9.",
    );
  });

  it("creates scoped suppressions and deletes with stable JSON", async () => {
    const requests = installSuppressionFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(
      ["suppressions", "create", "user@example.com", "--scope", "list", "--list-id", "list_1"],
      cliEnv(),
    );
    await runCli(["suppressions", "create", "all@example.com", "--scope", "all"], cliEnv());
    await runCli(["--json", "suppressions", "delete", "suppression_1"], cliEnv());

    expect(requests).toEqual([
      {
        body: { email: "user@example.com", listId: "list_1", scope: "list" },
        method: "POST",
        url: "https://mail.example.com/api/suppressions",
      },
      {
        body: { email: "all@example.com", scope: "all" },
        method: "POST",
        url: "https://mail.example.com/api/suppressions",
      },
      {
        method: "DELETE",
        url: "https://mail.example.com/api/suppressions/suppression_1",
      },
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ deleted: "suppression_1" });
  });

  it("validates scope/list-id combinations and enum values", () => {
    expect(() =>
      parseCliCommand(["suppressions", "create", "user@example.com", "--scope", "list"]),
    ).toThrow(/requires --list-id/);
    expect(() =>
      parseCliCommand([
        "suppressions",
        "create",
        "user@example.com",
        "--scope",
        "all",
        "--list-id",
        "list_1",
      ]),
    ).toThrow(/only allowed when --scope is list/);
    expect(() =>
      parseCliCommand(["suppressions", "list", "--scope", "all", "--list-id", "list_1"]),
    ).toThrow(/only be combined with --scope list/);
    expect(() => parseCliCommand(["suppressions", "list", "--reason", "other"])).toThrow(
      /Invalid --reason value/,
    );
  });

  it("maps API errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { code: "forbidden", message: "Denied." } }, { status: 403 }),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runMain(["--json", "suppressions", "create", "user@example.com", "--scope", "all"], cliEnv()),
    ).resolves.toEqual({ exitCode: 4 });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "forbidden" },
    });
  });
});

function installSuppressionFetch() {
  const requests: { body?: unknown; method: string; url: string }[] = [];
  globalThis.fetch = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = input instanceof Request ? input.url : String(input);
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method,
      url,
    });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        email: string;
        listId?: string;
        scope: string;
      };
      return Response.json({
        created: true,
        suppression: {
          createdAt: "2026-07-09T00:00:00.000Z",
          email: body.email,
          id: "suppression_1",
          listId: body.listId ?? null,
          reason: "manual",
          scope: body.scope,
        },
      });
    }
    return Response.json({
      items: [
        {
          createdAt: "2026-07-09T00:00:00.000Z",
          email: "user@example.com",
          id: "suppression_1",
          listId: "list_1",
          reason: "manual",
          scope: "list",
        },
      ],
      pagination: { limit: 3, nextOffset: 9, offset: 6 },
    });
  }) as unknown as typeof fetch;
  return requests;
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    NUSEND_API_KEY: "nusend_test",
    NUSEND_BASE_URL: "https://mail.example.com",
  };
}
