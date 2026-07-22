import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, runMain } from "../apps/cli/src/main.ts";
import { createServiceBridge } from "../apps/cli/src/testing/service-bridge.ts";
import {
  queryTestDatabase,
  runTestSql,
  seedTestUser,
  withTestApp,
} from "../apps/service/src/testing/layers.ts";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CLI and service", () => {
  it("logs in and exercises authenticated commands against the real app", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["device_1", "login_key", "created_key", "contact_1"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedTestUser(runtime);
        await runTestSql(
          runtime,
          "cliE2e:seedMailing",
          `INSERT INTO mailings (id, purpose, state, name, subject, html, text, created_at, updated_at)
           VALUES ('mailing_1', 'transactional', 'completed', 'E2E', 'E2E subject', '<p>E2E</p>', NULL, '2026-07-09T00:00:00.000Z', '2026-07-09T00:00:00.000Z');`,
        );
        const directory = await mkdtemp(join(tmpdir(), "nusend-cli-e2e-"));
        temporaryDirectories.push(directory);
        const env = { XDG_CONFIG_HOME: directory };
        const logs: string[] = [];
        const requestedPaths: string[] = [];
        vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
        globalThis.fetch = createServiceBridge(async (request) => {
          const response = await app.fetch(request);
          const url = new URL(request.url);
          requestedPaths.push(`${request.method} ${url.pathname}${url.search}`);
          if (request.method === "POST" && url.pathname === "/api/device-authorizations") {
            const started = (await response.clone().json()) as { userCode: string };
            await approveThroughActivation(app, started.userCode);
          }
          return response;
        });

        await expect(runCli(["login", "http://localhost"], env, noWaitRuntime())).resolves.toEqual({
          exitCode: 0,
        });
        await expect(runCli(["whoami"], env)).resolves.toEqual({ exitCode: 0 });
        const beforeKeyCreate = Date.now();
        await expect(
          runCli(["api-keys", "create", "--name", "e2e", "--permission", "contacts:read"], env),
        ).resolves.toEqual({ exitCode: 0 });
        const afterKeyCreate = Date.now();
        await expect(runCli(["contacts", "create", "user@example.com"], env)).resolves.toEqual({
          exitCode: 0,
        });
        await expect(runCli(["mailings", "list"], env)).resolves.toEqual({ exitCode: 0 });

        const contacts = await queryTestDatabase<{ email: string; id: string }>(
          runtime,
          "cliE2e:contacts",
          "SELECT id, email FROM contacts WHERE id = 'contact_1';",
        );
        const keys = await queryTestDatabase<{ expires_at: string; id: string }>(
          runtime,
          "cliE2e:keys",
          "SELECT id, expires_at FROM api_keys WHERE id = 'created_key';",
        );
        const createdExpiry = Date.parse(keys[0]?.expires_at ?? "");

        expect(requestedPaths).toContain("GET /api/mailings");
        expect(logs.join("\n")).toContain("api_key user=user_1 key=login_key");
        expect(logs.join("\n")).toContain("mailing_1\tcompleted\ttransactional\tE2E subject");
        expect(contacts).toEqual([{ email: "user@example.com", id: "contact_1" }]);
        expect(keys[0]?.id).toBe("created_key");
        expect(createdExpiry).toBeGreaterThanOrEqual(beforeKeyCreate + 365 * 24 * 60 * 60 * 1000);
        expect(createdExpiry).toBeLessThanOrEqual(afterKeyCreate + 365 * 24 * 60 * 60 * 1000);
      },
    );
  });

  it("logs in with --json and emits the verification line on stderr", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        ids: ["device_json", "json_key"],
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedTestUser(runtime);
        const directory = await mkdtemp(join(tmpdir(), "nusend-cli-e2e-json-"));
        temporaryDirectories.push(directory);
        const env = { XDG_CONFIG_HOME: directory };
        const logs: string[] = [];
        const errors: string[] = [];
        vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
        vi.spyOn(console, "error").mockImplementation((value) => errors.push(String(value)));
        globalThis.fetch = createServiceBridge(async (request) => {
          const response = await app.fetch(request);
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname === "/api/device-authorizations") {
            const started = (await response.clone().json()) as { userCode: string };
            await approveThroughActivation(app, started.userCode);
          }
          return response;
        });

        await expect(
          runCli(["--json", "login", "http://localhost"], env, noWaitRuntime()),
        ).resolves.toEqual({
          exitCode: 0,
        });

        // The app's request logging also writes to the console; only the CLI's
        // own output lines are JSON documents.
        const stderrJson = errors.filter((line) => line.startsWith("{"));
        expect(stderrJson).toHaveLength(1);
        const verification = JSON.parse(stderrJson[0] ?? "") as {
          verification: { uri: string; userCode: string };
        };
        expect(verification.verification.uri).toBe("http://localhost/cli/activate");
        expect(verification.verification.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
        const stdoutJson = logs.filter((line) => line.startsWith("{"));
        expect(stdoutJson).toHaveLength(1);
        expect(JSON.parse(stdoutJson[0] ?? "")).toMatchObject({ stored: true });
      },
    );
  });

  it("runs the admin workflow through lists, suppressions, mailings, operations, and SES reads", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        idPrefix: "wf",
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedTestUser(runtime);
        const directory = await mkdtemp(join(tmpdir(), "nusend-cli-e2e-workflow-"));
        temporaryDirectories.push(directory);
        const env = { XDG_CONFIG_HOME: directory };
        const logs: string[] = [];
        const errors: string[] = [];
        const requestedPaths: string[] = [];
        vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
        vi.spyOn(console, "error").mockImplementation((value) => errors.push(String(value)));
        globalThis.fetch = createServiceBridge(async (request) => {
          const response = await app.fetch(request);
          const url = new URL(request.url);
          requestedPaths.push(`${request.method} ${url.pathname}${url.search}`);
          if (request.method === "POST" && url.pathname === "/api/device-authorizations") {
            const started = (await response.clone().json()) as { userCode: string };
            await approveThroughActivation(app, started.userCode);
          }
          return response;
        });

        const runtimeDeps = {
          ...noWaitRuntime(),
          readTextFile: async (path: string) => {
            if (path === "import-contacts.json") {
              return JSON.stringify({
                contacts: [{ email: "alpha@example.com" }, { email: "beta@example.com" }],
              });
            }
            if (path === "mailing.json") {
              return JSON.stringify({
                html: "<p>Workflow mailing</p>",
                name: "Workflow mailing",
                purpose: "transactional",
                recipients: [{ email: "alpha@example.com" }, { email: "beta@example.com" }],
                subject: "Workflow subject",
                text: "Workflow mailing",
              });
            }
            throw new Error(`Unexpected JSON path: ${path}`);
          },
        };

        await expect(runCli(["login", "http://localhost"], env, runtimeDeps)).resolves.toEqual({
          exitCode: 0,
        });

        logs.length = 0;
        await expect(
          runCli(["--json", "lists", "create", "Workflow List"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        const createdList = lastJsonObject(logs) as {
          list: { id: string; name: string; counts: { subscribed: number } };
        };
        const listId = createdList.list.id;
        expect(createdList.list.name).toBe("Workflow List");
        expect(createdList.list.counts.subscribed).toBe(0);

        logs.length = 0;
        await expect(
          runCli(
            ["--json", "lists", "contacts", "import", listId, "--file", "import-contacts.json"],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const imported = lastJsonObject(logs) as {
          counts: { accepted: number; contactsCreated: number; submitted: number };
        };
        expect(imported.counts).toMatchObject({
          accepted: 2,
          contactsCreated: 2,
          submitted: 2,
        });

        const memberships = await queryTestDatabase<{ email: string; status: string }>(
          runtime,
          "cliE2e:memberships",
          `SELECT c.email AS email,
                  CASE WHEN m.unsubscribed_at IS NULL THEN 'subscribed' ELSE 'unsubscribed' END AS status
           FROM list_memberships m
           JOIN contacts c ON c.id = m.contact_id
           WHERE m.list_id = $listId
           ORDER BY c.email;`,
          { listId },
        );
        expect(memberships).toEqual([
          { email: "alpha@example.com", status: "subscribed" },
          { email: "beta@example.com", status: "subscribed" },
        ]);

        logs.length = 0;
        await expect(
          runCli(
            ["--json", "suppressions", "create", "alpha@example.com", "--scope", "all"],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const suppression = lastJsonObject(logs) as {
          created: boolean;
          suppression: { email: string; id: string; scope: string };
        };
        expect(suppression.created).toBe(true);
        expect(suppression.suppression).toMatchObject({
          email: "alpha@example.com",
          scope: "all",
        });

        const suppressionRows = await queryTestDatabase<{ email: string; reason: string }>(
          runtime,
          "cliE2e:suppressions",
          "SELECT email, reason FROM suppressions WHERE id = $id;",
          { id: suppression.suppression.id },
        );
        expect(suppressionRows).toEqual([{ email: "alpha@example.com", reason: "manual" }]);

        logs.length = 0;
        await expect(
          runCli(["--json", "mailings", "create", "--file", "mailing.json"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        const createdMailing = lastJsonObject(logs) as {
          counts: { deliveries: number; queued: number; suppressed: number };
          mailing: { id: string; purpose: string; state: string };
        };
        expect(createdMailing.mailing.purpose).toBe("transactional");
        expect(createdMailing.mailing.state).toBe("scheduled");
        expect(createdMailing.counts).toEqual({
          deliveries: 2,
          queued: 1,
          suppressed: 1,
        });
        const mailingId = createdMailing.mailing.id;

        const deliveryRows = await queryTestDatabase<{
          email: string;
          id: string;
          status: string;
        }>(
          runtime,
          "cliE2e:deliveries",
          `SELECT id, email, status FROM deliveries
           WHERE mailing_id = $mailingId
           ORDER BY email;`,
          { mailingId },
        );
        expect(deliveryRows).toEqual([
          expect.objectContaining({ email: "alpha@example.com", status: "suppressed" }),
          expect.objectContaining({ email: "beta@example.com", status: "queued" }),
        ]);
        const queuedDelivery = deliveryRows.find((row) => row.status === "queued");
        expect(queuedDelivery).toBeDefined();
        const deliveryId = queuedDelivery!.id;

        // Delivery detail and SES event/simulator reads are not produced by create-mailing.
        await runTestSql(
          runtime,
          "cliE2e:seedSesNotification",
          `INSERT INTO ses_notifications (
             id, sns_message_id, sns_topic_arn, sns_type, event_type, ses_message_id, raw_json, received_at
           ) VALUES (
             'notification_wf', 'sns_wf', 'arn:aws:sns:us-east-1:123456789012:nusend-test',
             'Notification', 'Delivery', 'ses_wf', '{}', '2026-07-09T12:00:00.000Z'
           );`,
        );
        await runTestSql(
          runtime,
          "cliE2e:seedSesEvent",
          `INSERT INTO ses_events (
             id, dedupe_key, notification_id, event_type, delivery_id, mailing_id, ses_message_id,
             recipient_email, action_taken, occurred_at, created_at
           ) VALUES (
             'event_wf', 'dedupe_wf', 'notification_wf', 'Delivery', $deliveryId, $mailingId,
             'ses_wf', 'beta@example.com', 'recorded', '2026-07-09T12:00:01.000Z',
             '2026-07-09T12:00:02.000Z'
           );`,
          { deliveryId, mailingId },
        );
        await runTestSql(
          runtime,
          "cliE2e:seedAlternateSesEvent",
          `INSERT INTO ses_events (
             id, dedupe_key, notification_id, event_type, delivery_id, mailing_id, ses_message_id,
             recipient_email, action_taken, occurred_at, created_at
           ) VALUES (
             'event_wf_alt', 'dedupe_wf_alt', 'notification_wf', 'Bounce', $deliveryId, $mailingId,
             'ses_wf', 'beta@example.com', 'suppressed', '2026-07-09T12:00:03.000Z',
             '2026-07-09T12:00:04.000Z'
           );`,
          { deliveryId, mailingId },
        );
        await runTestSql(
          runtime,
          "cliE2e:seedSimulatorRun",
          `INSERT INTO ses_simulator_runs (
             id, scenario, mode, purpose, mailing_id, delivery_id, recipient_email, status,
             started_at, finished_at
           ) VALUES (
             'sim_wf', 'success', 'send_acceptance', 'transactional', $mailingId, $deliveryId,
             'success@simulator.amazonses.com', 'sent', '2026-07-09T12:00:00.000Z',
             '2026-07-09T12:00:03.000Z'
           );`,
          { deliveryId, mailingId },
        );

        logs.length = 0;
        await expect(
          runCli(["--json", "operations", "summary"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        expect(lastJsonObject(logs)).toMatchObject({
          deliveries: { queued: 1, suppressed: 1 },
        });

        logs.length = 0;
        await expect(
          runCli(
            [
              "--json",
              "deliveries",
              "list",
              "--mailing-id",
              mailingId,
              "--status",
              "queued",
              "--email",
              "beta@example.com",
              "--limit",
              "5",
            ],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const deliveriesList = lastJsonObject(logs) as {
          items: Array<{ email: string; id: string; status: string }>;
        };
        expect(deliveriesList.items).toEqual([
          expect.objectContaining({
            email: "beta@example.com",
            id: deliveryId,
            status: "queued",
          }),
        ]);

        logs.length = 0;
        await expect(
          runCli(["--json", "deliveries", "get", deliveryId], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        expect(lastJsonObject(logs)).toMatchObject({
          delivery: { email: "beta@example.com", id: deliveryId, status: "queued" },
          mailing: { id: mailingId, subject: "Workflow subject" },
        });

        logs.length = 0;
        await expect(runCli(["--json", "ses", "summary"], env, runtimeDeps)).resolves.toEqual({
          exitCode: 0,
        });
        expect(lastJsonObject(logs)).toMatchObject({
          totals: expect.objectContaining({ bounce: 1, complaint: 0 }),
        });

        logs.length = 0;
        await expect(
          runCli(["--json", "ses", "readiness", "--no-aws"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        expect(lastJsonObject(logs)).toMatchObject({
          checks: expect.any(Array),
          status: expect.any(String),
        });

        logs.length = 0;
        await expect(
          runCli(["--json", "ses", "setup-guide", "--no-aws"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        expect(lastJsonObject(logs)).toMatchObject({
          steps: expect.any(Array),
          title: expect.any(String),
        });

        logs.length = 0;
        await expect(
          runCli(
            [
              "--json",
              "ses",
              "events",
              "list",
              "--mailing-id",
              mailingId,
              "--delivery-id",
              deliveryId,
              "--email",
              "beta@example.com",
              "--event-type",
              "Delivery",
              "--limit",
              "10",
              "--offset",
              "0",
            ],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const eventsList = lastJsonObject(logs) as {
          items: Array<{ eventType: string; id: string; recipientEmail: string | null }>;
        };
        expect(eventsList.items).toEqual([
          expect.objectContaining({
            eventType: "Delivery",
            id: "event_wf",
            recipientEmail: "beta@example.com",
          }),
        ]);

        logs.length = 0;
        await expect(
          runCli(["--json", "ses", "events", "get", "event_wf"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        expect(lastJsonObject(logs)).toMatchObject({
          deliveryId,
          eventType: "Delivery",
          id: "event_wf",
          mailingId,
        });

        logs.length = 0;
        await expect(
          runCli(["--json", "ses", "simulator-runs", "list"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        const simulatorList = lastJsonObject(logs) as {
          items: Array<{ id: string; scenario: string; status: string }>;
        };
        expect(simulatorList.items).toEqual([
          expect.objectContaining({ id: "sim_wf", scenario: "success", status: "sent" }),
        ]);

        logs.length = 0;
        await expect(
          runCli(["--json", "ses", "simulator-runs", "get", "sim_wf"], env, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        expect(lastJsonObject(logs)).toMatchObject({
          deliveryId,
          id: "sim_wf",
          mailingId,
          recipientEmail: "success@simulator.amazonses.com",
          status: "sent",
        });

        // Representative pagination/filter passthrough against real service routes.
        // Beta is not the first unfiltered row, so this result proves the email filter is applied.
        logs.length = 0;
        await expect(
          runCli(
            [
              "--json",
              "lists",
              "contacts",
              "list",
              listId,
              "--email",
              "beta@example.com",
              "--status",
              "subscribed",
              "--limit",
              "1",
              "--offset",
              "0",
            ],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const listContacts = lastJsonObject(logs) as {
          items: Array<{ contact: { email: string } }>;
          pagination: { limit: number; nextOffset: number | null; offset: number };
        };
        expect(listContacts.items).toEqual([
          expect.objectContaining({
            contact: expect.objectContaining({ email: "beta@example.com" }),
          }),
        ]);
        expect(listContacts.pagination).toMatchObject({ limit: 1, nextOffset: null, offset: 0 });

        logs.length = 0;
        await expect(
          runCli(
            ["--json", "lists", "contacts", "list", listId, "--limit", "1", "--offset", "0"],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const firstPage = lastJsonObject(logs) as {
          items: Array<{ contact: { email: string } }>;
          pagination: { nextOffset: number | null };
        };
        expect(firstPage.items).toEqual([
          expect.objectContaining({
            contact: expect.objectContaining({ email: "alpha@example.com" }),
          }),
        ]);
        expect(firstPage.pagination.nextOffset).toBe(1);

        logs.length = 0;
        await expect(
          runCli(
            ["--json", "lists", "contacts", "list", listId, "--limit", "1", "--offset", "1"],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const secondPage = lastJsonObject(logs) as {
          items: Array<{ contact: { email: string } }>;
          pagination: { nextOffset: number | null };
        };
        expect(secondPage.items).toEqual([
          expect.objectContaining({
            contact: expect.objectContaining({ email: "beta@example.com" }),
          }),
        ]);
        expect(secondPage.pagination.nextOffset).toBeNull();

        // Later non-matching rows make email/scope regressions visible despite limit=1.
        await runTestSql(
          runtime,
          "cliE2e:seedFilterSuppressions",
          `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at) VALUES
             ('suppression_filter_scope', 'alpha@example.com', 'marketing', NULL, 'manual', '2099-07-20T00:00:00.000Z'),
             ('suppression_filter_email', 'beta@example.com', 'all', NULL, 'manual', '2099-07-21T00:00:00.000Z');`,
        );

        logs.length = 0;
        await expect(
          runCli(
            [
              "--json",
              "suppressions",
              "list",
              "--email",
              "alpha@example.com",
              "--scope",
              "all",
              "--reason",
              "manual",
              "--limit",
              "1",
              "--offset",
              "0",
            ],
            env,
            runtimeDeps,
          ),
        ).resolves.toEqual({ exitCode: 0 });
        const suppressionsList = lastJsonObject(logs) as {
          items: Array<{ email: string; scope: string }>;
        };
        expect(suppressionsList.items).toEqual([
          expect.objectContaining({ email: "alpha@example.com", scope: "all" }),
        ]);

        expect(requestedPaths).toEqual(
          expect.arrayContaining([
            "POST /api/lists",
            `POST /api/lists/${encodeURIComponent(listId)}/contacts`,
            "POST /api/suppressions",
            "POST /api/mailings",
            "GET /api/operations/summary",
            `GET /api/operations/deliveries?email=beta%40example.com&limit=5&mailingId=${encodeURIComponent(mailingId)}&status=queued`,
            `GET /api/operations/deliveries/${encodeURIComponent(deliveryId)}`,
            "GET /api/operations/ses/summary",
            "GET /api/operations/ses/readiness?includeAws=false",
            "GET /api/operations/ses/setup-guide?includeAws=false",
            `GET /api/operations/ses/events?deliveryId=${encodeURIComponent(deliveryId)}&email=beta%40example.com&eventType=Delivery&limit=10&mailingId=${encodeURIComponent(mailingId)}&offset=0`,
            "GET /api/operations/ses/events/event_wf",
            "GET /api/operations/ses/simulator-runs",
            "GET /api/operations/ses/simulator-runs/sim_wf",
            `GET /api/lists/${encodeURIComponent(listId)}/contacts?email=beta%40example.com&limit=1&offset=0&status=subscribed`,
            `GET /api/lists/${encodeURIComponent(listId)}/contacts?limit=1&offset=0`,
            `GET /api/lists/${encodeURIComponent(listId)}/contacts?limit=1&offset=1`,
            "GET /api/suppressions?email=alpha%40example.com&limit=1&offset=0&reason=manual&scope=all",
          ]),
        );
        expect(errors.filter((line) => line.startsWith("{"))).toEqual([]);
      },
    );
  });

  it("maps least-privilege API-key grants and real 403s for each new permission family", async () => {
    await withTestApp(
      {
        auth: { session: { userId: "user_1" } },
        idPrefix: "perm",
        realApiKeys: true,
        realDeviceAuthorizations: true,
      },
      async (app, runtime) => {
        await seedTestUser(runtime);
        const directory = await mkdtemp(join(tmpdir(), "nusend-cli-e2e-perms-"));
        temporaryDirectories.push(directory);
        const ownerEnv = { XDG_CONFIG_HOME: directory };
        const logs: string[] = [];
        const errors: string[] = [];
        const requestedPaths: string[] = [];
        vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
        vi.spyOn(console, "error").mockImplementation((value) => errors.push(String(value)));
        globalThis.fetch = createServiceBridge(async (request) => {
          const response = await app.fetch(request);
          const url = new URL(request.url);
          requestedPaths.push(`${request.method} ${url.pathname}${url.search}`);
          if (request.method === "POST" && url.pathname === "/api/device-authorizations") {
            const started = (await response.clone().json()) as { userCode: string };
            await approveThroughActivation(app, started.userCode);
          }
          return response;
        });

        const runtimeDeps = {
          ...noWaitRuntime(),
          readTextFile: async (path: string) => {
            if (path === "mailing.json") {
              return JSON.stringify({
                html: "<p>Perm mailing</p>",
                purpose: "transactional",
                recipients: [{ email: "perm@example.com" }],
                subject: "Perm subject",
              });
            }
            throw new Error(`Unexpected JSON path: ${path}`);
          },
        };

        await expect(runCli(["login", "http://localhost"], ownerEnv, runtimeDeps)).resolves.toEqual(
          {
            exitCode: 0,
          },
        );

        // Seed one list so lists:read has a real target without needing write.
        logs.length = 0;
        await expect(
          runCli(["--json", "lists", "create", "Permission List"], ownerEnv, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        const listId = (lastJsonObject(logs) as { list: { id: string } }).list.id;

        const families: Array<{
          readonly allowed: readonly string[];
          readonly allowedPath: string | RegExp;
          readonly denied: readonly string[];
          readonly deniedPath: string | RegExp;
          readonly name: string;
          readonly permissions: readonly string[];
        }> = [
          {
            allowed: ["--json", "lists", "list", "--limit", "1"],
            allowedPath: /^GET \/api\/lists(\?|$)/,
            denied: ["--json", "suppressions", "create", "denied@example.com", "--scope", "all"],
            deniedPath: "POST /api/suppressions",
            name: "lists-read",
            permissions: ["lists:read"],
          },
          {
            allowed: ["--json", "lists", "create", "Lists Write Family"],
            allowedPath: "POST /api/lists",
            denied: ["--json", "operations", "summary"],
            deniedPath: "GET /api/operations/summary",
            name: "lists-write",
            permissions: ["lists:write"],
          },
          {
            allowed: ["--json", "suppressions", "list", "--limit", "1"],
            allowedPath: /^GET \/api\/suppressions(\?|$)/,
            denied: ["--json", "lists", "create", "Denied List"],
            deniedPath: "POST /api/lists",
            name: "suppressions-read",
            permissions: ["suppressions:read"],
          },
          {
            allowed: [
              "--json",
              "suppressions",
              "create",
              "family-write@example.com",
              "--scope",
              "all",
            ],
            allowedPath: "POST /api/suppressions",
            denied: ["--json", "operations", "summary"],
            deniedPath: "GET /api/operations/summary",
            name: "suppressions-write",
            permissions: ["suppressions:write"],
          },
          {
            allowed: ["--json", "mailings", "create", "--file", "mailing.json"],
            allowedPath: "POST /api/mailings",
            denied: ["--json", "operations", "summary"],
            deniedPath: "GET /api/operations/summary",
            name: "mailings-write",
            permissions: ["mailings:write"],
          },
          {
            allowed: ["--json", "operations", "summary"],
            allowedPath: "GET /api/operations/summary",
            denied: ["--json", "lists", "create", "Ops Denied"],
            deniedPath: "POST /api/lists",
            name: "operations-read",
            permissions: ["operations:read"],
          },
        ];

        // Permission families must run sequentially: each creates a key then probes allow/deny.
        for (const family of families) {
          logs.length = 0;
          errors.length = 0;
          const createArgs = [
            "--json",
            "api-keys",
            "create",
            "--name",
            family.name,
            ...family.permissions.flatMap((permission) => ["--permission", permission]),
          ];
          // oxlint-disable-next-line no-await-in-loop -- sequential key create + allow/deny probes share captured logs/paths.
          await expect(runCli(createArgs, ownerEnv, runtimeDeps)).resolves.toEqual({ exitCode: 0 });
          const createdKey = lastJsonObject(logs) as { apiKey: { key: string } };
          const scopedEnv = {
            NUSEND_API_KEY: createdKey.apiKey.key,
            NUSEND_BASE_URL: "http://localhost",
          };

          const pathCountBeforeAllowed = requestedPaths.length;
          logs.length = 0;
          errors.length = 0;
          // oxlint-disable-next-line no-await-in-loop -- sequential allow probe per permission family.
          await expect(runCli([...family.allowed], scopedEnv, runtimeDeps)).resolves.toEqual({
            exitCode: 0,
          });
          expect(lastJsonObject(logs)).toEqual(expect.any(Object));
          expect(
            requestedPaths
              .slice(pathCountBeforeAllowed)
              .some((path) => matchPath(path, family.allowedPath)),
          ).toBe(true);

          // SES is authorized by operations:read; prove it under the operations family.
          if (family.name === "operations-read") {
            const pathCountBeforeSes = requestedPaths.length;
            logs.length = 0;
            // oxlint-disable-next-line no-await-in-loop -- SES under operations:read is part of the sequential family probe.
            await expect(
              runCli(["--json", "ses", "summary"], scopedEnv, runtimeDeps),
            ).resolves.toEqual({ exitCode: 0 });
            expect(lastJsonObject(logs)).toEqual(expect.any(Object));
            expect(requestedPaths.slice(pathCountBeforeSes)).toContain(
              "GET /api/operations/ses/summary",
            );
          }

          const pathCountBeforeDenied = requestedPaths.length;
          logs.length = 0;
          errors.length = 0;
          // oxlint-disable-next-line no-await-in-loop -- sequential deny/403 probe per permission family.
          await expect(runMain([...family.denied], scopedEnv, runtimeDeps)).resolves.toEqual({
            exitCode: 4,
          });
          expect(lastJsonObject(errors)).toEqual({
            error: {
              code: "forbidden",
              message: "API key does not have the required permissions.",
            },
          });
          expect(
            requestedPaths
              .slice(pathCountBeforeDenied)
              .some((path) => matchPath(path, family.deniedPath)),
          ).toBe(true);
        }

        // Sanity: the owner key still works after scoped-key probes.
        logs.length = 0;
        await expect(
          runCli(["--json", "lists", "get", listId], ownerEnv, runtimeDeps),
        ).resolves.toEqual({ exitCode: 0 });
        expect(lastJsonObject(logs)).toMatchObject({ list: { id: listId } });
      },
    );
  });
});

function noWaitRuntime() {
  return {
    now: Date.now,
    sleep: async (_milliseconds: number) => undefined,
  };
}

function lastJsonObject(lines: readonly string[]): unknown {
  const jsonLines = lines.filter((line) => line.startsWith("{"));
  expect(jsonLines.length).toBeGreaterThan(0);
  return JSON.parse(jsonLines[jsonLines.length - 1] ?? "");
}

function matchPath(path: string, expected: string | RegExp): boolean {
  return typeof expected === "string" ? path === expected : expected.test(path);
}

async function approveThroughActivation(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  userCode: string,
): Promise<void> {
  const get = await app.fetch(
    new Request(`http://localhost/cli/activate?code=${encodeURIComponent(userCode)}`),
  );
  const html = await get.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  expect(csrf).toBeTruthy();

  const approved = await app.fetch(
    new Request("http://localhost/cli/activate", {
      body: new URLSearchParams({ action: "approve", code: userCode, csrf: csrf ?? "" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: get.headers.get("set-cookie") ?? "",
        origin: "http://localhost",
      },
      method: "POST",
    }),
  );
  expect(approved.status).toBe(200);
  await expect(approved.text()).resolves.toContain("CLI device approved");
}
