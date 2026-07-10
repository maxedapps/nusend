import { printJson } from "../output/format.js";
import { readOption, requireApi, UsageError, type CommandContext } from "./context.js";

export async function runContactsCommand(args: string[], context: CommandContext): Promise<void> {
  const api = requireApi(context);
  const [subcommand, idOrEmail, email] = args;
  switch (subcommand) {
    case "list": {
      const result = await api.listContacts({
        email: readOption(args, "--email"),
        limit: readOption(args, "--limit"),
        offset: readOption(args, "--offset"),
      });
      if (context.options.json) printJson(result);
      else for (const contact of result.items) console.log(`${contact.id}\t${contact.email}`);
      return;
    }
    case "get": {
      if (!idOrEmail) throw new UsageError("contacts get requires <id>.", 2);
      const result = await api.getContact(idOrEmail);
      if (context.options.json) printJson(result);
      else console.log(`${result.contact.id}\t${result.contact.email}`);
      return;
    }
    case "create": {
      if (!idOrEmail) throw new UsageError("contacts create requires <email>.", 2);
      const result = await api.createContact({ email: idOrEmail });
      if (context.options.json) printJson(result);
      else {
        console.log(
          `${result.created ? "Created" : "Exists"} ${result.contact.id}\t${result.contact.email}`,
        );
      }
      return;
    }
    case "update": {
      if (!idOrEmail || !email) {
        throw new UsageError("contacts update requires <id> <email>.", 2);
      }
      const result = await api.updateContact(idOrEmail, { email });
      if (context.options.json) printJson(result);
      else console.log(`Updated ${result.contact.id}\t${result.contact.email}`);
      return;
    }
    case "delete":
      if (!idOrEmail) throw new UsageError("contacts delete requires <id>.", 2);
      await api.deleteContact(idOrEmail);
      if (context.options.json) printJson({ deleted: idOrEmail });
      else console.log(`Deleted ${idOrEmail}.`);
      return;
    default:
      throw new UsageError("Unknown contacts command.", 2);
  }
}
