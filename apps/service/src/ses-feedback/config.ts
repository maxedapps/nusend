import { Context, Layer, Option } from "effect";

export type SesFeedbackConfig = {
  readonly topicArns: readonly string[];
};

export type SesFeedbackConfigService = {
  readonly config: Option.Option<SesFeedbackConfig>;
};

export const SesFeedbackConfig = Context.Service<SesFeedbackConfigService>(
  "nusend/SesFeedbackConfig",
);

export function SesFeedbackConfigLive(
  config: Option.Option<SesFeedbackConfig>,
): Layer.Layer<SesFeedbackConfigService> {
  return Layer.succeed(SesFeedbackConfig)({ config });
}
