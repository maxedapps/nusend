import { printContinuationHint, printJson } from "../output/format.js";
import { requireApi, type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type ApiKeysCommand = Extract<CliCommand, { readonly kind: `api-keys-${string}` }>;
const oneYearMs = 365 * 24 * 60 * 60 * 1000;

export async function runApiKeysCommand(
  command: ApiKeysCommand,
  context: CommandContext,
): Promise<void> {
  const api = requireApi(context);
  switch (command.kind) {
    case "api-keys-list": {
      const result = await api.listApiKeys({ limit: command.limit, offset: command.offset });
      if (context.json) printJson(result);
      else {
        for (const item of result.items) console.log(`${item.id}\t${item.name}\t${item.preview}`);
        printContinuationHint(result.pagination.nextOffset);
      }
      return;
    }
    case "api-keys-create": {
      const expiresAt =
        command.expiresAt === undefined
          ? new Date(context.runtime.now() + oneYearMs).toISOString()
          : command.expiresAt;
      const result = await api.createApiKey({
        expiresAt,
        name: command.name,
        permissions: command.permissions,
      });
      if (context.json) printJson(result);
      else {
        console.log(
          `Created ${result.apiKey.id} (expires ${result.apiKey.expiresAt ?? "never"}). Raw key (shown once): ${result.apiKey.key}`,
        );
      }
      return;
    }
    case "api-keys-revoke":
      await api.revokeApiKey(command.id);
      if (context.json) printJson({ revoked: command.id });
      else console.log(`Revoked ${command.id}.`);
      return;
    case "api-keys-rotate": {
      const result = await api.rotateApiKey(command.id);
      if (context.json) printJson(result);
      else console.log(`Rotated ${command.id}. Raw key (shown once): ${result.apiKey.key}`);
    }
  }
}
