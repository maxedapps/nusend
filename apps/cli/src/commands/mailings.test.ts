import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, runMain } from "../main.js";
import { parseCliCommand } from "./options.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("mailings commands", () => {
  it("builds list queries and prints human summaries with continuation hints", async () => {
    const fetchMock = vi.fn(async (input: Request | URL | string) => {
      expect(input instanceof Request ? input.url : String(input)).toBe(
        "https://mail.example.com/api/mailings?limit=2&offset=1",
      );
      return Response.json({
        items: [mailingListItem()],
        pagination: { limit: 2, nextOffset: 3, offset: 1 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["mailings", "list", "--limit", "2", "--offset", "1"], cliEnv()),
    ).resolves.toEqual({ exitCode: 0 });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("mailing_1\tcompleted\ttransactional");
    expect(output).toContain("2/4");
    expect(output).toContain("ambiguous=1");
    expect(output).toContain("More results available: rerun with --offset 3.");
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

  it("creates mailings from file JSON with optional idempotency key", async () => {
    const fetchMock = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("idem-1");
      expect(JSON.parse(String(init?.body))).toEqual({
        html: "<p>hi</p>",
        purpose: "transactional",
        recipients: [{ email: "a@example.com" }],
        subject: "Hello",
      });
      return Response.json(createMailingResponse(), { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(
        ["mailings", "create", "--file", "/tmp/mailing.json", "--idempotency-key", "idem-1"],
        cliEnv(),
        {
          now: Date.now,
          readTextFile: async (path) => {
            expect(path).toBe("/tmp/mailing.json");
            return JSON.stringify({
              html: "<p>hi</p>",
              purpose: "transactional",
              recipients: [{ email: "a@example.com" }],
              subject: "Hello",
            });
          },
          sleep: async () => undefined,
        },
      ),
    ).resolves.toEqual({ exitCode: 0 });

    expect(log.mock.calls.flat().join("\n")).toContain(
      "Created mailing_1\tscheduled\ttransactional\tdeliveries=1 queued=1 suppressed=0",
    );
  });

  it("creates mailings from stdin JSON and prints exact JSON output", async () => {
    const fetchMock = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
      return Response.json(createMailingResponse(), { status: 201 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["--json", "mailings", "create", "--file", "-"], cliEnv(), {
      now: Date.now,
      readStdin: async () =>
        JSON.stringify({
          html: "<p>hi</p>",
          purpose: "transactional",
          recipients: [{ email: "a@example.com" }],
          subject: "Hello",
        }),
      sleep: async () => undefined,
    });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(createMailingResponse());
  });

  it("rejects missing/duplicate file options and surfaces file errors before fetch", async () => {
    expect(() => parseCliCommand(["mailings", "create"])).toThrow(
      /mailings create requires --file/,
    );
    expect(() =>
      parseCliCommand(["mailings", "create", "--file", "a.json", "--file", "b.json"]),
    ).toThrow(/Duplicate option: --file/);
    expect(() =>
      parseCliCommand(["mailings", "create", "--file=body.json", "--idempotency-key=key"]),
    ).not.toThrow();

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runMain(["mailings", "create", "--file", "missing.json"], cliEnv(), {
        now: Date.now,
        readTextFile: async () => {
          throw new Error("ENOENT");
        },
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 2 });
    expect(error.mock.calls.flat().join("\n")).toContain("Unable to read JSON file missing.json");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps create API errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        { error: { code: "validation_error", message: "Invalid mailing." } },
        { status: 400 },
      ),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runMain(["--json", "mailings", "create", "--file", "-"], cliEnv(), {
        now: Date.now,
        readStdin: async () =>
          JSON.stringify({
            html: "<p>hi</p>",
            purpose: "transactional",
            recipients: [{ email: "a@example.com" }],
            subject: "Hello",
          }),
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 4 });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "validation_error", message: "Invalid mailing." },
    });
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

function createMailingResponse() {
  return {
    counts: { deliveries: 1, queued: 1, suppressed: 0 },
    mailing: {
      id: "mailing_1",
      purpose: "transactional",
      scheduledAt: "2026-07-09T00:00:00.000Z",
      state: "scheduled",
    },
  };
}
