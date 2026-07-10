import { printJson } from "../output/format.js";
import { readOption, requireApi, UsageError, type CommandContext } from "./context.js";

export async function runMailingsCommand(args: string[], context: CommandContext): Promise<void> {
  const api = requireApi(context);
  const [subcommand, id] = args;
  switch (subcommand) {
    case "list": {
      const result = await api.listMailings({
        limit: readOption(args, "--limit"),
        offset: readOption(args, "--offset"),
      });
      if (context.options.json) printJson(result);
      else {
        for (const mailing of result.items) {
          const total = Object.values(mailing.counts).reduce((sum, count) => sum + count, 0);
          console.log(
            `${mailing.id}\t${mailing.state}\t${mailing.purpose}\t${mailing.subject}\t${mailing.counts.sent}/${total}`,
          );
        }
      }
      return;
    }
    case "get": {
      if (!id) throw new UsageError("mailings get requires <id>.", 2);
      const result = await api.getMailing(id);
      if (context.options.json) {
        printJson(result);
      } else {
        const mailing = result.mailing;
        const total = Object.values(mailing.counts).reduce((sum, count) => sum + count, 0);
        console.log(`id: ${mailing.id}`);
        console.log(`state: ${mailing.state}`);
        console.log(`purpose: ${mailing.purpose}`);
        console.log(`subject: ${mailing.subject}`);
        console.log(`deliveries: ${mailing.counts.sent}/${total} sent`);
      }
      return;
    }
    default:
      throw new UsageError("Unknown mailings command.", 2);
  }
}
