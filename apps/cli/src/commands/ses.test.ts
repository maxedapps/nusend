import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, runMain } from "../main.js";
import { parseCliCommand } from "./options.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ses commands", () => {
  it("covers summary, readiness, setup-guide, events, and simulator-runs", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/summary")) return Response.json(sesSummary());
      if (url.includes("/readiness")) return Response.json(sesReadiness());
      if (url.includes("/setup-guide")) return Response.json(sesSetupGuide());
      if (url.includes("/events?")) return Response.json({ items: [sesEvent()] });
      if (url.includes("/events/")) return Response.json(sesEvent());
      if (url.endsWith("/simulator-runs")) return Response.json({ items: [simulatorRun()] });
      return Response.json(simulatorRun());
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["ses", "summary"], cliEnv());
    await runCli(["ses", "readiness", "--no-aws"], cliEnv());
    await runCli(["ses", "setup-guide", "--no-aws"], cliEnv());
    await runCli(
      [
        "ses",
        "events",
        "list",
        "--delivery-id",
        "delivery_1",
        "--email",
        "user@example.com",
        "--event-type",
        "Rendering Failure",
        "--limit",
        "20",
        "--mailing-id",
        "mailing_1",
        "--offset",
        "40",
        "--ses-message-id",
        "ses-1",
      ],
      cliEnv(),
    );
    await runCli(["ses", "events", "get", "event_1"], cliEnv());
    await runCli(["ses", "simulator-runs", "list"], cliEnv());
    await runCli(["ses", "simulator-runs", "get", "run_1"], cliEnv());

    expect(requests).toEqual([
      "https://mail.example.com/api/operations/ses/summary",
      "https://mail.example.com/api/operations/ses/readiness?includeAws=false",
      "https://mail.example.com/api/operations/ses/setup-guide?includeAws=false",
      "https://mail.example.com/api/operations/ses/events?deliveryId=delivery_1&email=user%40example.com&eventType=Rendering+Failure&limit=20&mailingId=mailing_1&offset=40&sesMessageId=ses-1",
      "https://mail.example.com/api/operations/ses/events/event_1",
      "https://mail.example.com/api/operations/ses/simulator-runs",
      "https://mail.example.com/api/operations/ses/simulator-runs/run_1",
    ]);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("totals: bounce=1");
    expect(output).toContain("status: warning");
    expect(output).toContain("SES setup (warning)");
    expect(output).toContain("event_1\tBounce\tuser@example.com\tsuppressed");
    expect(output).not.toContain("raw-payload");
    expect(output).toContain("run_1\tvalidated\tbounce\tbounce@example.com");
  });

  it("defaults readiness/setup-guide to include AWS and rejects refresh/--no-aws values", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
      requests.push(String(input));
      return Response.json(sesReadiness());
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["ses", "readiness"], cliEnv());
    expect(requests[0]).toBe("https://mail.example.com/api/operations/ses/readiness");

    expect(() => parseCliCommand(["ses", "readiness", "--refresh"])).toThrow(/Unknown option/);
    expect(() => parseCliCommand(["ses", "readiness", "--no-aws=true"])).toThrow(
      /does not take a value/,
    );
    expect(() => parseCliCommand(["ses", "readiness", "--no-aws", "--no-aws"])).toThrow(
      /Duplicate option: --no-aws/,
    );
    expect(() => parseCliCommand(["ses", "events", "list", "--event-type", "Nope"])).toThrow(
      /Invalid --event-type value/,
    );
  });

  it("prints exact JSON for events get and maps API errors", async () => {
    globalThis.fetch = vi.fn(async () => Response.json(sesEvent())) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["--json", "ses", "events", "get", "event_1"], cliEnv());
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(sesEvent());

    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { code: "not_found", message: "Missing." } }, { status: 404 }),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runMain(["--json", "ses", "simulator-runs", "get", "missing"], cliEnv()),
    ).resolves.toEqual({ exitCode: 4 });
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

function sesSummary() {
  return {
    counts: {
      Bounce: 1,
      Click: 0,
      Complaint: 0,
      Delivery: 0,
      DeliveryDelay: 0,
      Open: 0,
      Reject: 0,
      "Rendering Failure": 0,
      Send: 0,
      Subscription: 0,
      Unknown: 0,
    },
    latestEventAt: "2026-07-09T00:00:00.000Z",
    latestNotificationAt: null,
    recentIssues: [sesEvent()],
    totals: { bounce: 1, click: 0, complaint: 0, open: 0 },
    worker: {
      latestRun: {
        claimed: 1,
        dead: 0,
        failed: 0,
        finishedAt: "2026-07-09T00:00:00.000Z",
        id: "worker_1",
        mode: "once",
        released: 0,
        skippedStale: 0,
        succeeded: 1,
        workerId: "worker",
      },
    },
  };
}

function sesReadiness() {
  return {
    checkedAt: "2026-07-09T00:00:00.000Z",
    checks: [
      {
        action: null,
        docs: [],
        id: "aws_credentials",
        message: "skipped",
        status: "warning",
        title: "AWS credentials",
      },
    ],
    expectedWebhookUrl: "https://mail.example.com/api/webhooks/ses",
    status: "warning",
  };
}

function sesSetupGuide() {
  return {
    docs: ["https://example.com/docs"],
    status: "warning",
    steps: [
      {
        actions: [{ kind: "console", text: "Open SES" }],
        id: "verify-domain",
        relatedChecks: ["aws_credentials"],
        status: "warning",
        title: "Verify domain",
        why: "needed",
      },
    ],
    title: "SES setup",
  };
}

function sesEvent() {
  return {
    actionTaken: "suppressed",
    bounceSubType: null,
    bounceType: "Permanent",
    complaintFeedbackType: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    deliveryDelayType: null,
    deliveryId: "delivery_1",
    diagnosticCode: null,
    eventType: "Bounce",
    feedbackId: null,
    id: "event_1",
    ipAddress: null,
    linkTags: null,
    linkUrl: null,
    mailingId: "mailing_1",
    notificationId: "notification_1",
    occurredAt: "2026-07-09T00:00:00.000Z",
    recipientEmail: "user@example.com",
    rejectReason: null,
    sesMessageId: "ses-1",
    userAgent: null,
  };
}

function simulatorRun() {
  return {
    deliveryId: "delivery_1",
    errorMessage: null,
    expectedEventType: "Bounce",
    expectedSuppressionReason: "bounce",
    finishedAt: "2026-07-09T00:00:00.000Z",
    id: "run_1",
    mailingId: "mailing_1",
    mode: "local",
    purpose: "transactional",
    recipientEmail: "bounce@example.com",
    scenario: "bounce",
    startedAt: "2026-07-09T00:00:00.000Z",
    status: "validated",
    targetBaseUrl: null,
  };
}
