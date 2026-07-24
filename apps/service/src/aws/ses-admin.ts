import {
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";
import { Context, Effect, Layer, Option } from "effect";

import { SesOperationsConfig, type SesOperationsConfigService } from "../ses/config.ts";
import { AwsAdminError, classifyAwsAdminError } from "./errors.ts";

export type SesAccountSummary = {
  readonly enforcementStatus: string | null;
  readonly productionAccessEnabled: boolean | null;
  readonly sendingEnabled: boolean | null;
  readonly suppressionReasons: readonly string[];
};

export type SesIdentitySummary = {
  readonly dkimStatus: string | null;
  readonly verifiedForSending: boolean | null;
};

export type SesConfigurationSetSummary = {
  readonly name: string;
  readonly sendingEnabled: boolean | null;
  readonly suppressedReasons: readonly string[];
  readonly trackingCustomRedirectDomain: string | null;
};

export type SesEventDestinationSummary = {
  readonly enabled: boolean;
  readonly eventTypes: readonly string[];
  readonly matchingTopicArn: string | null;
  readonly name: string;
};

export interface SesAdminService {
  readonly getAccount: () => Effect.Effect<SesAccountSummary, AwsAdminError>;
  readonly getConfigurationSet: (
    name: string,
  ) => Effect.Effect<SesConfigurationSetSummary, AwsAdminError>;
  readonly getConfigurationSetEventDestinations: (
    name: string,
  ) => Effect.Effect<readonly SesEventDestinationSummary[], AwsAdminError>;
  readonly getEmailIdentity: (identity: string) => Effect.Effect<SesIdentitySummary, AwsAdminError>;
}

export const SesAdmin = Context.Service<SesAdminService>("nusend/SesAdmin");

export const SesAdminLive: Layer.Layer<SesAdminService, never, SesOperationsConfigService> =
  Layer.effect(
    SesAdmin,
    Effect.map(SesOperationsConfig, (settings) => {
      const region = Option.getOrElse(settings.config.awsRegion, () => "us-east-1");
      return makeSesAdmin(
        new SESv2Client({ region }) as unknown as SesAdminSender,
        settings.config.requestTimeoutMs,
      );
    }),
  );

export type SesAdminSender = {
  readonly send: (command: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
};

export function makeSesAdmin(sender: SesAdminSender, requestTimeoutMs = 30000): SesAdminService {
  const send = (command: unknown) =>
    sender.send(command, { abortSignal: timeoutSignal(requestTimeoutMs) });

  return {
    getAccount: () =>
      Effect.tryPromise({
        try: () => send(new GetAccountCommand({})),
        catch: (cause) => classifyAwsAdminError("ses:get-account", cause),
      }).pipe(
        Effect.map((output) => {
          const value = output as {
            EnforcementStatus?: string;
            ProductionAccessEnabled?: boolean;
            SendingEnabled?: boolean;
            SuppressionAttributes?: { SuppressedReasons?: string[] };
          };
          return {
            enforcementStatus: value.EnforcementStatus ?? null,
            productionAccessEnabled: value.ProductionAccessEnabled ?? null,
            sendingEnabled: value.SendingEnabled ?? null,
            suppressionReasons: value.SuppressionAttributes?.SuppressedReasons ?? [],
          };
        }),
      ),
    getConfigurationSet: (name) =>
      Effect.tryPromise({
        try: () => send(new GetConfigurationSetCommand({ ConfigurationSetName: name })),
        catch: (cause) => classifyAwsAdminError("ses:get-configuration-set", cause),
      }).pipe(
        Effect.map((output) => {
          const value = output as {
            ConfigurationSetName?: string;
            SendingOptions?: { SendingEnabled?: boolean };
            SuppressionOptions?: { SuppressedReasons?: string[] };
            TrackingOptions?: { CustomRedirectDomain?: string };
          };
          return {
            name: value.ConfigurationSetName ?? name,
            sendingEnabled: value.SendingOptions?.SendingEnabled ?? null,
            suppressedReasons: value.SuppressionOptions?.SuppressedReasons ?? [],
            trackingCustomRedirectDomain: value.TrackingOptions?.CustomRedirectDomain ?? null,
          };
        }),
      ),
    getConfigurationSetEventDestinations: (name) =>
      Effect.tryPromise({
        try: () =>
          send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: name })),
        catch: (cause) => classifyAwsAdminError("ses:get-configuration-set-events", cause),
      }).pipe(
        Effect.map((output) => {
          const value = output as {
            EventDestinations?: {
              Enabled?: boolean;
              MatchingEventTypes?: string[];
              Name?: string;
              SnsDestination?: { TopicArn?: string };
            }[];
          };
          return (value.EventDestinations ?? []).map((destination) => ({
            enabled: destination.Enabled ?? false,
            eventTypes: destination.MatchingEventTypes ?? [],
            matchingTopicArn: destination.SnsDestination?.TopicArn ?? null,
            name: destination.Name ?? "unnamed",
          }));
        }),
      ),
    getEmailIdentity: (identity) =>
      Effect.tryPromise({
        try: () => send(new GetEmailIdentityCommand({ EmailIdentity: identity })),
        catch: (cause) => classifyAwsAdminError("ses:get-email-identity", cause),
      }).pipe(
        Effect.map((output) => {
          const value = output as {
            DkimAttributes?: { Status?: string };
            VerifiedForSendingStatus?: boolean;
          };
          return {
            dkimStatus: value.DkimAttributes?.Status ?? null,
            verifiedForSending: value.VerifiedForSendingStatus ?? null,
          };
        }),
      ),
  };
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

export function FakeSesAdminLive(service: SesAdminService): Layer.Layer<SesAdminService> {
  return Layer.succeed(SesAdmin)(service);
}
