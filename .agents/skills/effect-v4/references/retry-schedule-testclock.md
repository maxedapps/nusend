# Retry, Schedule, Timeout, and TestClock Reference

## Table of contents
- [Retry and Schedule](#retry-and-schedule)
- [Timeouts](#timeouts)
- [Clock and TestClock](#clock-and-testclock)
- [Project patterns](#project-patterns)
- [Antipatterns](#antipatterns)
- [Official docs](#official-docs)

## Retry and Schedule

- Use `Effect.retry` with `Schedule` for transient failures.
- Keep retry policies bounded unless the task is explicitly a daemon/long-running poller.
- Use predicates such as `while` to retry only retryable typed errors.
- Prefer exponential backoff + limited recurs + jitter for external HTTP APIs.
- Keep retry metadata observable without logging secrets or raw response bodies.

Typical shape:

```ts
const retrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.both(Schedule.recurs(2)),
  Schedule.jittered,
)

program.pipe(
  Effect.retry({ schedule: retrySchedule, while: isRetryableError }),
)
```

## Timeouts

- Bound external calls with `Effect.timeout`.
- Convert timeout failures into typed domain errors when they affect HTTP responses, CLI output, or retry decisions.
- Pass an AbortSignal-aware promise to `Effect.tryPromise` where possible; Effect can then interrupt/cancel more cleanly.

## Clock and TestClock

- Use Effect `Clock` / time services where deterministic tests matter.
- Use `TestClock` to control time in tests instead of sleeping real time.
- For tests of sleeps/timeouts/retries, fork the sleeping effect first, adjust the test clock, then join/assert. If you await the sleeping effect before adjusting time, the test fiber can block.

## Project patterns

- Web Teachable client uses exponential retry, bounded recurs, jitter, timeout, and retry-only-for-retryable-errors.
- Tests use deterministic layers with `TestClock.layer()` and `TestClock.setTime(...)` for fixed time.
- Project code should prefer injected clocks/Effect time over raw `Date.now()` in logic that must be testable.

## Antipatterns

- Manual `for`/`while` retry loops with `setTimeout`.
- Unbounded retries for webhooks, CLI commands, or request handlers.
- Retrying configuration errors, validation errors, auth failures, or malformed requests.
- Tests that wait real seconds for backoff/timeout behavior.
- Ignoring cancellation/interrupt behavior for fetches or long-running promises.

## Official docs

- Retrying: https://effect.website/docs/error-management/retrying/
- Built-in schedules: https://effect.website/docs/scheduling/built-in-schedules/
- Repetition: https://effect.website/docs/scheduling/repetition/
- Timing out: https://effect.website/docs/error-management/timing-out/
- TestClock: https://effect.website/docs/testing/testclock/
- Schedule API: https://effect-ts.github.io/effect/effect/Schedule.ts.html
- Clock API: https://effect-ts.github.io/effect/effect/Clock.ts.html
- TestClock API: https://effect-ts.github.io/effect/effect/TestClock.ts.html
