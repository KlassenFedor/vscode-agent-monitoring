import { describe, expect, it } from 'vitest';

import {
  describeDays,
  describeLabelExtras,
  parseDays,
  readDays,
  retentionConflict,
} from '../src/core/list-settings.js';

describe('EXT-45: the Sessions list settings menu', () => {
  it('reads a day count typed by a person', () => {
    expect(parseDays('14')).toBe(14);
    expect(parseDays(' 0 ')).toBe(0);
    expect(parseDays('1.5')).toBe(1.5);
    // A decimal comma is what half the keyboards produce.
    expect(parseDays('1,5')).toBe(1.5);
  });

  it('refuses anything that is not a non-negative number of days', () => {
    for (const input of ['', '-1', 'two', '1e3', '7 days', 'Infinity', '.5']) {
      expect(parseDays(input), input).toBeNull();
    }
  });

  it('falls back to the default rather than acting on a broken setting', () => {
    expect(readDays(7, 14)).toBe(7);
    expect(readDays(0, 14)).toBe(0);
    for (const raw of [undefined, null, -3, Number.NaN, '7', Number.POSITIVE_INFINITY]) {
      expect(readDays(raw, 14)).toBe(14);
    }
  });

  it('says what a value does in words', () => {
    expect(describeDays(0)).toBe('off');
    expect(describeDays(1)).toBe('after 1 day');
    expect(describeDays(14)).toBe('after 14 days');
    expect(describeLabelExtras([])).toBe('title only');
    expect(describeLabelExtras(['updated', 'agent'])).toBe('agent, updated');
  });

  it('points out an archive deadline that deletion always beats', () => {
    expect(retentionConflict(14, 7)).toMatch(/deleted after 7 day/);
    expect(retentionConflict(7, 7)).toMatch(/deleted after 7 day/);
    expect(retentionConflict(3, 14)).toBeUndefined();
    // Either one switched off leaves nothing to fight over.
    expect(retentionConflict(0, 7)).toBeUndefined();
    expect(retentionConflict(14, 0)).toBeUndefined();
  });
});
