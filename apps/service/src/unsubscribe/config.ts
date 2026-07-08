import { Context, Layer, Option, type Redacted } from "effect";

export type UnsubscribeConfig = {
  readonly currentSecret: Redacted.Redacted<string>;
  readonly previousSecret: Redacted.Redacted<string> | null;
  readonly publicBaseUrl: string;
};

export type UnsubscribeConfigService = {
  readonly config: Option.Option<UnsubscribeConfig>;
};

export const UnsubscribeConfig = Context.Service<UnsubscribeConfigService>(
  "nusend/UnsubscribeConfig",
);

export function UnsubscribeConfigLive(
  config: Option.Option<UnsubscribeConfig>,
): Layer.Layer<UnsubscribeConfigService> {
  return Layer.succeed(UnsubscribeConfig)({ config });
}
