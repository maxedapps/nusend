import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CliHttpError } from "./client/errors.js";
import { UsageError } from "./commands/context.js";
import { saveConfig } from "./config/profiles.js";
import { isMainEntry, printError, runCli, runMain } from "./main.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("runCli", () => {
  it("reports package version and recognizes encoded main entry paths", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    await expect(runCli(["--version"], {})).resolves.toEqual({ exitCode: 0 });
    expect(log).toHaveBeenCalledWith(packageJson.version);

    const spaced = "/tmp/with space/main.js";
    expect(isMainEntry(spaced, pathToFileURL(spaced).href)).toBe(true);
    expect(isMainEntry("/tmp/main.js", pathToFileURL("/tmp/other.js").href)).toBe(false);
    expect(isMainEntry(undefined, pathToFileURL("/tmp/main.js").href)).toBe(false);
    const windows = String.raw`C:\Program Files\Nusend\main.js`;
    expect(isMainEntry(windows, pathToFileURL(windows).href)).toBe(true);

    const directory = await mkdtemp("/tmp/nusend entry.");
    const entry = `${directory}/main.js`;
    await writeFile(entry, "");
    try {
      expect(isMainEntry(entry, pathToFileURL(realpathSync(entry)).href)).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("formats every error class consistently in human and JSON modes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases = [
      [new UsageError("Bad arguments.", 2), "usage"],
      [new UsageError("Authentication required.", 3), "unauthenticated"],
      [new CliHttpError(409, "conflict", "Conflict."), "conflict"],
      [new Error("Unexpected."), "internal_error"],
    ] as const;

    for (const [value, code] of cases) {
      error.mockClear();
      printError(value, true);
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ error: { code } });

      error.mockClear();
      printError(value, false);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/^Error: /);
    }

    error.mockClear();
    await expect(runMain(["--json", "unknown"], {})).resolves.toEqual({ exitCode: 2 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "usage" },
    });
  });

  it("prints whoami JSON using env config and credential", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        principal: {
          kind: "api_key",
          userId: "user_1",
          apiKeyId: "key_1",
          permissions: { contacts: ["read"] },
        },
      }),
    ) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["--json", "whoami"], {
        NUSEND_API_KEY: "nusend_test",
        NUSEND_BASE_URL: "https://mail.example.com",
      }),
    ).resolves.toEqual({ exitCode: 0 });

    expect(log.mock.calls.join("\n")).toContain('"apiKeyId": "key_1"');
  });

  it("prints sorted API-key permissions in human whoami output", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        principal: {
          apiKeyId: "key_1",
          kind: "api_key",
          permissions: { mailings: ["read"], contacts: ["write", "read"] },
          userId: "user_1",
        },
      }),
    ) as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["whoami"], {
      NUSEND_API_KEY: "nusend_test",
      NUSEND_BASE_URL: "https://mail.example.com",
    });

    expect(log).toHaveBeenCalledWith(
      "api_key user=user_1 key=key_1 permissions: contacts:read, contacts:write, mailings:read",
    );
  });

  it("returns exit 3 with a hint when whoami is unauthenticated", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runMain(["whoami"], {
        NUSEND_BASE_URL: "https://mail.example.com",
        XDG_CONFIG_HOME: `/tmp/nusend-no-auth-${process.pid}-${Math.random()}`,
      }),
    ).resolves.toEqual({ exitCode: 3 });

    expect(error.mock.calls.flat().join("\n")).toContain("Authentication required");
    expect(error.mock.calls.flat().join("\n")).toContain("Hint:");
  });

  it("maps unexpected, authentication, and API failures to exits 1, 3, and 4", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runCase = async (response: Response, exitCode: number, code: string) => {
      globalThis.fetch = vi.fn(async () => response) as unknown as typeof fetch;
      error.mockClear();
      await expect(
        runMain(["--json", "whoami"], {
          NUSEND_API_KEY: "nusend_test",
          NUSEND_BASE_URL: "https://mail.example.com",
        }),
      ).resolves.toEqual({ exitCode });
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ error: { code } });
    };

    await runCase(new Response("not-json", { status: 200 }), 1, "internal_error");
    await runCase(
      Response.json(
        { error: { code: "unauthenticated", message: "Invalid API key." } },
        { status: 401 },
      ),
      3,
      "unauthenticated",
    );
    await runCase(
      Response.json({ error: { code: "conflict", message: "Conflict." } }, { status: 409 }),
      4,
      "conflict",
    );
  });

  it("maps non-JSON API failures to exit 4", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>failed</html>", {
          headers: { "content-type": "text/html" },
          status: 500,
        }),
    ) as unknown as typeof fetch;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runMain(["--json", "whoami"], {
        NUSEND_API_KEY: "nusend_test",
        NUSEND_BASE_URL: "https://mail.example.com",
      }),
    ).resolves.toEqual({ exitCode: 4 });

    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "http_error" },
    });
  });

  it("recognizes --version only as the first token but keeps --help global", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const isolated = { XDG_CONFIG_HOME: `/tmp/nusend-version-${process.pid}-${Math.random()}` };

    await expect(runCli(["contacts", "--version"], isolated)).rejects.toMatchObject({
      exitCode: 2,
      message: "Unknown contacts command: --version",
    });

    await expect(runCli(["contacts", "get", "--help"], isolated)).resolves.toEqual({
      exitCode: 0,
    });
    expect(log.mock.calls.flat().join("\n")).toContain("Usage:");
  });

  it("reports usage before authentication for bare command families", async () => {
    const isolated = { XDG_CONFIG_HOME: `/tmp/nusend-bare-${process.pid}-${Math.random()}` };

    await expect(runCli(["mailings"], isolated)).rejects.toMatchObject({
      exitCode: 2,
      message: "Unknown mailings command.",
    });
  });

  it("splits --opt=value tokens on the first equals sign before parsing", async () => {
    const fetchMock = vi.fn(async (request: Request | URL | string, _init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toBe("https://mail.example.com/api/api-keys");
      return Response.json(
        {
          apiKey: {
            createdAt: "2026-07-09T00:00:00.000Z",
            expiresAt: null,
            id: "key_1",
            key: "nusend_raw",
            lastUsedAt: null,
            name: "a=b",
            permissions: { contacts: ["read"] },
            preview: "nusend…raw",
            revokedAt: null,
          },
        },
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(
        [
          "--base-url=https://mail.example.com",
          "api-keys",
          "create",
          "--name=a=b",
          "--no-expiry",
          "--permission=contacts:read",
        ],
        { NUSEND_API_KEY: "nusend_test" },
      ),
    ).resolves.toEqual({ exitCode: 0 });

    const init = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "a=b",
      permissions: { contacts: ["read"] },
    });

    await expect(
      runCli(["--json=true", "whoami"], { NUSEND_API_KEY: "nusend_test" }),
    ).rejects.toMatchObject({ exitCode: 2, message: "--json does not take a value." });

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runMain(["--json=true", "whoami"], { NUSEND_API_KEY: "nusend_test" }),
    ).resolves.toEqual({ exitCode: 2 });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      error: { code: "usage" },
    });

    await expect(
      runCli(["api-keys", "create", "--name=", "--no-expiry"], {
        NUSEND_API_KEY: "nusend_test",
        NUSEND_BASE_URL: "https://mail.example.com",
      }),
    ).rejects.toMatchObject({ exitCode: 2, message: "--name requires a value." });

    await expect(
      runCli(["api-keys", "create", "--name", "x", "--permission"], {
        NUSEND_API_KEY: "nusend_test",
        NUSEND_BASE_URL: "https://mail.example.com",
      }),
    ).rejects.toMatchObject({ exitCode: 2, message: "Missing value for --permission." });
  });

  it("rejects arguments on whoami", async () => {
    const isolated = { XDG_CONFIG_HOME: `/tmp/nusend-whoami-${process.pid}-${Math.random()}` };

    await expect(runCli(["whoami", "--version"], isolated)).rejects.toMatchObject({
      exitCode: 2,
      message: "whoami takes no arguments: --version",
    });
  });

  it("errors clearly when the stored profile base URL carries a path", async () => {
    const directory = await mkdtemp("/tmp/nusend-prefixed-");
    try {
      const env = { NUSEND_API_KEY: "nusend_test", XDG_CONFIG_HOME: directory };
      await saveConfig(
        {
          activeProfile: "default",
          profiles: { default: { baseUrl: "https://mail.example.com/nusend" } },
        },
        env,
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(runMain(["whoami"], env)).resolves.toEqual({ exitCode: 2 });

      expect(error.mock.calls.flat().join("\n")).toContain("must not include a path");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("treats missing option values and invalid login URLs as usage errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runMain(["--profile"], {})).resolves.toEqual({ exitCode: 2 });
    expect(error.mock.calls.flat().join("\n")).toContain("--profile requires a value");

    error.mockClear();
    await expect(
      runMain(["login", "not-a-url"], {
        XDG_CONFIG_HOME: `/tmp/nusend-invalid-url-${process.pid}-${Math.random()}`,
      }),
    ).resolves.toEqual({ exitCode: 2 });
    expect(error.mock.calls.flat().join("\n")).toContain("Error:");
  });

  it("uses --base-url for login when command options have values", async () => {
    const fetchMock = vi.fn(async (request: Request | URL | string, _init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toContain("https://mail.example.com/api/device-authorizations");
      if (url.endsWith("/token")) return Response.json({ status: "expired_token" });
      return Response.json({
        deviceCode: "device",
        userCode: "ABCD-1234",
        verificationUri: "https://mail.example.com/cli/activate",
        expiresAt: "2026-07-09T00:00:00.000Z",
        intervalSeconds: 0,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runCli(
        [
          "--base-url",
          "https://mail.example.com",
          "login",
          "--name",
          "ci",
          "--permission",
          "contacts:read",
        ],
        {},
      ),
    ).rejects.toThrow(/Device authorization/);

    expect(fetchMock).toHaveBeenCalled();
  });

  it("creates contacts through the API", async () => {
    const fetchMock = vi.fn(async (request: Request | URL | string, init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toBe("https://mail.example.com/api/contacts");
      expect(init?.method).toBe("POST");
      return Response.json(
        {
          contact: {
            id: "contact_1",
            email: "user@example.com",
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
          },
          created: true,
        },
        { status: 201 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["contacts", "create", "user@example.com"], {
        NUSEND_API_KEY: "nusend_test",
        NUSEND_BASE_URL: "https://mail.example.com",
      }),
    ).resolves.toEqual({ exitCode: 0 });

    const init = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ email: "user@example.com" });
  });

  it("lists contacts with query flags as JSON", async () => {
    const fetchMock = vi.fn(async (request: Request | URL | string) => {
      const url = request instanceof Request ? request.url : String(request);
      expect(url).toBe(
        "https://mail.example.com/api/contacts?email=user%40example.com&limit=1&offset=2",
      );
      return Response.json({
        items: [
          {
            id: "contact_1",
            email: "user@example.com",
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
          },
        ],
        pagination: { limit: 1, nextOffset: null, offset: 2 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(
        [
          "--json",
          "contacts",
          "list",
          "--email",
          "user@example.com",
          "--limit",
          "1",
          "--offset",
          "2",
        ],
        { NUSEND_API_KEY: "nusend_test", NUSEND_BASE_URL: "https://mail.example.com" },
      ),
    ).resolves.toEqual({ exitCode: 0 });

    expect(log.mock.calls.join("\n")).toContain('"contact_1"');
  });

  it("creates API keys with parsed permissions", async () => {
    const fetchMock = vi.fn(async (request: Request | URL | string, _init?: RequestInit) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url.endsWith("/api/api-keys")) {
        return Response.json(
          {
            apiKey: {
              id: "key_1",
              key: "nusend_raw",
              name: "ci",
              preview: "nusend…raw",
              permissions: { contacts: ["read"] },
              createdAt: "2026-07-09T00:00:00.000Z",
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
            },
          },
          { status: 201 },
        );
      }
      return Response.json(
        { error: { code: "not_found", message: "Not found." } },
        { status: 404 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["api-keys", "create", "--name", "ci", "--permission", "contacts:read"], {
        NUSEND_API_KEY: "nusend_test",
        NUSEND_BASE_URL: "https://mail.example.com",
      }),
    ).resolves.toEqual({ exitCode: 0 });

    const init = fetchMock.mock.calls[0]?.[1] as unknown as RequestInit;
    const requestBody = JSON.parse(String(init.body)) as {
      expiresAt: string | null;
      name: string;
      permissions: Record<string, string[]>;
    };
    expect(requestBody).toMatchObject({
      name: "ci",
      permissions: { contacts: ["read"] },
    });
    expect(Date.parse(requestBody.expiresAt ?? "")).toBeGreaterThan(
      Date.now() + 364 * 24 * 60 * 60 * 1000,
    );
  });
});
