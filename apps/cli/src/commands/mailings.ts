import { printJson } from "../output/format.js";
import { requireApi, type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type MailingsCommand = Extract<CliCommand, { readonly kind: `mailings-${string}` }>;

export async function runMailingsCommand(
  command: MailingsCommand,
  context: CommandContext,
): Promise<void> {
  const api = requireApi(context);
  switch (command.kind) {
    case "mailings-list": {
      const result = await api.listMailings({ limit: command.limit, offset: command.offset });
      if (context.json) printJson(result);
      else {
        for (const mailing of result.items) {
          const total = Object.values(mailing.counts).reduce((sum, count) => sum + count, 0);
          const ambiguity =
            mailing.counts.ambiguous > 0 ? `\tambiguous=${mailing.counts.ambiguous}` : "";
          console.log(
            `${mailing.id}\t${mailing.state}\t${mailing.purpose}\t${mailing.subject}\t${mailing.counts.sent}/${total}${ambiguity}`,
          );
        }
      }
      return;
    }
    case "mailings-get": {
      const result = await api.getMailing(command.id);
      if (context.json) {
        printJson(result);
      } else {
        const mailing = result.mailing;
        const total = Object.values(mailing.counts).reduce((sum, count) => sum + count, 0);
        console.log(`id: ${mailing.id}`);
        console.log(`state: ${mailing.state}`);
        console.log(`purpose: ${mailing.purpose}`);
        console.log(`subject: ${mailing.subject}`);
        console.log(`deliveries: ${mailing.counts.sent}/${total} sent`);
        if (mailing.counts.ambiguous > 0) {
          console.log(`ambiguous=${mailing.counts.ambiguous}`);
        }
      }
    }
  }
}
