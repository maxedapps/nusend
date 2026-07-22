import { printJson } from "../output/format.js";
import { requireApi, type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type OperationsCommand = Extract<
  CliCommand,
  { readonly kind: "operations-summary" } | { readonly kind: `deliveries-${string}` }
>;

export async function runOperationsCommand(
  command: OperationsCommand,
  context: CommandContext,
): Promise<void> {
  const api = requireApi(context);
  switch (command.kind) {
    case "operations-summary": {
      const result = await api.getOperationsSummary();
      if (context.json) printJson(result);
      else {
        console.log(
          `deliveries: queued=${result.deliveries.queued} sending=${result.deliveries.sending} sent=${result.deliveries.sent} failed=${result.deliveries.failed} suppressed=${result.deliveries.suppressed} ambiguous=${result.deliveries.ambiguous}`,
        );
        console.log(
          `jobs: queued=${result.jobs.queued} leased=${result.jobs.leased} succeeded=${result.jobs.succeeded} dead=${result.jobs.dead}`,
        );
        console.log(
          `sendAttempts: started=${result.sendAttempts.started} succeeded=${result.sendAttempts.succeeded} failed=${result.sendAttempts.failed} ambiguous=${result.sendAttempts.ambiguous}`,
        );
        console.log(`recentIssues: ${result.recentIssues.length}`);
      }
      return;
    }
    case "deliveries-list": {
      const result = await api.listDeliveries({
        email: command.email,
        issue: command.issue,
        limit: command.limit,
        mailingId: command.mailingId,
        sesMessageId: command.sesMessageId,
        status: command.status,
      });
      if (context.json) printJson(result);
      else {
        for (const item of result.items) {
          console.log(`${item.id}\t${item.email}\t${item.status}\tmailing=${item.mailingId}`);
        }
      }
      return;
    }
    case "deliveries-get": {
      const result = await api.getDelivery(command.id);
      if (context.json) printJson(result);
      else {
        const { delivery, job, mailing } = result;
        console.log(`id: ${delivery.id}`);
        console.log(`email: ${delivery.email}`);
        console.log(`status: ${delivery.status}`);
        console.log(`mailing: ${mailing.id}\t${mailing.subject}\t${mailing.state}`);
        if (job) console.log(`job: ${job.id}\t${job.state}\tattempts=${job.attempts}`);
        console.log(`attempts: ${result.attempts.length}`);
        if (delivery.lastError) console.log(`lastError: ${delivery.lastError}`);
      }
    }
  }
}
