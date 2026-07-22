import { printJson } from "../output/format.js";
import { requireApi, type CommandContext } from "./context.js";
import type { CliCommand } from "./options.js";

type SesCommand = Extract<CliCommand, { readonly kind: `ses-${string}` }>;

export async function runSesCommand(command: SesCommand, context: CommandContext): Promise<void> {
  const api = requireApi(context);
  switch (command.kind) {
    case "ses-summary": {
      const result = await api.getSesSummary();
      if (context.json) printJson(result);
      else {
        console.log(
          `totals: bounce=${result.totals.bounce} complaint=${result.totals.complaint} open=${result.totals.open} click=${result.totals.click}`,
        );
        console.log(`latestEventAt: ${result.latestEventAt ?? "none"}`);
        console.log(`latestNotificationAt: ${result.latestNotificationAt ?? "none"}`);
        console.log(`recentIssues: ${result.recentIssues.length}`);
        if (result.worker.latestRun) {
          const run = result.worker.latestRun;
          console.log(
            `latestWorkerRun: ${run.id}\tsucceeded=${run.succeeded}\tfailed=${run.failed}\tdead=${run.dead}`,
          );
        } else {
          console.log("latestWorkerRun: none");
        }
      }
      return;
    }
    case "ses-readiness": {
      const result = await api.getSesReadiness(command.includeAws ? {} : { includeAws: false });
      if (context.json) printJson(result);
      else {
        console.log(`status: ${result.status}`);
        console.log(`checkedAt: ${result.checkedAt}`);
        if (result.expectedWebhookUrl) {
          console.log(`expectedWebhookUrl: ${result.expectedWebhookUrl}`);
        }
        for (const check of result.checks) {
          console.log(`${check.status}\t${check.id}\t${check.title}`);
        }
      }
      return;
    }
    case "ses-setup-guide": {
      const result = await api.getSesSetupGuide(command.includeAws ? {} : { includeAws: false });
      if (context.json) printJson(result);
      else {
        console.log(`${result.title} (${result.status})`);
        for (const step of result.steps) {
          console.log(`${step.status}\t${step.id}\t${step.title}`);
        }
      }
      return;
    }
    case "ses-events-list": {
      const result = await api.listSesEvents({
        deliveryId: command.deliveryId,
        email: command.email,
        eventType: command.eventType,
        limit: command.limit,
        mailingId: command.mailingId,
        offset: command.offset,
        sesMessageId: command.sesMessageId,
      });
      if (context.json) printJson(result);
      else {
        for (const event of result.items) {
          console.log(
            `${event.id}\t${event.eventType}\t${event.recipientEmail ?? "-"}\t${event.actionTaken}`,
          );
        }
      }
      return;
    }
    case "ses-events-get": {
      const result = await api.getSesEvent(command.id);
      if (context.json) printJson(result);
      else {
        console.log(`id: ${result.id}`);
        console.log(`eventType: ${result.eventType}`);
        console.log(`actionTaken: ${result.actionTaken}`);
        console.log(`recipientEmail: ${result.recipientEmail ?? "-"}`);
        console.log(`mailingId: ${result.mailingId ?? "-"}`);
        console.log(`deliveryId: ${result.deliveryId ?? "-"}`);
        console.log(`occurredAt: ${result.occurredAt ?? "-"}`);
      }
      return;
    }
    case "ses-simulator-runs-list": {
      const result = await api.listSesSimulatorRuns();
      if (context.json) printJson(result);
      else {
        for (const run of result.items) {
          console.log(`${run.id}\t${run.status}\t${run.scenario}\t${run.recipientEmail}`);
        }
      }
      return;
    }
    case "ses-simulator-runs-get": {
      const result = await api.getSesSimulatorRun(command.id);
      if (context.json) printJson(result);
      else {
        console.log(`id: ${result.id}`);
        console.log(`status: ${result.status}`);
        console.log(`scenario: ${result.scenario}`);
        console.log(`recipientEmail: ${result.recipientEmail}`);
        console.log(`purpose: ${result.purpose}`);
        console.log(`mailingId: ${result.mailingId ?? "-"}`);
        console.log(`deliveryId: ${result.deliveryId ?? "-"}`);
        if (result.errorMessage) console.log(`errorMessage: ${result.errorMessage}`);
      }
    }
  }
}
