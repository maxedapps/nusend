import { Effect, Redacted } from "effect";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.ts";
import { Database } from "../services/database.ts";
import { makeTestRuntime, withTestApp, type TestRuntime } from "../testing/layers.ts";
import { hashDeviceAuthCode, normalizeUserCode } from "./token.ts";

const testDeviceAuthSecret = Redacted.make("test-device-auth-secret-32-value");

type TestApp = {
  fetch: (request: Request) => Response | Promise<Response>;
};

type StartedDevice = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUriComplete: string;
};

type RenderedActivation = {
  readonly cookie: string;
  readonly dom: JSDOM;
  readonly form: HTMLFormElement;
  readonly pageUrl: string;
};

function userCodeHash(userCode: string): string {
  return hashDeviceAuthCode(normalizeUserCode(userCode), testDeviceAuthSecret);
}

describe("CLI activation page", () => {
  it("renders only the configured public origin behind a proxy", async () => {
    const runtime = makeTestRuntime({
      auth: { session: { userId: "user_1" } },
      ids: ["device_1"],
      realApiKeys: true,
      realDeviceAuthorizations: true,
    });
    try {
      await seedUser(runtime);
      const app = createApp({ publicOrigin: "https://public.example.com", runtime });
      const started = await startDevice(app, "http://internal.local");
      const pageUrl = new URL(started.verificationUriComplete);
      const response = await app.fetch(
        new Request(`http://internal.local${pageUrl.pathname}${pageUrl.search}`),
      );
      const dom = new JSDOM(await response.text(), { url: started.verificationUriComplete });
      const form = dom.window.document.querySelector<HTMLFormElement>('form[method="post"]');
      expect(form).not.toBeNull();
      const rendered: RenderedActivation = {
        cookie: (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "",
        dom,
        form: form!,
        pageUrl: started.verificationUriComplete,
      };

      expect(response.status).toBe(200);
      expect(dom.window.document.body.textContent).toContain("https://public.example.com");
      expect(dom.window.document.body.textContent).not.toContain("http://internal.local");
      expect(form?.action).toBe("https://public.example.com/cli/activate");

      const rejectedInternalOrigin = await sendForm(
        app,
        rendered,
        formSubmission(rendered, "approve"),
        { origin: "http://internal.local", referer: "http://internal.local/cli/activate" },
      );
      expect(rejectedInternalOrigin.status).toBe(403);

      const approved = await submitActivation(app, rendered, "approve");
      expect(approved.status).toBe(200);
      await expect(approved.text()).resolves.toContain("CLI device approved");
      expect((await readStoredAuthorization(runtime)).approvedAt).not.toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it("renders unauthenticated sign-in page with no-store headers", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(new Request("http://localhost/cli/activate?code=ABCD-2345"));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(body).toContain("Sign in with Google");
      expect(body).toContain('fetch("/api/auth/sign-in/social"');
      expect(body).toContain('callbackURL: "/cli/activate?code=ABCD-2345"');
      expect(body).not.toContain("/api/auth/sign-in/google");

      const maliciousCode = 'ABCD-2345";</script><script>alert(1)</script>';
      const maliciousResponse = await app.fetch(
        new Request(`http://localhost/cli/activate?code=${encodeURIComponent(maliciousCode)}`),
      );
      const maliciousBody = await maliciousResponse.text();
      expect(maliciousBody).toContain('callbackURL: "/cli/activate"');
      expect(maliciousBody).not.toContain(maliciousCode);
      expect(maliciousBody).not.toContain("alert(1)");
    });
  });

  it.each(["approve", "deny"] as const)(
    "submits the rendered %s form controls and persists only that transition",
    async (action) => {
      await withTestApp(
        {
          auth: { session: { userId: "user_1" } },
          ids: ["device_1", "key_1"],
          realApiKeys: true,
          realDeviceAuthorizations: true,
        },
        async (app, runtime) => {
          await seedUser(runtime);
          const started = await startDevice(app);
          const rendered = await renderActivation(
            app,
            started,
            action === "approve" ? lowercaseVerificationCode(started) : undefined,
          );
          const storedBefore = await readStoredAuthorization(runtime);
          const storage = await readStoredAuthorizationStorage(runtime);
          const bodyText = rendered.dom.window.document.body.textContent ?? "";
          const previewText = rendered.dom.window.document.querySelector("p code")?.textContent;
          const submission = formSubmission(rendered, action);

          expect(rendered.dom.window.document.title).toBe("Approve Nusend CLI");
          expect(bodyText).toContain("nusend-cli browser test");
          expect(bodyText).toContain("contacts:read");
          expect(bodyText).not.toContain(normalizeUserCode(started.userCode));
          expect(previewText).toBe(storedBefore.userCodePreview);
          expect(storedBefore.userCodePreview).not.toBe(normalizeUserCode(started.userCode));
          expect(storedBefore.userCodeHash).toBe(userCodeHash(started.userCode));
          expect(storage.columnNames).toEqual(
            expect.arrayContaining(["device_code_hash", "user_code_hash", "user_code_preview"]),
          );
          expect(storage.columnNames).not.toContain("device_code");
          expect(storage.columnNames).not.toContain("user_code");
          expect(JSON.stringify(storage.row)).not.toContain(started.deviceCode);
          expect(JSON.stringify(storage.row)).not.toContain(normalizeUserCode(started.userCode));
          expect(submission.values.get("code")).toBe(normalizeUserCode(started.userCode));
          expect(submission.values.get("action")).toBe(action);

          const response = await submitActivation(app, rendered, action);
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toContain(
            action === "approve" ? "CLI device approved" : "CLI device denied",
          );

          const storedAfter = await readStoredAuthorization(runtime);
          if (action === "approve") {
            expect(storedAfter.approvedAt).not.toBeNull();
            expect(storedAfter.deniedAt).toBeNull();
          } else {
            expect(storedAfter.deniedAt).not.toBeNull();
            expect(storedAfter.approvedAt).toBeNull();
          }
        },
      );
    },
  );

  it("rejects a rendered form submission with a missing CSRF token", async () => {
    await withActivationForm(async (app, rendered) => {
      const submission = formSubmission(rendered, "approve");
      submission.values.delete("csrf");
      const response = await sendForm(app, rendered, submission, {
        origin: new URL(rendered.pageUrl).origin,
        referer: rendered.pageUrl,
      });
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toContain("Invalid activation token");
    });
  });

  it("rejects a rendered form submission without Origin or Referer", async () => {
    await withActivationForm(async (app, rendered) => {
      const response = await sendForm(app, rendered, formSubmission(rendered, "approve"), {});
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toContain("Invalid activation request");
    });
  });

  it("rejects a rendered form submission from a different Origin", async () => {
    await withActivationForm(async (app, rendered) => {
      const response = await sendForm(app, rendered, formSubmission(rendered, "approve"), {
        origin: "https://evil.example",
        referer: rendered.pageUrl,
      });
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toContain("Invalid activation request");
    });
  });

  it("rejects a rendered form submission with a malformed Referer", async () => {
    await withActivationForm(async (app, rendered) => {
      const response = await sendForm(app, rendered, formSubmission(rendered, "approve"), {
        origin: new URL(rendered.pageUrl).origin,
        referer: "not a url",
      });
      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toContain("Invalid activation request");
    });
  });

  it("sets Secure cookies for HTTPS requests", async () => {
    await withTestApp({}, async (app) => {
      const response = await app.fetch(
        new Request("http://localhost/cli/activate", {
          headers: { "x-forwarded-proto": "https" },
        }),
      );

      expect(response.headers.get("set-cookie")).toContain("; Secure");
    });
  });

  it("locks a user out after ten invalid codes, including from a valid code", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app) => {
        await runSequential(0, 10, async (index) => {
          const response = await app.fetch(
            new Request(`http://localhost/cli/activate?code=BAD${index}-CODE`),
          );
          expect(response.status).toBe(200);
          if (index === 0) {
            await expect(response.text()).resolves.toContain(
              "Device authorization code is invalid or expired.",
            );
          }
        });

        const started = await startDevice(app);
        const locked = await app.fetch(new Request(started.verificationUriComplete));

        expect(locked.status).toBe(403);
        await expect(locked.text()).resolves.toContain("Too many attempts. Try again later.");
      },
    );
  });

  it("rejects unknown activation actions with 400 without recording lockout failures", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app) => {
        const started = await startDevice(app);
        const rendered = await renderActivation(app, started);

        await runSequential(0, 10, async () => {
          const submission = formSubmission(rendered, "approve");
          submission.values.set("action", "frobnicate");
          const response = await sendForm(app, rendered, submission, {
            origin: new URL(rendered.pageUrl).origin,
          });
          expect(response.status).toBe(400);
          await expect(response.text()).resolves.toContain("Unknown activation action.");
        });

        const stillNotLocked = await app.fetch(new Request(started.verificationUriComplete));
        expect(stillNotLocked.status).toBe(200);
        await expect(stillNotLocked.text()).resolves.toContain("Approve Nusend CLI");
      },
    );
  });

  it("returns 500 when an internal error escapes the activation flow", async () => {
    // The default fake DeviceAuthorizations dies on inspect, driving the
    // runActivation catch-all rather than a user-error page.
    await withTestApp({ auth: { session: { userId: "user_1" } } }, async (app) => {
      const response = await app.fetch(new Request("http://localhost/cli/activate?code=ABCD-2345"));

      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toContain("Activation failed.");
    });
  });

  it("treats expired codes as invalid on the activation page and records lockout failures", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        const started = await startDevice(app);
        await expireAuthorization(runtime, started.userCode);

        await runSequential(0, 10, async () => {
          const response = await app.fetch(new Request(started.verificationUriComplete));
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toContain(
            "Device authorization code is invalid or expired.",
          );
        });

        const fresh = await startDevice(app);
        const locked = await app.fetch(new Request(fresh.verificationUriComplete));
        expect(locked.status).toBe(403);
        await expect(locked.text()).resolves.toContain("Too many attempts. Try again later.");
      },
    );
  });
});

