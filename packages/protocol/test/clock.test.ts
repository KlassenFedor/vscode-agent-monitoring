import { describe, expect, it } from 'vitest';

import { createManualClock, systemClock } from '../src/clock.js';

describe('clocks', () => {
  it('the system clock reports UTC ISO timestamps', () => {
    expect(systemClock.iso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000);
  });

  it('the manual clock stands still unless asked to move', () => {
    const clock = createManualClock('2026-08-13T10:00:00.000Z');

    expect(clock.iso()).toBe('2026-08-13T10:00:00.000Z');
    expect(clock.iso()).toBe('2026-08-13T10:00:00.000Z');

    clock.advance(1500);
    expect(clock.iso()).toBe('2026-08-13T10:00:01.500Z');

    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now()).toBe(Date.parse('2027-01-01T00:00:00.000Z'));
  });

  it('ticks on every read when asked, giving strictly increasing timestamps', () => {
    const clock = createManualClock(0, { tickMs: 5 });
    expect([clock.now(), clock.now(), clock.now()]).toEqual([0, 5, 10]);
  });

  it('rejects a start value that is not a time', () => {
    expect(() => createManualClock('not a date')).toThrow(TypeError);
  });
});
