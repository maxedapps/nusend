import { Cause, Effect, Exit } from "effect";

import { type DatabaseError } from "../errors.ts";
import type { SendDeliveryJob } from "../queue/schema.ts";
import {
  EmailTransport,
  EmailTransportError,
  type EmailSendingConfigService,
  type EmailTransportService,
} from "../services/email-transport.ts";
import type { DatabaseService } from "../services/database.ts";
import type { IdGeneratorService } from "../services/ids.ts";
import {
  recordAmbiguousFailure,
  recordPermanentFailure,
  recordRetryableFailure,
  recordSendSuccess,
  recordStaleSendingAsAmbiguous,
  startSendAttempt,
} from "./attempts.ts";
import { loadDeliveryContext } from "./context.ts";
import { runPolicyGates } from "./policy.ts";
import { prepareEmail } from "./prepare.ts";
import { renderDeliveryEmail } from "./render.ts";
import { SendProcessorError } from "./schema.ts";

export function processSendDeliveryJob(
  job: SendDeliveryJob,
): Effect.Effect<
  void,
  DatabaseError | SendProcessorError,
  DatabaseService | EmailSendingConfigService | EmailTransportService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const context = yield* loadDeliveryContext(job);
    if (!context) return;

    const started = yield* startSendAttempt(context);
    if (started.kind === "Skipped") {
      if (started.status === "sending") {
        yield* recordStaleSendingAsAmbiguous({
          deliveryId: context.delivery.id,
          errorMessage: "Delivery was left sending by a previous attempt; outcome is ambiguous.",
        });
      }
      return;
    }

    const attempt = started.attempt;
    const policy = yield* runPolicyGates(context);
    if (policy.kind === "Block") {
      yield* recordPermanentFailure({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        errorMessage: policy.message,
        status: policy.status,
      });
      return;
    }

    const renderedExit = yield* Effect.exit(renderDeliveryEmail(context));
    if (Exit.isFailure(renderedExit)) {
      yield* recordPermanentFailure({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        errorMessage: causeMessage(renderedExit.cause),
      });
      return;
    }

    const preparedExit = yield* Effect.exit(prepareEmail(context, renderedExit.value));
    if (Exit.isFailure(preparedExit)) {
      yield* recordPermanentFailure({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        errorMessage: causeMessage(preparedExit.cause),
      });
      return;
    }

    const transport = yield* EmailTransport;
    const sendExit = yield* Effect.exit(transport.send(preparedExit.value));

    if (Exit.isSuccess(sendExit)) {
      yield* recordSendSuccess({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        messageId: sendExit.value.messageId,
      });
      return;
    }

    const failure = Cause.squash(sendExit.cause);
    if (failure instanceof EmailTransportError) {
      const message = `Email transport ${failure.kind} failure.`;
      if (failure.kind === "permanent") {
        yield* recordPermanentFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: message,
        });
        return;
      }
      if (failure.kind === "ambiguous") {
        yield* recordAmbiguousFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: message,
        });
        return;
      }

      yield* recordRetryableFailure({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        errorMessage: message,
      });
      return yield* Effect.fail(new SendProcessorError({ message }));
    }

    const message = failure instanceof Error ? failure.message : String(failure);
    yield* recordRetryableFailure({
      attemptId: attempt.attemptId,
      deliveryId: context.delivery.id,
      errorMessage: message,
    });
    return yield* Effect.fail(new SendProcessorError({ message }));
  });
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}
