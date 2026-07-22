import { printContinuationHint, printJson } from "../output/format.js";
import { requireApi, type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type ContactsCommand = Extract<CliCommand, { readonly kind: `contacts-${string}` }>;

export async function runContactsCommand(
  command: ContactsCommand,
  context: CommandContext,
): Promise<void> {
  const api = requireApi(context);
  switch (command.kind) {
    case "contacts-list": {
      const result = await api.listContacts({
        email: command.email,
        limit: command.limit,
        offset: command.offset,
      });
      if (context.json) printJson(result);
      else {
        for (const contact of result.items) console.log(`${contact.id}\t${contact.email}`);
        printContinuationHint(result.pagination.nextOffset);
      }
      return;
    }
    case "contacts-get": {
      const result = await api.getContact(command.id);
      if (context.json) printJson(result);
      else console.log(`${result.contact.id}\t${result.contact.email}`);
      return;
    }
    case "contacts-create": {
      const result = await api.createContact({ email: command.email });
      if (context.json) printJson(result);
      else {
        console.log(
          `${result.created ? "Created" : "Exists"} ${result.contact.id}\t${result.contact.email}`,
        );
      }
      return;
    }
    case "contacts-update": {
      const result = await api.updateContact(command.id, { email: command.email });
      if (context.json) printJson(result);
      else console.log(`Updated ${result.contact.id}\t${result.contact.email}`);
      return;
    }
    case "contacts-delete":
      await api.deleteContact(command.id);
      if (context.json) printJson({ deleted: command.id });
      else console.log(`Deleted ${command.id}.`);
  }
}