async function withActivationForm(
  run: (app: TestApp, rendered: RenderedActivation) => Promise<void>,
): Promise<void> {
  await withTestApp(
    {
      auth: { session: { userId: "user_1" } },
      ids: ["device_1", "key_1"],
      realApiKeys: true,
      realDeviceAuthorizations: true,
    },
    async (app, runtime) => {
      await seedUser(runtime);
      const started = await startDevice(app);
      await run(app, await renderActivation(app, started));
    },
  );
}

async function startDevice(app: TestApp, origin = "http://localhost"): Promise<StartedDevice> {
  const response = await app.fetch(
    new Request(`${origin}/api/device-authorizations`, {
      body: JSON.stringify({
        clientName: "nusend-cli browser test",
        permissions: { contacts: ["read"] },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as StartedDevice;
}

function lowercaseVerificationCode(started: StartedDevice): string {
  const url = new URL(started.verificationUriComplete);
  url.searchParams.set("code", `  ${started.userCode.toLowerCase()}  `);
  return url.toString();
}

async function renderActivation(
  app: TestApp,
  started: StartedDevice,
  requestedPageUrl = started.verificationUriComplete,
): Promise<RenderedActivation> {
  const response = await app.fetch(new Request(requestedPageUrl));
  const pageUrl = requestedPageUrl;
  const dom = new JSDOM(await response.text(), { url: pageUrl });
  const form = dom.window.document.querySelector<HTMLFormElement>('form[method="post"]');
  expect(response.status).toBe(200);
  expect(form).not.toBeNull();
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "",
    dom,
    form: form!,
    pageUrl,
  };
}

function formSubmission(rendered: RenderedActivation, action: "approve" | "deny") {
  const submitter = rendered.form.querySelector<HTMLButtonElement>(`button[value="${action}"]`);
  expect(submitter).not.toBeNull();
  const formData = new rendered.dom.window.FormData(rendered.form, submitter!);
  const values = new URLSearchParams();
  formData.forEach((value, key) => {
    if (typeof value !== "string")
      throw new Error("Activation forms must contain only text fields.");
    values.append(key, value);
  });
  return {
    method: rendered.form.method.toUpperCase(),
    target: rendered.form.action,
    values,
  };
}

function submitActivation(app: TestApp, rendered: RenderedActivation, action: "approve" | "deny") {
  return sendForm(app, rendered, formSubmission(rendered, action), {
    origin: new URL(rendered.pageUrl).origin,
    referer: rendered.pageUrl,
  });
}

function sendForm(
  app: TestApp,
  rendered: RenderedActivation,
  submission: ReturnType<typeof formSubmission>,
  headers: { readonly origin?: string; readonly referer?: string },
) {
  return app.fetch(
    new Request(submission.target, {
      body: submission.values,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: rendered.cookie,
        ...(headers.origin ? { origin: headers.origin } : {}),
        ...(headers.referer ? { referer: headers.referer } : {}),
      },
      method: submission.method,
    }),
  );
}

function runSequential(
  start: number,
  end: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  return start >= end
    ? Promise.resolve()
    : task(start).then(() => runSequential(start + 1, end, task));
}

async function expireAuthorization(runtime: TestRuntime, userCode: string): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "activationTest:expire",
        "UPDATE device_authorizations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_code_hash = $userCodeHash;",
        { userCodeHash: userCodeHash(userCode) },
      );
    }),
  );
}

