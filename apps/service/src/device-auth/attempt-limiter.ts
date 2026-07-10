export type AttemptLimiter = {
  readonly isLocked: (key: string) => boolean;
  readonly recordFailure: (key: string) => void;
};

export function makeAttemptLimiter(options: {
  readonly max: number;
  readonly now?: () => number;
  readonly windowMs: number;
}): AttemptLimiter {
  const failures = new Map<string, number[]>();
  const now = options.now ?? Date.now;

  function activeFailures(key: string): number[] {
    const cutoff = now() - options.windowMs;
    const active = (failures.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (active.length === 0) failures.delete(key);
    else failures.set(key, active);
    return active;
  }

  return {
    isLocked: (key) => activeFailures(key).length >= options.max,
    recordFailure: (key) => {
      const active = activeFailures(key);
      active.push(now());
      failures.set(key, active);
    },
  };
}
