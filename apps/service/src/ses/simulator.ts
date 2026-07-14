import { Cause, Effect, Exit, Result } from "effect";

import type {
  DatabaseError,
  EmptyRecipientSetError,
  ListNotFoundError,
  RecipientLimitExceededError,
} from "../errors.ts";
import { addMillisecondsIso, currentIso } from "../lib/iso-time.ts";
import { createMailing } from "../mailings/create-mailing.ts";
import type { MailingPurpose } from "../mailings/schema.ts";
import { runSendWorkerOnce } from "../queue/runner.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import type {
  EmailSendingConfigService,
  EmailTransportService,
} from "../services/email-transport.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import type { UnsubscribeConfigService } from "../unsubscribe/config.ts";

export const simulatorScenarios = [
  "success",
  "bounce",
  "complaint",
  "ooto",
  "suppressionlist",
] as const;
export type SimulatorScenario = (typeof simulatorScenarios)[number];
export type SimulatorMode = "end_to_end" | "send_acceptance";

const simulatorAddresses: Record<SimulatorScenario, string> = {
  bounce: "bounce@simulator.amazonses.com",
  complaint: "complaint@simulator.amazonses.com",
  ooto: "ooto@simulator.amazonses.com",
  success: "success@simulator.amazonses.com",
  suppressionlist: "suppressionlist@simulator.amazonses.com",
};

const expectedEvents: Record<SimulatorScenario, string | null> = {
  bounce: "Bounce",
  complaint: "Complaint",
  ooto: null,
  success: "Delivery",
  suppressionlist: null,
};

const expectedSuppressions: Record<SimulatorScenario, string | null> = {
  bounce: "bounce",
  complaint: "complaint",
  ooto: null,
  success: null,
  suppressionlist: null,
};

export type RunSesSimulatorOptions = {
  readonly mode: SimulatorMode;
  readonly purpose: MailingPurpose;
  readonly scenario: SimulatorScenario;
  readonly targetBaseUrl: string | null;
  readonly timeoutMs?: number;
  readonly workerId: string;
};

export type RunSesSimulatorResult = {
  readonly deliveryId: string | null;
  readonly mailingId: string | null;
  readonly recipientEmail: string;
  readonly runId: string;
  readonly status: "ambiguous" | "failed" | "sent" | "timed_out" | "validated";
};

export function runSesSimulator(
  options: RunSesSimulatorOptions,
): Effect.Effect<
  RunSesSimulatorResult,
  DatabaseError | EmptyRecipientSetError | ListNotFoundError | RecipientLimitExceededError,
  | DatabaseService
  | EmailSendingConfigService
  | EmailTransportService
  | IdGeneratorService
  | UnsubscribeConfigService
> {
  return Effect.gen(function* () {
    const ids = yield* IdGenerator;
    const runId = yield* ids.next;
    const recipientEmail = simulatorAddresses[options.scenario];
    const startedAt = yield* currentIso;
    yield* insertSimulatorRun({ options, recipientEmail, runId, startedAt });
    yield* Effect.logInfo("ses simulator started", {
      mode: options.mode,
      purpose: options.purpose,
      runId,
      scenario: options.scenario,
    });

    const exit = yield* Effect.exit(
      runSimulatorBody({ options, recipientEmail, runId, startedAt }),
    );
    if (Exit.isSuccess(exit)) {
      yield* Effect.logInfo("ses simulator completed", {
        runId,
        status: exit.value.status,
      });
      return exit.value;
    }

    yield* finishSimulatorRun(runId, "failed", causeMessage(exit.cause));
    yield* Effect.logError("ses simulator failed", { runId });
    return yield* Effect.failCause(exit.cause);
  });
}

function runSimulatorBody(input: {
  options: RunSesSimulatorOptions;
  recipientEmail: string;
  runId: string;
  startedAt: string;
}): Effect.Effect<
  RunSesSimulatorResult,
  DatabaseError | EmptyRecipientSetError | ListNotFoundError | RecipientLimitExceededError,
  | DatabaseService
  | EmailSendingConfigService
  | EmailTransportService
  | IdGeneratorService
  | UnsubscribeConfigService
