import type { ImportListContactsRequest } from "@nusend/api-contract";

import { printContinuationHint, printJson } from "../output/format.js";
import { requireApi, UsageError, type CommandContext } from "./context.js";
import { loadJsonInput, type JsonFileSource } from "./json-input.js";
import type { CliCommand } from "./options.js";

type ListsCommand = Extract<CliCommand, { readonly kind: `lists-${string}` }>;

export async function runListsCommand(
  command: ListsCommand,
  context: CommandContext,
): Promise<void> {
  const api = requireApi(context);
  switch (command.kind) {
    case "lists-list": {
      const result = await api.listLists({ limit: command.limit, offset: command.offset });
      if (context.json) printJson(result);
      else {
        for (const list of result.items) {
          console.log(
            `${list.id}\t${list.name}\tsubscribed=${list.counts.subscribed}\tunsubscribed=${list.counts.unsubscribed}`,
          );
        }
        printContinuationHint(result.pagination.nextOffset);
      }
      return;
    }
    case "lists-get": {
      const result = await api.getList(command.id);
      if (context.json) printJson(result);
      else {
        console.log(`id: ${result.list.id}`);
        console.log(`name: ${result.list.name}`);
        console.log(
          `counts: subscribed=${result.list.counts.subscribed} unsubscribed=${result.list.counts.unsubscribed}`,
        );
      }
      return;
    }
    case "lists-create": {
      const result = await api.createList({ name: command.name });
      if (context.json) printJson(result);
      else console.log(`Created ${result.list.id}\t${result.list.name}`);
      return;
    }
    case "lists-update": {
      const result = await api.updateList(command.id, { name: command.name });
      if (context.json) printJson(result);
      else console.log(`Updated ${result.list.id}\t${result.list.name}`);
      return;
    }
    case "lists-delete":
      await api.deleteList(command.id);
      if (context.json) printJson({ deleted: command.id });
      else console.log(`Deleted ${command.id}.`);
      return;
    case "lists-contacts-list": {
      const result = await api.listListContacts(command.listId, {
        email: command.email,
        limit: command.limit,
        offset: command.offset,
        status: command.status,
      });
      if (context.json) printJson(result);
      else {
        for (const item of result.items) {
          console.log(`${item.contact.id}\t${item.contact.email}\t${item.status}`);
        }
        printContinuationHint(result.pagination.nextOffset);
      }
      return;
    }
    case "lists-contacts-import": {
      const body = await loadObjectJson(command.file, context);
      const result = await api.importListContacts(
        command.listId,
        body as ImportListContactsRequest,
      );
      if (context.json) printJson(result);
      else {
        console.log(
          `Imported into ${command.listId}: accepted=${result.counts.accepted}/${result.counts.submitted} created=${result.counts.contactsCreated} resubscribed=${result.counts.resubscribed}`,
        );
      }
      return;
    }
    case "lists-contacts-remove":
      await api.removeListContact(command.listId, command.contactId);
      if (context.json) printJson({ listId: command.listId, removed: command.contactId });
      else console.log(`Removed ${command.contactId} from ${command.listId}.`);
  }
}

async function loadObjectJson(
  source: JsonFileSource,
  context: CommandContext,
): Promise<Record<string, unknown>> {
  const body = await loadJsonInput(source, {
    readStdin: context.runtime.readStdin,
    readTextFile: context.runtime.readTextFile,
  });
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new UsageError("JSON input must be an object.", 2);
  }
  return body as Record<string, unknown>;
}
