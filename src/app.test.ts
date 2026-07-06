import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { seedApiKey, seedSuppression, selectAll, selectSingle } from "../test/helpers.ts";

async function postMailing(body: unknown, key?: string): Promise<Response> {
  return await exports.default.fetch(
    new Request("https://nusend.test/api/mailings", {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      method: "POST",
    }),
  );
}

describe("public routes", () => {
  it("serves /health without authentication", async () => {
    const response = await exports.default.fetch(new Request("https://nusend.test/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "nusend" });
  });

  it("serves unsubscribe and SES webhook stubs publicly with 501", async () => {
    const requests = [
      new Request("https://nusend.test/unsubscribe/some-token"),
      new Request("https://nusend.test/unsubscribe/some-token", { method: "POST" }),
      new Request("https://nusend.test/webhooks/ses", { method: "POST" }),
    ];

    for (const request of requests) {
      const response = await exports.default.fetch(request);
      expect(response.status).toBe(501);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("not_implemented");
    }
  });

  it("returns structured 404s for unknown routes", async () => {
    const response = await exports.default.fetch(new Request("https://nusend.test/nope"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not found." },
    });
  });
});

describe("POST /api/mailings", () => {
  it("requires an API key", async () => {
    const response = await postMailing({ purpose: "transactional" });

    expect(response.status).toBe(401);
  });

  it("creates a direct transactional mailing with deliveries and queued send jobs", async () => {
    const key = await seedApiKey();

    const response = await postMailing(
      {
        html: "<p>Hi {{ user.name }}</p>",
        purpose: "transactional",
        recipients: [
          { email: "USER@example.com", vars: { user: { name: "Max" } } },
          { email: "other@example.com" },
        ],
        subject: "Welcome",
      },
      key,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      counts: Record<string, number>;
      mailing: { id: string; purpose: string; state: string };
    };
    expect(body.counts).toEqual({ deliveries: 2, queued: 2, suppressed: 0 });
    expect(body.mailing.purpose).toBe("transactional");
    expect(body.mailing.state).toBe("scheduled");

    const deliveries = await selectAll(
      "SELECT email, status FROM deliveries WHERE mailing_id = ?1 ORDER BY email;",
      body.mailing.id,
    );
    expect(deliveries).toEqual([
      { email: "other@example.com", status: "queued" },
      { email: "user@example.com", status: "queued" },
    ]);

    // The SES sender does not exist yet: send jobs must be created with
    // transactional priority and stay queued.
    const jobs = await selectAll(
      `SELECT jobs.state, jobs.kind, jobs.priority
       FROM jobs
       INNER JOIN deliveries ON deliveries.id = jobs.ref_id
       WHERE deliveries.mailing_id = ?1;`,
      body.mailing.id,
    );
    expect(jobs).toEqual([
      { kind: "send_delivery", priority: 10, state: "queued" },
      { kind: "send_delivery", priority: 10, state: "queued" },
    ]);
  });

  it("creates a mailing at the 100-recipient cap across chunked D1 inserts", async () => {
    const key = await seedApiKey();
    const recipients = Array.from({ length: 100 }, (_, index) => ({
      email: `user${index}@example.com`,
    }));

    const response = await postMailing(
      { html: "<p>Hi</p>", purpose: "transactional", recipients, subject: "Bulk" },
      key,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      counts: Record<string, number>;
      mailing: { id: string };
    };
    expect(body.counts).toEqual({ deliveries: 100, queued: 100, suppressed: 0 });
    expect(
      await selectSingle(
        "SELECT COUNT(*) AS count FROM jobs WHERE kind = 'send_delivery' AND state = 'queued';",
      ),
    ).toEqual({ count: 100 });

    const oneOver = await postMailing(
      {
        html: "<p>Hi</p>",
        purpose: "transactional",
        recipients: [...recipients, { email: "extra@example.com" }],
        subject: "Bulk",
      },
      key,
    );
    expect(oneOver.status).toBe(400);
  });

  it("filters suppressed recipients and reports counts", async () => {
    const key = await seedApiKey();
    await seedSuppression({ email: "blocked@example.com" });

    const response = await postMailing(
      {
        html: "<p>Hi</p>",
        purpose: "transactional",
        recipients: [{ email: "blocked@example.com" }, { email: "ok@example.com" }],
        subject: "Welcome",
      },
      key,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { counts: Record<string, number> };
    expect(body.counts).toEqual({ deliveries: 2, queued: 1, suppressed: 1 });
  });

  it("rejects malformed JSON, invalid payloads, and empty recipient sets", async () => {
    const key = await seedApiKey();

    const malformed = await postMailing("{not json", key);
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );

    const invalid = await postMailing({ purpose: "transactional" }, key);
    expect(invalid.status).toBe(400);

    const emptyRecipients = await postMailing(
      { html: "<p>Hi</p>", purpose: "transactional", recipients: [], subject: "Hello" },
      key,
    );
    expect(emptyRecipients.status).toBe(400);

    await seedSuppression({ email: "gone@example.com" });
    const allSuppressed = await postMailing(
      {
        html: "<p>Hi</p>",
        purpose: "transactional",
        recipients: [{ email: "gone@example.com" }],
        subject: "Hello",
      },
      key,
    );
    expect(allSuppressed.status).toBe(422);
    expect(((await allSuppressed.json()) as { error: { code: string } }).error.code).toBe(
      "empty_recipient_set",
    );
  });

  it("rejects marketing mailings until unsubscribe support exists", async () => {
    const key = await seedApiKey();

    const response = await postMailing(
      {
        html: "<p>Hi</p>",
        listId: "list_1",
        purpose: "marketing",
        subject: "News",
      },
      key,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "marketing_unsubscribe_not_available",
        message: "Marketing sending is disabled until Nusend has unsubscribe support.",
      },
    });
  });
});

describe("GET /api/mailings/:id", () => {
  it("returns mailing state and delivery counts", async () => {
    const key = await seedApiKey();

    const created = await postMailing(
      {
        html: "<p>Hi</p>",
        purpose: "transactional",
        recipients: [{ email: "a@example.com" }, { email: "b@example.com" }],
        subject: "Hello",
      },
      key,
    );
    const { mailing } = (await created.json()) as { mailing: { id: string } };

    const response = await exports.default.fetch(
      new Request(`https://nusend.test/api/mailings/${mailing.id}`, {
        headers: { authorization: `Bearer ${key}` },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      counts: { deliveries: 2, failed: 0, queued: 2, sent: 0, suppressed: 0 },
      mailing: {
        id: mailing.id,
        purpose: "transactional",
        scheduledAt: (body.mailing as { scheduledAt: string }).scheduledAt,
        state: "scheduled",
      },
    });
    const scheduled = await selectSingle(
      "SELECT scheduled_at AS scheduledAt FROM mailings WHERE id = ?1;",
      mailing.id,
    );
    expect((body.mailing as { scheduledAt: string }).scheduledAt).toBe(scheduled?.scheduledAt);
  });

  it("returns 404 for unknown mailings", async () => {
    const key = await seedApiKey();

    const response = await exports.default.fetch(
      new Request("https://nusend.test/api/mailings/unknown", {
        headers: { authorization: `Bearer ${key}` },
      }),
    );

    expect(response.status).toBe(404);
  });
});
