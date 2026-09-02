/**
 * The only source of time in the engine (CLAUDE.md §4). Injected so tests are
 * deterministic and so instrumentation can be sampled rather than called per row
 * (CLAUDE.md §5).
 */
export interface Clock {
  now(): number;
}

export const performanceClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

/** A clock that advances a fixed amount per call. Tests use this. */
export function fixedClock(stepMs = 1): Clock {
  let t = 0;
  return { now: () => (t += stepMs) };
}
