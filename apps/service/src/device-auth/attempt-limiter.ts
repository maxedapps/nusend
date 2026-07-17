export type AttemptDecision =
  | { readonly kind: "Allowed" }
  | {
      readonly kind: "Limited";
      readonly reason: "capacity" | "rate";
      readonly retryAfterMs: number;
    };

export type AttemptLimiter = {
  readonly attempt: (key: string) => AttemptDecision;
  readonly diagnostics: () => { readonly activeKeys: number };
  // Activation-code failure accounting checks first because a successful
  // inspection must not consume an attempt. Unauthenticated request routes use
  // only the atomic attempt API.
  readonly isLocked: (key: string) => boolean;
  readonly recordFailure: (key: string) => void;
};

export function makeAttemptLimiter(options: {
  readonly max: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly windowMs: number;
}): AttemptLimiter {
  assertPositiveInteger("max", options.max);
  const maxEntries = options.maxEntries ?? 128;
  assertPositiveInteger("maxEntries", maxEntries);
  assertPositiveNumber("windowMs", options.windowMs);

  const attemptsByKey = new Map<string, number[]>();
  const now = options.now ?? Date.now;

  function pruneExpired(at: number): number {
    let earliestExpiry = Number.POSITIVE_INFINITY;

    for (const [key, timestamps] of attemptsByKey) {
      const firstActive = timestamps.findIndex((timestamp) => timestamp + options.windowMs > at);
      if (firstActive === -1) {
        attemptsByKey.delete(key);
        continue;
      }

      const active = firstActive === 0 ? timestamps : timestamps.slice(firstActive);
      if (active !== timestamps) attemptsByKey.set(key, active);
      earliestExpiry = Math.min(earliestExpiry, active[0]! + options.windowMs);
    }

    return earliestExpiry;
  }

  const attempt = (key: string): AttemptDecision => {
    const at = now();
    const earliestExpiry = pruneExpired(at);
    const active = attemptsByKey.get(key);

    if (active && active.length >= options.max) {
      return {
        kind: "Limited",
        reason: "rate",
        retryAfterMs: active[0]! + options.windowMs - at,
      };
    }

    if (!active && attemptsByKey.size >= maxEntries) {
      return {
        kind: "Limited",
        reason: "capacity",
        retryAfterMs: earliestExpiry - at,
      };
    }

    if (active) active.push(at);
    else attemptsByKey.set(key, [at]);
    return { kind: "Allowed" };
  };

  return {
    attempt,
    diagnostics: () => ({ activeKeys: attemptsByKey.size }),
    isLocked: (key) => {
      const at = now();
      pruneExpired(at);
      const active = attemptsByKey.get(key);
      return (active?.length ?? 0) >= options.max || (!active && attemptsByKey.size >= maxEntries);
    },
    recordFailure: (key) => {
      attempt(key);
    },
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function assertPositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}
