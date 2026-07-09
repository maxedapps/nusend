import {
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SNSClient,
} from "@aws-sdk/client-sns";
import { Context, Effect, Layer, Option } from "effect";

import { SesOperationsConfig, type SesOperationsConfigService } from "../ses/config.ts";
import { AwsAdminError, classifyAwsAdminError } from "./errors.ts";

export type SnsTopicSummary = {
  readonly signatureVersion: string | null;
  readonly topicArn: string;
};

export type SnsSubscriptionSummary = {
  readonly endpoint: string | null;
  readonly protocol: string | null;
  readonly subscriptionArn: string | null;
};

export interface SnsAdminService {
  readonly getTopicAttributes: (topicArn: string) => Effect.Effect<SnsTopicSummary, AwsAdminError>;
  readonly listSubscriptionsByTopic: (
    topicArn: string,
  ) => Effect.Effect<readonly SnsSubscriptionSummary[], AwsAdminError>;
}

export const SnsAdmin = Context.Service<SnsAdminService>("nusend/SnsAdmin");

export const SnsAdminLive: Layer.Layer<SnsAdminService, never, SesOperationsConfigService> =
  Layer.effect(
    SnsAdmin,
    Effect.map(SesOperationsConfig, (settings) => {
      const region = Option.getOrElse(settings.config.awsRegion, () => "us-east-1");
      return makeSnsAdmin(
        new SNSClient({ region }) as unknown as SnsAdminSender,
        settings.config.requestTimeoutMs,
      );
    }),
  );

export type SnsAdminSender = {
  readonly send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
};

export function makeSnsAdmin(sender: SnsAdminSender, requestTimeoutMs = 30000): SnsAdminService {
  const send = (command: unknown) =>
    sender.send(command, { abortSignal: timeoutSignal(requestTimeoutMs) });

  return {
    getTopicAttributes: (topicArn) =>
      Effect.tryPromise({
        try: () => send(new GetTopicAttributesCommand({ TopicArn: topicArn })),
        catch: (cause) => classifyAwsAdminError("sns:get-topic-attributes", cause),
      }).pipe(
        Effect.map((output) => {
          const value = output as { Attributes?: Record<string, string> };
          return {
            signatureVersion: value.Attributes?.SignatureVersion ?? null,
            topicArn,
          };
        }),
      ),
    listSubscriptionsByTopic: (topicArn) =>
      Effect.tryPromise({
        try: async () => {
          const subscriptions: SnsSubscriptionSummary[] = [];
          let nextToken: string | undefined;
          do {
            // oxlint-disable-next-line no-await-in-loop -- SNS pagination is sequential by NextToken.
            const output = (await send(
              new ListSubscriptionsByTopicCommand({ NextToken: nextToken, TopicArn: topicArn }),
            )) as {
              NextToken?: string;
              Subscriptions?: {
                Endpoint?: string;
                Protocol?: string;
                SubscriptionArn?: string;
              }[];
            };
            subscriptions.push(
              ...(output.Subscriptions ?? []).map((subscription) => ({
                endpoint: subscription.Endpoint ?? null,
                protocol: subscription.Protocol ?? null,
                subscriptionArn: subscription.SubscriptionArn ?? null,
              })),
            );
            nextToken = output.NextToken;
          } while (nextToken);
          return subscriptions;
        },
        catch: (cause) => classifyAwsAdminError("sns:list-subscriptions-by-topic", cause),
      }),
  };
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

export function FakeSnsAdminLive(service: SnsAdminService): Layer.Layer<SnsAdminService> {
  return Layer.succeed(SnsAdmin)(service);
}
