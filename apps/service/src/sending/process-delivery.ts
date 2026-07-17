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
import { SendProcessorError, type DeliveryContext, type StartedAttempt } from "./schema.ts";
import { classifyTransportFailure } from "./transport-failure.ts";

type ProcessorServices =
  | DatabaseService
  | EmailSendingConfigService
  | EmailTransportService
  | IdGeneratorService
  | UnsubscribeConfigService;

export function processSendDeliveryJob(
  job: SendDeliveryJob,
): Effect.Effect<void, DatabaseError | SendProcessorError, ProcessorServices> {
  return Effect.gen(function* () {
    const context = yield* loadDeliveryContext(job);
    if (!context) return;

    const started = yield* startSendAttempt(context);
    if (started.kind === "Skipped") {
      if (started.status === "sending") {
        yield* recordStaleSendingAsAmbiguous({
          deliveryId: context.delivery.id,
          errorMessage: "Delivery was left sending by a previous attempt; outcome is ambiguous.",
        }).pipe(Effect.asVoid);
      }
      return;
    }

    const attempt = started.attempt;

    // Stage boundary: beforeDispatch never calls SES. Pre-dispatch DatabaseError
    // resets delivery to queued (retryable). Post-dispatch DB errors surface —
    // SES may already have accepted the message.
    const prepared = yield* beforeDispatch(context, attempt).pipe(
      Effect.catchTag("DatabaseError", (error) =>
        recordRetryableFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: `Pre-send database error during ${error.operation}.`,
        }).pipe(
          Effect.asVoid,
          Effect.andThen(
            Effect.fail(
              new SendProcessorError({
                message: `Pre-send database error during ${error.operation}.`,
              }),
            ),
          ),
          Effect.catchTag("DatabaseError", () => Effect.fail(error)),
        ),
      ),
    );
    if (prepared.kind === "Stopped") return;

    yield* dispatchAndRecord(context, attempt, prepared.email);
  });
}

type BeforeDispatchResult =
  | { readonly kind: "Ready"; readonly email: Parameters<EmailTransportService["send"]>[0] }
  | { readonly kind: "Stopped" };

function beforeDispatch(
  context: DeliveryContext,
  attempt: StartedAttempt,
): Effect.Effect<
  BeforeDispatchResult,
  DatabaseError | SendProcessorError,
  DatabaseService | EmailSendingConfigService | UnsubscribeConfigService
> {
  return Effect.gen(function* () {
    const policy = yield* runPolicyGates(context);
    if (policy.kind === "BlockPermanent") {
      yield* recordPermanentFailure({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        errorMessage: policy.message,
        status: policy.status,
      }).pipe(Effect.asVoid);
      return { kind: "Stopped" as const };
    }
    if (policy.kind === "BlockRetryable") {
      yield* recordRetryableFailure({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        errorMessage: policy.message,
      }).pipe(Effect.asVoid);
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
      }).pipe(Effect.asVoid);
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
      }).pipe(Effect.asVoid);
      return { kind: "Stopped" as const };
    }

    const preparedExit = yield* Effect.exit(prepareEmail(context, renderedExit.value));
    if (Exit.isFailure(preparedExit)) {
      yield* recordPermanentFailure({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        errorMessage: causeMessage(preparedExit.cause),
      }).pipe(Effect.asVoid);
      return { kind: "Stopped" as const };
    }

    return { kind: "Ready" as const, email: preparedExit.value };
  });
}

function dispatchAndRecord(
  context: DeliveryContext,
  attempt: StartedAttempt,
  email: Parameters<EmailTransportService["send"]>[0],
): Effect.Effect<
  void,
  DatabaseError | SendProcessorError,
  EmailTransportService | DatabaseService
> {
  return Effect.gen(function* () {
    const transport = yield* EmailTransport;
    const sendExit = yield* Effect.exit(Effect.suspend(() => transport.send(email)));

    if (Exit.isSuccess(sendExit)) {
      yield* recordSendSuccess({
        attemptId: attempt.attemptId,
        deliveryId: context.delivery.id,
        messageId: sendExit.value.messageId,
      }).pipe(Effect.asVoid);
      return;
    }

    const failure = classifyTransportFailure(sendExit.cause);
    switch (failure.kind) {
      case "permanent":
        yield* recordPermanentFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: failure.message,
        }).pipe(Effect.asVoid);
        return;
      case "ambiguous":
        yield* recordAmbiguousFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: failure.message,
        }).pipe(Effect.asVoid);
        return;
      case "retryable":
        yield* recordRetryableFailure({
          attemptId: attempt.attemptId,
          deliveryId: context.delivery.id,
          errorMessage: failure.message,
        }).pipe(Effect.asVoid);
        return yield* Effect.fail(new SendProcessorError({ message: failure.message }));
    }
  });
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}
