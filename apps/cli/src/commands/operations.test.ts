import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, runMain } from "../main.js";
import { parseCliCommand } from "./options.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("operations and deliveries commands", () => {
  it("prints a concise operations summary and exact JSON", async () => {
    const summary = {
      deliveries: {
        ambiguous: 1,
        failed: 2,
        queued: 3,
        sending: 4,
        sent: 5,
        suppressed: 6,
      },
      jobs: { dead: 1, leased: 2, queued: 3, succeeded: 4 },
      recentIssues: [
        {
          id: "issue_1",
          kind: "delivery",
          message: "boom",
          relatedId: "delivery_1",
          status: "failed",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      ],
      sendAttempts: { ambiguous: 0, failed: 1, started: 2, succeeded: 3 },
    };
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      expect(String(input)).toBe("https://mail.example.com/api/operations/summary");
      return Response.json(summary);
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["operations", "summary"], cliEnv());
    expect(log.mock.calls.flat().join("\n")).toContain("deliveries: queued=3");
    expect(log.mock.calls.flat().join("\n")).toContain("recentIssues: 1");

    log.mockClear();
    await runCli(["--json", "operations", "summary"], cliEnv());
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(summary);
  });

  it("passes every deliveries list filter and gets detail without dumping noise", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/deliveries?")) {
        return Response.json({
          items: [
            {
              createdAt: "2026-07-09T00:00:00.000Z",
              email: "user@example.com",
              id: "delivery_1",
              job: null,
              lastError: null,
              latestAttempt: null,
              mailingId: "mailing_1",
              mailingPurpose: "transactional",
              sesMessageId: "ses-1",
              status: "failed",
              updatedAt: "2026-07-09T00:00:00.000Z",
            },
          ],
        });
      }
      return Response.json({
        attempts: [
          {
            attemptNo: 1,
            errorMessage: "temporary",
            finishedAt: "2026-07-09T00:00:01.000Z",
            id: "attempt_1",
            sesMessageId: "ses-1",
            startedAt: "2026-07-09T00:00:00.000Z",
            status: "failed",
          },
        ],
        delivery: {
          contactId: "contact_1",
          createdAt: "2026-07-09T00:00:00.000Z",
          email: "user@example.com",
          id: "delivery_1",
          lastError: "temporary",
          mailingId: "mailing_1",
          sesMessageId: "ses-1",
          status: "failed",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
        job: {
          attempts: 1,
          createdAt: "2026-07-09T00:00:00.000Z",
          id: "job_1",
          lastError: "temporary",
          lockedBy: null,
          lockedUntil: null,
          maxAttempts: 5,
          runAt: "2026-07-09T00:00:00.000Z",
          state: "dead",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
        mailing: {
          createdAt: "2026-07-09T00:00:00.000Z",
          id: "mailing_1",
          name: "Welcome",
          purpose: "transactional",
          scheduledAt: "2026-07-09T00:00:00.000Z",
          state: "completed",
          subject: "Hello",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
      });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(
      [
        "deliveries",
        "list",
        "--email",
        "user@example.com",
        "--issue",
        "failed_or_ambiguous",
        "--limit",
        "25",
        "--mailing-id",
        "mailing_1",
        "--ses-message-id",
        "ses-1",
        "--status",
        "failed",
      ],
      cliEnv(),
    );
    await runCli(["deliveries", "get", "delivery_1"], cliEnv());

    expect(requests).toEqual([
      "https://mail.example.com/api/operations/deliveries?email=user%40example.com&issue=failed_or_ambiguous&limit=25&mailingId=mailing_1&sesMessageId=ses-1&status=failed",
      "https://mail.example.com/api/operations/deliveries/delivery_1",
    ]);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "delivery_1\tuser@example.com\tfailed\tmailing=mailing_1",
    );
    expect(log.mock.calls.flat().join("\n")).toContain("job: job_1\tdead\tattempts=1");
  });

  it("rejects invalid deliveries filters", () => {
    expect(() => parseCliCommand(["deliveries", "list", "--issue", "all"])).toThrow(
      /Invalid --issue value/,
    );
    expect(() => parseCliCommand(["deliveries", "list", "--status", "done"])).toThrow(
      /Invalid --status value/,
    );
    expect(() => parseCliCommand(["operations", "summary", "extra"])).toThrow(
      /Unexpected argument/,
    );
  });

  it("maps deliveries API errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { code: "not_found", message: "Missing." } }, { status: 404 }),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runMain(["--json", "deliveries", "get", "missing"], cliEnv())).resolves.toEqual({
      exitCode: 4,
    });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "not_found" },
    });
  });
});

function cliEnv(): NodeJS.ProcessEnv {
  return {
    NUSEND_API_KEY: "nusend_test",
    NUSEND_BASE_URL: "https://mail.example.com",
  };
}
