import type { StoredCredential } from "../credentials/store.js";
import { printJson } from "../output/format.js";
import { selectedProfile, type CommandContext } from "./context.js";

export async function runLogoutCommand(
  args: string[],
  context: CommandContext,
  revokeSetupError?: unknown,
  localSnapshot?: {
    readonly credential: StoredCredential | null;
    readonly storedCredentialKept: boolean;
  },
): Promise<void> {
  const profile = selectedProfile(context);
  if (context.env.NUSEND_API_KEY) {
    if (args.includes("--revoke")) {
      const message =
        "NUSEND_API_KEY cannot be revoked without its API-key ID; unset it and revoke the key by ID if needed.";
      if (context.options.json) {
        console.error(JSON.stringify({ warning: { code: "revoke_unsupported", message } }));
      } else {
        console.error(`Warning: ${message}`);
      }
    }
    const storedCredentialKept =
      localSnapshot?.storedCredentialKept ?? (await context.store.hasStored(profile));
    if (context.options.json) {
      printJson({
        loggedOut: false,
        profile,
        reason: "environment_credential",
        storedCredentialKept,
      });
    } else {
      console.log(`NUSEND_API_KEY remains active for profile ${profile}; unset it to log out.`);
      if (storedCredentialKept) {
        console.log(`Stored credential for profile ${profile} was kept.`);
      }
    }
    return;
  }

  const credential = localSnapshot ? localSnapshot.credential : await context.store.read(profile);
  if (!credential) {
    const removedConcurrentCredential = await context.store.delete(profile);
    if (removedConcurrentCredential) {
      if (context.options.json) printJson({ loggedOut: true, profile });
      else console.log(`Logged out profile ${profile}.`);
    } else if (context.options.json) {
      printJson({ loggedOut: false, profile, reason: "not_logged_in" });
    } else {
      console.log(`No credential stored for profile ${profile}.`);
    }
    return;
  }

  if (args.includes("--revoke")) {
    try {
      if (revokeSetupError) throw revokeSetupError;
      if (!credential.apiKeyId || !context.api) {
        throw new Error("Stored credential cannot be revoked remotely.");
      }
      await context.api.revokeApiKey(credential.apiKeyId);
    } catch (error) {
      const message = `Warning: remote key revocation failed; local credential was removed: ${error instanceof Error ? error.message : String(error)}`;
      if (context.options.json) {
        console.error(JSON.stringify({ warning: { code: "revoke_failed", message } }));
      } else {
        console.error(message);
      }
    }
  }

  await context.store.delete(profile);
  if (context.options.json) printJson({ loggedOut: true, profile });
  else console.log(`Logged out profile ${profile}.`);
}
