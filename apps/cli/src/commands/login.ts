import { hostname } from "node:os";
import type { PermissionSet } from "@nusend/api-contract/permissions";

import { NusendHttpClient } from "../client/http.js";
import { NusendApi } from "../client/nusend-api.js";
import { normalizeBaseUrl, writeLoginState } from "../config/local-state.js";
import { printJson } from "../output/format.js";
import { httpTimeoutMsFromEnv, UsageError, type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type LoginCommand = Extract<CliCommand, { readonly kind: "login" }>;

export async function runLoginCommand(
  command: LoginCommand,
  context: CommandContext,
): Promise<void> {
  const baseUrl = normalizeLoginBaseUrl(
    command.baseUrlInput ?? command.baseUrl ?? context.env.NUSEND_BASE_URL ?? "",
  );
  const api = new NusendApi(
    new NusendHttpClient({ baseUrl, timeoutMs: httpTimeoutMsFromEnv(context.env) }),
  );
  const started = await api.startDeviceAuthorization({
    clientName: command.clientName ?? `nusend-cli on ${hostname() || "local"}`,
    permissions: command.permissions ?? defaultLoginPermissions(),
  });
  const expiresAt = Date.parse(started.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("Device authorization response contained an invalid expiration timestamp.");
  }

  if (context.json) {
    console.error(
      JSON.stringify({
        verification: {
          expiresAt: started.expiresAt,
          uri: started.verificationUri,
          uriComplete: started.verificationUriComplete ?? null,
          userCode: started.userCode,
        },
      }),
    );
  } else {
    console.log(
      `Open this URL to approve Nusend CLI:\n${started.verificationUriComplete ?? started.verificationUri}`,
    );
    console.log(`Code: ${started.userCode}`);
  }

  let intervalMs = safePollIntervalMs(started.intervalSeconds);
  while (true) {
    const beforeSleep = context.runtime.now();
    assertNotLocallyExpired(beforeSleep, expiresAt);
    // eslint-disable-next-line no-await-in-loop -- protocol polling is sequential.
    await context.runtime.sleep(Math.min(intervalMs, expiresAt - beforeSleep));
    assertNotLocallyExpired(context.runtime.now(), expiresAt);
    // eslint-disable-next-line no-await-in-loop -- each response determines the next poll.
    const polled = await api.pollDeviceAuthorization(started.deviceCode);
    if (polled.status === "approved") {
      await writeLoginState(
        {
          baseUrl,
          credential: {
            apiKey: polled.apiKey.key,
            apiKeyId: polled.apiKey.id,
            createdAt: polled.apiKey.createdAt,
            preview: polled.apiKey.preview,
          },
        },
        context.env,
      );
      if (context.json) {
        printJson({
          apiKey: { id: polled.apiKey.id, preview: polled.apiKey.preview },
          stored: true,
        });
      } else {
        console.log(`Logged in with key ${polled.apiKey.preview}.`);
      }
      return;
    }
    if (polled.status === "authorization_pending" || polled.status === "slow_down") {
      intervalMs = safePollIntervalMs(polled.intervalSeconds);
      continue;
    }
    if (polled.status === "access_denied") {
      throw new UsageError("Device authorization denied.", 3);
    }
    if (polled.status === "expired_token") {
      throw new UsageError("Device authorization expired.", 3);
    }
    if (polled.status === "invalid_grant") {
      throw new UsageError("Device code not recognized by the server.", 3);
    }
  }
}

function assertNotLocallyExpired(now: number, expiresAt: number): void {
  if (now >= expiresAt) throw new UsageError("Device authorization expired.", 3);
}

function safePollIntervalMs(intervalSeconds: number): number {
  const milliseconds = intervalSeconds * 1_000;
  if (!Number.isFinite(milliseconds)) return 1_000;
  return Math.max(1_000, Math.ceil(milliseconds));
}

function normalizeLoginBaseUrl(value: string): string {
  try {
    return normalizeBaseUrl(value);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Invalid base URL.", 2);
  }
}

function defaultLoginPermissions(): PermissionSet {
  return {
    api_keys: ["read", "write"],
    contacts: ["read", "write"],
    lists: ["read", "write"],
    mailings: ["read", "write"],
    operations: ["read"],
    suppressions: ["read", "write"],
  };
}
