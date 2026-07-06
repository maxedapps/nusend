import type { Dispatcher } from "./dispatch/dispatcher.ts";

export type AppBindings = {
  DB: D1Database;
  DISPATCHER: DurableObjectNamespace<Dispatcher>;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    apiKeyId: string;
  };
};
