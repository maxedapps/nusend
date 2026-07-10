import { hostname } from "node:os";
import type { PermissionSet } from "@nusend/api-contract/permissions";

import { NusendHttpClient } from "../client/http.js";
import { NusendApi } from "../client/nusend-api.js";
import { normalizeBaseUrl, saveConfig } from "../config/profiles.js";
import { printJson } from "../output/format.js";
import {
  commandPositionals,
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
  const api = new NusendApi(new NusendHttpClient({ baseUrl }));
  const started = await api.startDeviceAuthorization({ clientName: name, permissions });

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
    started.intervalSeconds * 1000,
    baseUrl,
    context,
  );
}

async function pollUntilApproved(
  api: NusendApi,
  deviceCode: string,
  intervalMs: number,
  baseUrl: string,
  context: CommandContext,
): Promise<void> {
  await sleep(clampPollInterval(intervalMs, context.env));
  const polled = await api.pollDeviceAuthorization(deviceCode);
  if (polled.status === "approved") {
    const profile = selectedProfile(context);
    await context.store.write(profile, {
      apiKey: polled.apiKey.key,
      apiKeyId: polled.apiKey.id,
      createdAt: polled.apiKey.createdAt,
      preview: polled.apiKey.preview,
    });
    await saveConfig(
      {
        activeProfile: context.config.activeProfile ?? profile,
        profiles: { ...(context.config.profiles ?? {}), [profile]: { baseUrl } },
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
    return pollUntilApproved(api, deviceCode, polled.intervalSeconds * 1000, baseUrl, context);
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

function clampPollInterval(intervalMs: number, env: NodeJS.ProcessEnv): number {
  const raw = env.NUSEND_LOGIN_POLL_INTERVAL_MS;
  if (raw === undefined) return intervalMs;
  const clamp = Number(raw);
  return Number.isFinite(clamp) && clamp >= 0 ? Math.min(intervalMs, clamp) : intervalMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
