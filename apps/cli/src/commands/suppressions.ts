import { printContinuationHint, printJson } from "../output/format.js";
import { requireApi, type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type SuppressionsCommand = Extract<CliCommand, { readonly kind: `suppressions-${string}` }>;

export async function runSuppressionsCommand(
  command: SuppressionsCommand,
  context: CommandContext,
): Promise<void> {
  const api = requireApi(context);
  switch (command.kind) {
    case "suppressions-list": {
      const result = await api.listSuppressions({
        email: command.email,
        limit: command.limit,
        listId: command.listId,
        offset: command.offset,
        reason: command.reason,
        scope: command.scope,
      });
      if (context.json) printJson(result);
      else {
        for (const item of result.items) {
          const list = item.listId ? `\tlist=${item.listId}` : "";
          console.log(`${item.id}\t${item.email}\t${item.scope}\t${item.reason}${list}`);
        }
        printContinuationHint(result.pagination.nextOffset);
      }
      return;
    }
    case "suppressions-create": {
      const result = await api.createSuppression({
        email: command.email,
        listId: command.listId,
        scope: command.scope,
      });
      if (context.json) printJson(result);
      else {
        console.log(
          `${result.created ? "Created" : "Exists"} ${result.suppression.id}\t${result.suppression.email}\t${result.suppression.scope}`,
        );
      }
      return;
    }
    case "suppressions-delete":
      await api.deleteSuppression(command.id);
      if (context.json) printJson({ deleted: command.id });
      else console.log(`Deleted ${command.id}.`);
  }
}
