import { Schema, SchemaGetter } from "effect";

export const maxEmailLength = 320;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  const atIndex = value.indexOf("@");
  return (
    value.length > 0 &&
    value.length <= maxEmailLength &&
    atIndex > 0 &&
    atIndex === value.lastIndexOf("@") &&
    atIndex !== value.length - 1 &&
    !/\s/.test(value)
  );
}

export function normalizeValidEmail(value: string): string | null {
  const normalized = normalizeEmail(value);
  return isValidEmail(normalized) ? normalized : null;
}

/** Shared Effect Schema filter applied after normalization. */
const emailValidityFilter = Schema.makeFilter<string>(
  (email) => isValidEmail(email) || "must be a valid email address",
);

/**
 * Canonical email schema: trim + lowercase, then isValidEmail (includes max length 320).
 * Used by mailings, lists, and suppressions request decoders.
 */
export const EmailSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => normalizeEmail(value)),
    encode: SchemaGetter.passthrough(),
  }),
).check(emailValidityFilter);
