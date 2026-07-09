import { Context, Layer, Option } from "effect";

export type SesOperationsConfigIssue = {
  readonly id: string;
  readonly message: string;
};

export type SesOperationsConfig = {
  readonly awsRegion: Option.Option<string>;
  readonly configIssues: readonly SesOperationsConfigIssue[];
  readonly feedbackTopicArns: readonly string[];
  readonly fromEmail: Option.Option<string>;
  readonly marketingConfigurationSet: Option.Option<string>;
  readonly publicBaseUrl: Option.Option<string>;
  readonly requestTimeoutMs: number;
  readonly trackingCustomRedirectDomain: Option.Option<string>;
  readonly trackingEvents: readonly ("click" | "open")[];
  readonly transactionalConfigurationSet: Option.Option<string>;
  readonly unsubscribeSecretConfigured: boolean;
  readonly workerBatchSize: number;
  readonly workerLeaseSeconds: number;
  readonly workerPollMs: number;
};

export type SesOperationsConfigService = {
  readonly config: SesOperationsConfig;
};

export const SesOperationsConfig = Context.Service<SesOperationsConfigService>(
  "nusend/SesOperationsConfig",
);

export function SesOperationsConfigLive(
  config: SesOperationsConfig,
): Layer.Layer<SesOperationsConfigService> {
  return Layer.succeed(SesOperationsConfig)({ config });
}
