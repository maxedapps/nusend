import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../main.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("mailings commands", () => {
  it("builds list queries and prints human summaries", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      expect(input instanceof Request ? input.url : String(input)).toBe(
        "https://mail.example.com/api/mailings?limit=2&offset=1",
      );
      return Response.json({
        items: [mailingListItem()],
        pagination: { limit: 2, nextOffset: null, offset: 1 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["mailings", "list", "--limit", "2", "--offset", "1"], cliEnv()),
    ).resolves.toEqual({ exitCode: 0 });

    expect(log.mock.calls.flat().join("\n")).toContain("mailing_1\tcompleted\ttransactional");
    expect(log.mock.calls.flat().join("\n")).toContain("2/4");
    expect(log.mock.calls.flat().join("\n")).toContain("ambiguous=1");
  });

  it("prints full detail as JSON but omits HTML in human mode", async () => {
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      expect(input instanceof Request ? input.url : String(input)).toBe(
        "https://mail.example.com/api/mailings/mailing_1",
      );
      return Response.json({
        mailing: {
          ...mailingListItem(),
          html: "<p>secret body</p>",
          text: "secret text",
        },
      });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["mailings", "get", "mailing_1"], cliEnv());
    expect(log.mock.calls.flat().join("\n")).not.toContain("secret body");
    expect(log.mock.calls.flat().join("\n")).toContain("ambiguous=1");

    log.mockClear();
    await runCli(["--json", "mailings", "get", "mailing_1"], cliEnv());
    expect(log.mock.calls.flat().join("\n")).toContain("secret body");
  });
});

function cliEnv(): NodeJS.ProcessEnv {
  return {
    NUSEND_API_KEY: "nusend_test",
    NUSEND_BASE_URL: "https://mail.example.com",
  };
}

function mailingListItem() {
  return {
    counts: { ambiguous: 1, failed: 0, queued: 1, sending: 0, sent: 2, suppressed: 0 },
    createdAt: "2026-07-09T00:00:00.000Z",
    id: "mailing_1",
    listId: null,
    name: "Test",
    purpose: "transactional",
    scheduledAt: null,
    state: "completed",
    subject: "Subject",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}
