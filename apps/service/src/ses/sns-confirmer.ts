import { Context, Effect, Layer } from "effect";

import { SnsConfirmationError } from "./errors.ts";

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
    },
    catch: (cause) => new SnsConfirmationError({ cause, reason: "Invalid SNS SubscribeURL." }),
  });
}

type ParsedSnsTopicArn = {
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly region: string;
};

function parseSnsTopicArn(topicArn: string): ParsedSnsTopicArn | null {
  const match = /^arn:(aws|aws-us-gov|aws-cn):sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/.exec(
    topicArn,
  );
  if (!match) return null;

  return { partition: match[1] as ParsedSnsTopicArn["partition"], region: match[2] };
}

function snsHostForTopic(topic: ParsedSnsTopicArn): string {
  const suffix = topic.partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  return `sns.${topic.region}.${suffix}`;
}
