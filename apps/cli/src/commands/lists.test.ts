import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, runMain } from "../main.js";
import { parseCliCommand } from "./options.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("lists commands", () => {
  it("covers list CRUD requests, JSON, human output, and pagination hints", async () => {
    const requests = installListsFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["lists", "list", "--limit", "2", "--offset", "4"], cliEnv());
    await runCli(["lists", "get", "list_1"], cliEnv());
    await runCli(["lists", "create", "Launch"], cliEnv());
    await runCli(["lists", "update", "list_1", "Renamed"], cliEnv());
    await runCli(["--json", "lists", "delete", "list_1"], cliEnv());

    expect(requests).toEqual([
      { method: "GET", url: "https://mail.example.com/api/lists?limit=2&offset=4" },
      { method: "GET", url: "https://mail.example.com/api/lists/list_1" },
      {
        body: { name: "Launch" },
        method: "POST",
        url: "https://mail.example.com/api/lists",
      },
      {
        body: { name: "Renamed" },
        method: "PATCH",
        url: "https://mail.example.com/api/lists/list_1",
      },
      { method: "DELETE", url: "https://mail.example.com/api/lists/list_1" },
    ]);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "More results available: rerun with --offset 6.",
    );
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({ deleted: "list_1" });
  });

  it("lists, imports, and removes contacts with every query/body flag", async () => {
    const requests = installListsFetch();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(
      [
        "lists",
        "contacts",
        "list",
        "list_1",
        "--email",
        "user@example.com",
        "--status",
        "subscribed",
        "--limit",
        "5",
        "--offset",
        "10",
      ],
      cliEnv(),
    );
    await runCli(["lists", "contacts", "import", "list_1", "--file", "contacts.json"], cliEnv(), {
      now: Date.now,
      readTextFile: async () => JSON.stringify({ contacts: [{ email: "a@example.com" }] }),
      sleep: async () => undefined,
    });
    await runCli(["--json", "lists", "contacts", "remove", "list_1", "contact_1"], cliEnv());

    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://mail.example.com/api/lists/list_1/contacts?email=user%40example.com&limit=5&offset=10&status=subscribed",
      },
      {
        body: { contacts: [{ email: "a@example.com" }] },
        method: "POST",
        url: "https://mail.example.com/api/lists/list_1/contacts",
      },
      {
        method: "DELETE",
        url: "https://mail.example.com/api/lists/list_1/contacts/contact_1",
      },
    ]);
    expect(log.mock.calls.flat().join("\n")).toContain("Imported into list_1: accepted=1/1");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      listId: "list_1",
      removed: "contact_1",
    });
  });

  it("rejects invalid argv combinations", async () => {
    expect(() => parseCliCommand(["lists", "contacts", "import", "list_1"])).toThrow(
      /requires --file/,
    );
    expect(() =>
      parseCliCommand(["lists", "contacts", "list", "list_1", "--status", "nope"]),
    ).toThrow(/Invalid --status value/);
    expect(() => parseCliCommand(["lists", "delete", "list_1", "extra"])).toThrow(
      /Unexpected argument/,
    );

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      runMain(["lists", "contacts", "import", "list_1", "--file", "-"], cliEnv(), {
        now: Date.now,
        readStdin: async () => "",
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 2 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps API errors for list create", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { code: "conflict", message: "Exists." } }, { status: 409 }),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runMain(["--json", "lists", "create", "Launch"], cliEnv())).resolves.toEqual({
      exitCode: 4,
    });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "conflict" },
    });
  });
});

function installListsFetch() {
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
    if (url.includes("/contacts") && method === "POST") {
      return Response.json({
        counts: {
          accepted: 1,
          alreadySubscribed: 0,
          contactsCreated: 1,
          membershipsCreated: 1,
          resubscribed: 0,
          submitted: 1,
        },
        items: [
          {
            action: "created",
            contactId: "contact_1",
            email: "a@example.com",
            status: "subscribed",
          },
        ],
      });
    }
    if (url.includes("/contacts")) {
      return Response.json({
        items: [
          {
            contact: contact(),
            status: "subscribed",
            subscribedAt: "2026-07-09T00:00:00.000Z",
            unsubscribedAt: null,
          },
        ],
        pagination: { limit: 5, nextOffset: null, offset: 10 },
      });
    }
    if (method === "GET" && url.includes("?")) {
      return Response.json({
        items: [list()],
        pagination: { limit: 2, nextOffset: 6, offset: 4 },
      });
    }
    return Response.json({ list: list() });
  }) as unknown as typeof fetch;
  return requests;
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    NUSEND_API_KEY: "nusend_test",
    NUSEND_BASE_URL: "https://mail.example.com",
  };
}

function list() {
  return {
    counts: { subscribed: 2, unsubscribed: 1 },
    createdAt: "2026-07-09T00:00:00.000Z",
    id: "list_1",
    name: "Launch",
  };
}

function contact() {
  return {
    createdAt: "2026-07-09T00:00:00.000Z",
    email: "user@example.com",
    id: "contact_1",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}
