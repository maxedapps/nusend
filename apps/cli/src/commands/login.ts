import { hostname } from "node:os";
import type { PermissionSet } from "@nusend/api-contract/permissions";

import { NusendHttpClient } from "../client/http.js";
import { NusendApi } from "../client/nusend-api.js";
import { updateLoginState } from "../config/local-state.js";
import { normalizeBaseUrl } from "../config/profiles.js";
import { printJson } from "../output/format.js";
import {
  commandPositionals,
  httpTimeoutMsFromEnv,
  permissionsFromArgs,
  readOption,
  selectedProfile,
  UsageError,
  type CommandContext,
} from "./context.js";

export async function runLoginCommand(args: string[], context: CommandContext): Promise<void> {
  const positional = commandPositionals(args, ["--name", "--permission"]);
  const baseUrl = normalizeLoginBaseUrl(
    positional[0] ?? context.options.baseUrl ?? context.env.NUSEND_BASE_URL ?? "",
  );
  const name = readOption(args, "--name") ?? `nusend-cli on ${hostname() || "local"}`;
  const permissions = permissionsFromArgs(args, defaultLoginPermissions());
  const api = new NusendApi(
    new NusendHttpClient({ baseUrl, timeoutMs: httpTimeoutMsFromEnv(context.env) }),
  );
  const started = await api.startDeviceAuthorization({ clientName: name, permissions });
  const expiresAt = Date.parse(started.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error("Device authorization response contained an invalid expiration timestamp.");
  }

  if (context.options.json) {
    console.error(
      JSON.stringify({
        verification: {
          uri: started.verificationUri,
          uriComplete: started.verificationUriComplete ?? null,
          userCode: started.userCode,
          expiresAt: started.expiresAt,
        },
      }),
    );
  } else {
    console.log(
      `Open this URL to approve Nusend CLI:\n${started.verificationUriComplete ?? started.verificationUri}`,
    );
    console.log(`Code: ${started.userCode}`);
  }

  await pollUntilApproved(
    api,
    started.deviceCode,
    started.intervalSeconds,
    expiresAt,
    baseUrl,
    context,
  );
}

async function pollUntilApproved(
  api: NusendApi,
  deviceCode: string,
  initialIntervalSeconds: number,
  expiresAt: number,
  baseUrl: string,
  context: CommandContext,
): Promise<void> {
  let intervalMs = safePollIntervalMs(initialIntervalSeconds);

  while (true) {
    const beforeSleep = context.runtime.now();
    assertNotLocallyExpired(beforeSleep, expiresAt);
    // eslint-disable-next-line no-await-in-loop -- protocol polling must remain sequential.
    await context.runtime.sleep(Math.min(intervalMs, expiresAt - beforeSleep));

    // A token request is never started at or after local expiry. Once started,
    // the server remains authoritative and an approved response is accepted.
    assertNotLocallyExpired(context.runtime.now(), expiresAt);
    // eslint-disable-next-line no-await-in-loop -- each response determines the next poll.
    const polled = await api.pollDeviceAuthorization(deviceCode);
    if (polled.status === "approved") {
      const profile = selectedProfile(context);
      // eslint-disable-next-line no-await-in-loop -- approval terminates the loop after persistence.
      await updateLoginState(
        {
          baseUrl,
          credential: {
            apiKey: polled.apiKey.key,
            apiKeyId: polled.apiKey.id,
            createdAt: polled.apiKey.createdAt,
            preview: polled.apiKey.preview,
          },
          profile,
        },
        context.env,
      );

      if (context.options.json) {
        printJson({
          profile,
          stored: true,
          apiKey: { id: polled.apiKey.id, preview: polled.apiKey.preview },
        });
      } else {
        console.log(`Logged in as profile ${profile} with key ${polled.apiKey.preview}.`);
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
