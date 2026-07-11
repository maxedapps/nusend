import { Cause, Effect, Exit } from "effect";

import { type DatabaseError } from "../errors.ts";
import type { SendDeliveryJob } from "../queue/schema.ts";
import {
  EmailTransport,
  type EmailSendingConfigService,
  type EmailTransportService,
} from "../services/email-transport.ts";
import type { DatabaseService } from "../services/database.ts";
import type { IdGeneratorService } from "../services/ids.ts";
import type { UnsubscribeConfigService } from "../unsubscribe/config.ts";
import { buildUnsubscribeUrl } from "../unsubscribe/url.ts";
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
import { classifyTransportFailure } from "./transport-failure.ts";

export function processSendDeliveryJob(
  job: SendDeliveryJob,
): Effect.Effect<
  void,
  DatabaseError | SendProcessorError,
  | DatabaseService
  | EmailSendingConfigService
  | EmailTransportService
  | IdGeneratorService
  | UnsubscribeConfigService
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
    // Tracks whether the external SES call has been dispatched. Only the window
    // between dispatch and outcome-recording may resolve as ambiguous; a
    // DatabaseError BEFORE dispatch (e.g. SQLITE_BUSY in a policy re-check) means
    // nothing was sent, so it must reset the delivery to `queued` (retryable)
    // rather than leaving it `sending` for the next cycle to fail as ambiguous.
    const dispatched = { value: false };

    const send = Effect.gen(function* () {
      const policy = yield* runPolicyGates(context);
      if (policy.kind === "BlockPermanent") {
        yield* recordPermanentFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: policy.message,
          status: policy.status,
        });
        return;
      }
      if (policy.kind === "BlockRetryable") {
        yield* recordRetryableFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: policy.message,
        });
        return yield* Effect.fail(new SendProcessorError({ message: policy.message }));
      }

      const unsubscribeUrlExit = yield* Effect.exit(
        context.mailing.purpose === "marketing"
          ? buildUnsubscribeUrl(context.delivery.id)
          : Effect.succeed(undefined),
      );
      if (Exit.isFailure(unsubscribeUrlExit)) {
        const message = causeMessage(unsubscribeUrlExit.cause);
        yield* recordRetryableFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: message,
        });
        return yield* Effect.fail(new SendProcessorError({ message }));
      }

      const renderedExit = yield* Effect.exit(
        renderDeliveryEmail(context, { unsubscribeUrl: unsubscribeUrlExit.value }),
      );
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
      dispatched.value = true;
      const sendExit = yield* Effect.exit(Effect.suspend(() => transport.send(preparedExit.value)));

      if (Exit.isSuccess(sendExit)) {
        yield* recordSendSuccess({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          messageId: sendExit.value.messageId,
        });
        return;
      }

      const failure = classifyTransportFailure(sendExit.cause);
      switch (failure.kind) {
        case "permanent":
          yield* recordPermanentFailure({
            attemptId: attempt.attemptId,
            deliveryId: context.delivery.id,
            errorMessage: failure.message,
          });
          return;
        case "ambiguous":
          yield* recordAmbiguousFailure({
            attemptId: attempt.attemptId,
            deliveryId: context.delivery.id,
            errorMessage: failure.message,
          });
          return;
        case "retryable":
          yield* recordRetryableFailure({
            attemptId: attempt.attemptId,
            deliveryId: context.delivery.id,
            errorMessage: failure.message,
          });
          return yield* Effect.fail(new SendProcessorError({ message: failure.message }));
      }
    });

    return yield* send.pipe(
      Effect.catchTag("DatabaseError", (error) => {
        if (dispatched.value) return Effect.fail(error);
        const message = `Pre-send database error during ${error.operation}.`;
        return recordRetryableFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: message,
        }).pipe(
          Effect.andThen(Effect.fail(new SendProcessorError({ message }))),
          // If the reset write also fails (database genuinely down), surface the
          // original error; the delivery stays `sending` and is resolved as
          // ambiguous on a later cycle (documented residual).
          Effect.catchTag("DatabaseError", () => Effect.fail(error)),
        );
      }),
    );
  });
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}
