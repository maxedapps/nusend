import { Context, Effect, Layer } from "effect";

export interface IdGeneratorService {
  // Implementations must be synchronous and non-suspending: ids are generated
  // inside write transactions, and a suspended fiber there would hold SQLite's
  // write lock (see the transaction policy on the Database service).
  readonly next: Effect.Effect<string>;
}

export const IdGenerator = Context.Service<IdGeneratorService>("nusend/IdGenerator");

export const IdGeneratorLive: Layer.Layer<IdGeneratorService> = Layer.succeed(IdGenerator)({
  next: Effect.sync(() => crypto.randomUUID()),
});
