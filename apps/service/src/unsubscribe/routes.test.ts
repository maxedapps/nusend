import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { createMailing } from "../mailings/create-mailing.ts";
import { Database } from "../services/database.ts";
import { fakeUnsubscribeConfig, withTestApp, type TestRuntime } from "../testing/layers.ts";
import { signUnsubscribeToken } from "./token.ts";

const fixedTime = Date.parse("2026-07-03T12:00:00.000Z");

async function seedToken(runtime: TestRuntime): Promise<string> {
  return runtime.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(fixedTime);
      yield* createMailing({
        html: '<a href="{{ unsubscribe.url }}">Unsubscribe</a>',
        listId: null,
        name: null,
        purpose: "marketing",
        recipients: [{ email: "user@example.com", varsJson: null }],
        scheduledAt: null,
        subject: "Hello",
        text: null,
      });
      const db = yield* Database;
      const delivery = yield* db.get<{ id: string }>(
        "assert:delivery",
        "SELECT id FROM deliveries LIMIT 1;",
      );
      return signUnsubscribeToken(delivery?.id ?? "missing", fakeUnsubscribeConfig().currentSecret);
    }),
  );
}

describe("unsubscribe routes", () => {
  it("GET valid token renders confirmation without mutation", async () => {
    await withTestApp(
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
      async (app, runtime) => {
        const token = await seedToken(runtime);

        const response = await app.fetch(new Request(`http://localhost/unsubscribe/${token}`));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("x-robots-tag")).toBe("noindex");
        const html = await response.text();
        expect(html).toContain("Confirm unsubscribe for us***@example.com");
        expect(html).not.toContain("user@example.com");
        await expect(countSuppressions(runtime)).resolves.toBe(0);
      },
    );
  });

  it("returns generic 404 when unsubscribe config is absent", async () => {
    await withTestApp({ unsubscribe: Option.none() }, async (app, runtime) => {
      const token = signUnsubscribeToken("delivery_1", fakeUnsubscribeConfig().currentSecret);

      const get = await app.fetch(new Request(`http://localhost/unsubscribe/${token}`));
      const post = await app.fetch(
        new Request(`http://localhost/unsubscribe/${token}`, {
          body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
      );

      expect(get.status).toBe(404);
      expect(post.status).toBe(404);
      await expect(countSuppressions(runtime)).resolves.toBe(0);
    });
  });

  it("returns generic 404 for invalid tokens and 410 for valid stale tokens", async () => {
    await withTestApp({ unsubscribe: Option.some(fakeUnsubscribeConfig()) }, async (app) => {
      const stale = signUnsubscribeToken("missing_delivery", fakeUnsubscribeConfig().currentSecret);

      const invalid = await app.fetch(new Request("http://localhost/unsubscribe/not-a-token"));
      const expired = await app.fetch(new Request(`http://localhost/unsubscribe/${stale}`));

      expect(invalid.status).toBe(404);
      await expect(invalid.text()).resolves.toContain("not found");
      expect(expired.status).toBe(410);
      await expect(expired.text()).resolves.toContain("expired");
    });
  });

  it("POST accepts one-click URL-encoded, multipart, and human confirmation bodies", async () => {
    await withTestApp(
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
      async (app, runtime) => {
        const token = await seedToken(runtime);

        const oneClick = await app.fetch(
          new Request(`http://localhost/unsubscribe/${token}`, {
            body: new URLSearchParams({ "List-Unsubscribe": "One-Click" }),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }),
        );
        const multipartBody = new FormData();
        multipartBody.set("List-Unsubscribe", "One-Click");
        const multipart = await app.fetch(
          new Request(`http://localhost/unsubscribe/${token}`, {
            body: multipartBody,
            method: "POST",
          }),
        );
        const human = await app.fetch(
          new Request(`http://localhost/unsubscribe/${token}`, {
            body: new URLSearchParams({ confirm: "unsubscribe" }),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }),
        );

        expect(oneClick.status).toBe(200);
        expect(multipart.status).toBe(200);
        expect(human.status).toBe(200);
        await expect(countSuppressions(runtime)).resolves.toBe(1);
      },
    );
  });

  it("POST returns 413 for oversized unsubscribe bodies without mutation", async () => {
    await withTestApp(
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
      async (app, runtime) => {
        const token = await seedToken(runtime);

        const response = await app.fetch(
          new Request(`http://localhost/unsubscribe/${token}`, {
            body: "x".repeat(8193),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }),
        );

        expect(response.status).toBe(413);
        await expect(response.text()).resolves.toContain("Request body is too large.");
        await expect(countSuppressions(runtime)).resolves.toBe(0);
      },
    );
  });

  it("POST rejects empty or garbage bodies without mutation and never redirects", async () => {
    await withTestApp(
      { unsubscribe: Option.some(fakeUnsubscribeConfig()) },
      async (app, runtime) => {
        const token = await seedToken(runtime);

        const empty = await app.fetch(
          new Request(`http://localhost/unsubscribe/${token}`, {
            body: "",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }),
        );
        const response = await app.fetch(
          new Request(`http://localhost/unsubscribe/${token}`, {
            body: new URLSearchParams({ confirm: "nope" }),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            method: "POST",
          }),
        );

        expect(empty.status).toBe(400);
        expect(response.status).toBe(400);
        expect(response.headers.get("location")).toBeNull();
        await expect(countSuppressions(runtime)).resolves.toBe(0);
      },
    );
  });
});

async function countSuppressions(runtime: TestRuntime) {
  const row = await runtime.runPromise(
    Effect.flatMap(Database, (db) =>
      db.get<{ count: number }>(
        "assert:suppressions",
        "SELECT count(*) AS count FROM suppressions;",
      ),
    ),
  );
  return row?.count ?? 0;
}
