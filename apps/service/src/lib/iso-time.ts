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

// Lenient acceptance on purpose: anything `new Date` parses is a valid scheduledAt.
export function parseLenientDateToIso(input: string): string | null {
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const currentIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, toIso);
