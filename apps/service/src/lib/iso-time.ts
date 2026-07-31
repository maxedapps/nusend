// The only module allowed to construct `Date` values. Everything else reads time
// through `Clock` and does ISO math through these helpers.
import { Clock, Effect } from "effect";

export function toIso(millis: number): string {
  return new Date(millis).toISOString();
}

export function addSecondsIso(isoTime: string, seconds: number): string {
  return addMillisecondsIso(isoTime, seconds * 1000);
}

export function addMillisecondsIso(isoTime: string, milliseconds: number): string {
  return new Date(new Date(isoTime).getTime() + milliseconds).toISOString();
}

export function subtractDaysIso(isoTime: string, days: number): string {
  return addMillisecondsIso(isoTime, -days * 24 * 60 * 60 * 1000);
}

// Lenient acceptance on purpose: anything `new Date` parses and that renders as a
// canonical 4-digit-year ISO string is a valid scheduledAt. Expanded years
// (`+010000-…`) are rejected because timestamps are stored as TEXT and compared
// as strings, where they would sort before now.
export function parseLenientDateToIso(input: string): string | null {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  const iso = date.toISOString();
  return /^\d{4}-/u.test(iso) ? iso : null;
}

export const currentIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, toIso);

export const currentTimeMillis: Effect.Effect<number> = Clock.currentTimeMillis;

export function addMillisecondsFrom(nowMs: number, milliseconds: number): string {
  return toIso(nowMs + milliseconds);
}
