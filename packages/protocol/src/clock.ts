/**
 * Time source.
 *
 * Injected everywhere a timestamp is produced so tests can assert on exact `ts`
 * values instead of sleeping (docs/TESTS.md §1.4).
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Current time as a UTC ISO-8601 string, the only timestamp format on disk. */
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

export interface ManualClock extends Clock {
  /** Move time forward. */
  advance(ms: number): void;
  /** Jump to an absolute point in time. */
  set(time: number | string): void;
}

/**
 * Deterministic clock for tests.
 *
 * `tickMs` advances time on every read, which is how a test gets a strictly
 * increasing sequence of timestamps without calling `advance` by hand. It defaults
 * to 0 so that ordering ties are reproducible when a test wants them.
 */
export function createManualClock(
  start: number | string = '2026-01-01T00:00:00.000Z',
  options: { tickMs?: number } = {},
): ManualClock {
  const tickMs = options.tickMs ?? 0;
  let current = toMillis(start);

  return {
    now(): number {
      const value = current;
      current += tickMs;
      return value;
    },
    iso(): string {
      const value = current;
      current += tickMs;
      return new Date(value).toISOString();
    },
    advance(ms: number): void {
      current += ms;
    },
    set(time: number | string): void {
      current = toMillis(time);
    },
  };
}

function toMillis(time: number | string): number {
  if (typeof time === 'number') return time;
  const parsed = Date.parse(time);
  if (Number.isNaN(parsed)) throw new TypeError(`not a parsable time: ${time}`);
  return parsed;
}
