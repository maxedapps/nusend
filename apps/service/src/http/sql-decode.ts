// Shared SQLite row decode: Schema.decodeUnknownEffect + orDie for read models.
import { Effect, Schema } from "effect";

export function decodeDbRow<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  row: unknown,
): Effect.Effect<S["Type"]> {
  return Schema.decodeUnknownEffect(schema)(row).pipe(Effect.orDie);
}

export function decodeDbRows<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  rows: readonly unknown[],
): Effect.Effect<readonly S["Type"][]> {
  return Effect.forEach(rows, (row) => decodeDbRow(schema, row));
}
