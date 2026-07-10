import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../main.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("contacts commands", () => {
  it("gets, updates, and deletes contacts", async () => {
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
      if (method === "PATCH") return Response.json({ contact: contact("new@example.com") });
      return Response.json({ contact: contact("old@example.com"), memberships: [] });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["contacts", "get", "contact_1"], cliEnv());
    await runCli(["contacts", "update", "contact_1", "new@example.com"], cliEnv());
    await runCli(["contacts", "delete", "contact_1"], cliEnv());

    expect(requests).toEqual([
      { method: "GET", url: "https://mail.example.com/api/contacts/contact_1" },
      {
        body: { email: "new@example.com" },
        method: "PATCH",
        url: "https://mail.example.com/api/contacts/contact_1",
      },
      { method: "DELETE", url: "https://mail.example.com/api/contacts/contact_1" },
    ]);
  });
});

function cliEnv(): NodeJS.ProcessEnv {
  return {
    NUSEND_API_KEY: "nusend_test",
    NUSEND_BASE_URL: "https://mail.example.com",
  };
}

function contact(email: string) {
  return {
    createdAt: "2026-07-09T00:00:00.000Z",
    email,
    id: "contact_1",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}
