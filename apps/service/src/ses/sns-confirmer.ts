import { Context, Effect, Layer } from "effect";

import { SnsConfirmationError } from "./errors.ts";
import { parseSnsTopicArn, snsHostForTopic } from "./sns-arn.ts";

export type SnsSubscriptionConfirmerService = {
  readonly confirm: (input: {
    readonly subscribeUrl: string;
    readonly topicArn: string;
  }) => Effect.Effect<void, SnsConfirmationError>;
};

const subscriptionConfirmationTimeoutMs = 10_000;

export const SnsSubscriptionConfirmer = Context.Service<SnsSubscriptionConfirmerService>(
  "nusend/SnsSubscriptionConfirmer",
);

export const SnsSubscriptionConfirmerLive: Layer.Layer<SnsSubscriptionConfirmerService> =
  Layer.succeed(SnsSubscriptionConfirmer)({
    confirm: (input) =>
      validateSnsSubscribeUrl(input.subscribeUrl, input.topicArn).pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: async () => {
              const response = await fetch(input.subscribeUrl, {
                method: "GET",
                // Never follow a redirect to another host (SSRF defense-in-depth).
                redirect: "error",
                signal: AbortSignal.timeout(subscriptionConfirmationTimeoutMs),
              });
              if (!response.ok) {
                throw new Error(`SNS confirmation failed with HTTP ${response.status}`);
              }
            },
            catch: (cause) =>
              new SnsConfirmationError({ cause, reason: "SNS subscription confirmation failed." }),
          }),
        ),
      ),
  });

export function FakeSnsSubscriptionConfirmerLive(
  calls: string[],
): Layer.Layer<SnsSubscriptionConfirmerService> {
  return Layer.succeed(SnsSubscriptionConfirmer)({
    confirm: (input) =>
      validateSnsSubscribeUrl(input.subscribeUrl, input.topicArn).pipe(
        Effect.tap(() => Effect.sync(() => calls.push(input.subscribeUrl))),
      ),
  });
}

export function validateSnsSubscribeUrl(
  subscribeUrl: string,
  topicArn: string,
): Effect.Effect<void, SnsConfirmationError> {
  return Effect.try({
    try: () => {
      const topic = parseSnsTopicArn(topicArn);
      if (!topic) throw new Error("TopicArn must be an SNS topic ARN.");

      const url = new URL(subscribeUrl);
      if (url.protocol !== "https:") {
        throw new Error("SubscribeURL must use HTTPS.");
      }
      if (url.hostname !== snsHostForTopic(topic)) {
        throw new Error("SubscribeURL host must match the SNS topic region and partition.");
      }
      // Unlike SigningCertURL, a real SubscribeURL MUST carry a query
      // (?Action=ConfirmSubscription&Token=...), so the query is allowed; pin the
      // rest of the shape and reject SSRF-shaped anomalies.
      if (url.username !== "" || url.password !== "") {
        throw new Error("SubscribeURL must not contain credentials.");
      }
      if (url.port !== "" && url.port !== "443") {
        throw new Error("SubscribeURL must use the default HTTPS port.");
      }
      if (url.hash !== "") {
        throw new Error("SubscribeURL must not contain a fragment.");
      }
      if (url.pathname !== "/") {
        throw new Error("SubscribeURL must target the root path.");
      }
      if (url.searchParams.get("Action") !== "ConfirmSubscription") {
        throw new Error("SubscribeURL must be a ConfirmSubscription action.");
      }
    },
    catch: (cause) => new SnsConfirmationError({ cause, reason: "Invalid SNS SubscribeURL." }),
  });
}