async function readStoredAuthorization(runtime: TestRuntime): Promise<{
  readonly approvedAt: string | null;
  readonly deniedAt: string | null;
  readonly userCodeHash: string;
  readonly userCodePreview: string;
}> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const row = yield* db.get<{
        approved_at: string | null;
        denied_at: string | null;
        user_code_hash: string;
        user_code_preview: string;
      }>(
        "activationTest:readStoredAuthorization",
        "SELECT approved_at, denied_at, user_code_hash, user_code_preview FROM device_authorizations LIMIT 1;",
      );
      if (!row) throw new Error("Expected a stored device authorization.");
      return {
        approvedAt: row.approved_at,
        deniedAt: row.denied_at,
        userCodeHash: row.user_code_hash,
        userCodePreview: row.user_code_preview,
      };
    }),
  );
}

async function readStoredAuthorizationStorage(runtime: TestRuntime): Promise<{
  readonly columnNames: readonly string[];
  readonly row: Readonly<Record<string, unknown>>;
}> {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      const columns = yield* db.all<{ name: string }>(
        "activationTest:readDeviceAuthorizationColumns",
        "PRAGMA table_info(device_authorizations);",
      );
      const row = yield* db.get<Record<string, unknown>>(
        "activationTest:readFullStoredAuthorization",
        "SELECT * FROM device_authorizations LIMIT 1;",
      );
      if (!row) throw new Error("Expected a stored device authorization.");
      return { columnNames: columns.map((column) => column.name), row };
    }),
  );
}

async function seedUser(runtime: TestRuntime): Promise<void> {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.run(
        "activationTest:seedUser",
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
         VALUES ('user_1', 'Max', 'max@example.com', 1, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
      );
    }),
  );
}
