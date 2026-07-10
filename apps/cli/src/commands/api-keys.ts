import { printJson } from "../output/format.js";
import {
  permissionsFromArgs,
  readOption,
  requireApi,
  UsageError,
  type CommandContext,
} from "./context.js";

const oneYearMs = 365 * 24 * 60 * 60 * 1000;

export async function runApiKeysCommand(args: string[], context: CommandContext): Promise<void> {
  const api = requireApi(context);
  const [subcommand, id] = args;
  switch (subcommand) {
    case "list": {
      const result = await api.listApiKeys({
        limit: readOption(args, "--limit"),
        offset: readOption(args, "--offset"),
      });
      if (context.options.json) printJson(result);
      else {
        for (const item of result.items) {
          console.log(`${item.id}\t${item.name}\t${item.preview}`);
        }
        if (result.pagination.nextOffset !== null) {
          console.log(`More keys available: rerun with --offset ${result.pagination.nextOffset}.`);
        }
      }
      return;
    }
    case "create": {
      const name = readOption(args, "--name");
      if (!name) throw new UsageError("api-keys create requires --name.", 2);
      const explicitExpiry = readOption(args, "--expires-at");
      const noExpiry = args.includes("--no-expiry");
      if (explicitExpiry && noExpiry) {
        throw new UsageError("Use either --expires-at or --no-expiry, not both.", 2);
      }
      const expiresAt = noExpiry
        ? null
        : (explicitExpiry ?? new Date(Date.now() + oneYearMs).toISOString());
      const result = await api.createApiKey({
        expiresAt,
        name,
        permissions: permissionsFromArgs(args),
      });
      if (context.options.json) printJson(result);
      else {
        console.log(
          `Created ${result.apiKey.id} (expires ${result.apiKey.expiresAt ?? "never"}). Raw key (shown once): ${result.apiKey.key}`,
        );
      }
      return;
    }
    case "revoke":
      if (!id) throw new UsageError("api-keys revoke requires <id>.", 2);
      await api.revokeApiKey(id);
      if (context.options.json) printJson({ revoked: id });
      else console.log(`Revoked ${id}.`);
      return;
    case "rotate": {
      if (!id) throw new UsageError("api-keys rotate requires <id>.", 2);
      const result = await api.rotateApiKey(id);
      if (context.options.json) printJson(result);
      else console.log(`Rotated ${id}. Raw key (shown once): ${result.apiKey.key}`);
      return;
    }
    default:
      throw new UsageError("Unknown api-keys command.", 2);
  }
}
