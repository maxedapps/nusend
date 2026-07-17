import { loadLocalState, removeStoredCredential, type LocalState } from "../config/local-state.js";
import { printJson } from "../output/format.js";
import { type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type LogoutCommand = Extract<CliCommand, { readonly kind: "logout" }>;

export async function runLogoutCommand(
  command: LogoutCommand,
  context: CommandContext,
  snapshot?: LocalState,
  revokeSetupError?: unknown,
): Promise<void> {
  if (context.env.NUSEND_API_KEY) {
    if (command.revoke) {
      const message =
        "NUSEND_API_KEY cannot be revoked without its API-key ID; unset it and revoke the key by ID if needed.";
      if (context.json) {
        console.error(JSON.stringify({ warning: { code: "revoke_unsupported", message } }));
      } else {
        console.error(`Warning: ${message}`);
      }
    }
    if (context.json) printJson({ loggedOut: false, reason: "environment_credential" });
    else console.log("NUSEND_API_KEY remains active; unset it to log out.");
    return;
  }

  const credential = (snapshot ?? (await loadLocalState(context.env))).credential;
  if (!credential) {
    if (context.json) printJson({ loggedOut: false, reason: "not_logged_in" });
    else console.log("No credential stored.");
    return;
  }

  if (command.revoke) {
    try {
      if (revokeSetupError) throw revokeSetupError;
      if (!credential.apiKeyId || !context.api) {
        throw new Error("Stored credential cannot be revoked remotely.");
      }
      await context.api.revokeApiKey(credential.apiKeyId);
    } catch (error) {
      const message = `Warning: remote key revocation failed; local credential was removed: ${error instanceof Error ? error.message : String(error)}`;
      if (context.json) {
        console.error(JSON.stringify({ warning: { code: "revoke_failed", message } }));
      } else {
        console.error(message);
      }
    }
  }

  await removeStoredCredential(context.env);
  if (context.json) printJson({ loggedOut: true });
  else console.log("Logged out.");
}