> {
  return Effect.gen(function* () {
    const mailing = yield* createMailing({
      html: `<p>SES simulator ${input.options.scenario}</p>${input.options.purpose === "marketing" ? "<p>{{ unsubscribe.url }}</p>" : ""}`,
      listId: null,
      name: `SES simulator ${input.options.scenario}`,
      purpose: input.options.purpose,
      recipients: [{ email: input.recipientEmail, varsJson: null }],
      scheduledAt: input.startedAt,
      subject: `SES simulator ${input.options.scenario}`,
      text: `SES simulator ${input.options.scenario}`,
    });
    const deliveryId = yield* firstDeliveryId(mailing.mailing.id);
    yield* updateSimulatorRun(input.runId, {
      deliveryId,
      mailingId: mailing.mailing.id,
      status: "started",
    });

    const deadline = addMillisecondsIso(input.startedAt, input.options.timeoutMs ?? 120_000);
    while ((yield* currentIso) < deadline) {
      yield* runSendWorkerOnce({ batchSize: 1, mode: "once", workerId: input.options.workerId });
      const delivery = deliveryId ? yield* loadDeliveryStatus(deliveryId) : null;
      if (
        delivery?.status === "sent" ||
        delivery?.status === "failed" ||
        delivery?.status === "ambiguous"
      ) {
        if (input.options.mode === "send_acceptance") {
          const status = delivery.status;
          yield* finishSimulatorRun(input.runId, status, delivery.lastError);
          return {
            deliveryId,
            mailingId: mailing.mailing.id,
            recipientEmail: input.recipientEmail,
            runId: input.runId,
            status,
          };
        }

        const validated = yield* expectedEventStored(input.options.scenario, deliveryId);
        if (validated || expectedEvents[input.options.scenario] === null) {
          yield* finishSimulatorRun(input.runId, "validated", null);
          return {
            deliveryId,
            mailingId: mailing.mailing.id,
            recipientEmail: input.recipientEmail,
            runId: input.runId,
            status: "validated",
          };
        }
      }
      yield* Effect.sleep("1 second");
    }

    yield* finishSimulatorRun(
      input.runId,
      "timed_out",
      "Timed out waiting for simulator validation.",
    );
    return {
      deliveryId,
      mailingId: mailing.mailing.id,
      recipientEmail: input.recipientEmail,
      runId: input.runId,
      status: "timed_out" as const,
    };
  });
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findFail(cause);
  if (Result.isSuccess(failure)) {
    const failed = failure.success.error;
    if (typeof failed === "object" && failed !== null && "reason" in failed) {
      return String((failed as { reason: unknown }).reason);
    }
    if (typeof failed === "object" && failed !== null && "message" in failed) {
      return String((failed as { message: unknown }).message);
    }
  }

  const error = Cause.squash(cause);
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "reason" in error) {
    return String((error as { reason: unknown }).reason);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function insertSimulatorRun(input: {
  options: RunSesSimulatorOptions;
  recipientEmail: string;
  runId: string;
  startedAt: string;
}): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db.run(
      "ses:simulator-run:insert",
      `INSERT INTO ses_simulator_runs (
         id, scenario, mode, purpose, recipient_email, target_base_url, status,
         expected_event_type, expected_suppression_reason, started_at
       ) VALUES (
         $id, $scenario, $mode, $purpose, $recipientEmail, $targetBaseUrl, 'started',
         $expectedEventType, $expectedSuppressionReason, $startedAt
       );`,
      {
        expectedEventType: expectedEvents[input.options.scenario],
        expectedSuppressionReason: expectedSuppressions[input.options.scenario],
        id: input.runId,
        mode: input.options.mode,
        purpose: input.options.purpose,
        recipientEmail: input.recipientEmail,
        scenario: input.options.scenario,
        startedAt: input.startedAt,
        targetBaseUrl: input.options.targetBaseUrl,
      },
    ),
  );
}

function updateSimulatorRun(
  runId: string,
  input: { deliveryId: string | null; mailingId: string; status: "started" },
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db.run(
      "ses:simulator-run:update-links",
      `UPDATE ses_simulator_runs
       SET mailing_id = $mailingId, delivery_id = $deliveryId, status = $status
       WHERE id = $runId;`,
      { deliveryId: input.deliveryId, mailingId: input.mailingId, runId, status: input.status },
    ),
  );
}

function finishSimulatorRun(
  runId: string,
  status: "ambiguous" | "failed" | "sent" | "timed_out" | "validated",
  errorMessage: string | null,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* currentIso;
    yield* db.run(
      "ses:simulator-run:finish",
      `UPDATE ses_simulator_runs
       SET status = $status, error_message = $errorMessage, finished_at = $finishedAt
       WHERE id = $runId;`,
      { errorMessage, finishedAt: now, runId, status },
    );
  });
}

function firstDeliveryId(
  mailingId: string,
): Effect.Effect<string | null, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ id: string }>(
      "ses:simulator-run:first-delivery",
      "SELECT id FROM deliveries WHERE mailing_id = $mailingId ORDER BY created_at ASC LIMIT 1;",
      { mailingId },
    );
    return row?.id ?? null;
  });
}

function loadDeliveryStatus(
  deliveryId: string,
): Effect.Effect<
  { lastError: string | null; status: string } | null,
  DatabaseError,
  DatabaseService
> {
  return Effect.flatMap(Database, (db) =>
    db.get<{ lastError: string | null; status: string }>(
      "ses:simulator-run:delivery-status",
      "SELECT status, last_error AS lastError FROM deliveries WHERE id = $deliveryId;",
      { deliveryId },
    ),
  );
}

function expectedEventStored(
  scenario: SimulatorScenario,
  deliveryId: string | null,
): Effect.Effect<boolean, DatabaseError, DatabaseService> {
  const eventType = expectedEvents[scenario];
  if (eventType === null || deliveryId === null) return Effect.succeed(false);
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.get<{ ok: number }>(
      "ses:simulator-run:expected-event",
      `SELECT 1 AS ok FROM ses_events
       WHERE delivery_id = $deliveryId AND event_type = $eventType
       LIMIT 1;`,
      { deliveryId, eventType },
    );
    return row !== null;
  });
}
