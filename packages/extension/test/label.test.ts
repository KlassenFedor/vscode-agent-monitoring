import { describe, expect, it } from 'vitest';

import { decorateLabel, formatStamp, parseLabelExtras } from '../src/core/label.js';

/** Noon on 2026-08-24, UTC. Every case names its own offset, so this is a fixed point. */
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

describe('session label extras', () => {
  it('EXT-40: shows the title alone by default', () => {
    expect(parseLabelExtras(undefined)).toEqual([]);
    expect(decorateLabel('Fix the tree flicker', { agent: 'claude' }, [], NOW, 0)).toBe(
      'Fix the tree flicker',
    );
  });

  it('EXT-40: prefixes whichever extras were chosen, always in the same order', () => {
    const facts = {
      agent: 'claude',
      createdAt: '2026-08-24T09:15:00.000Z',
      updatedAt: '2026-08-24T11:47:00.000Z',
    };

    // The setting is a set of checkboxes, so it arrives in whatever order the user
    // ticked them. A column of rows assembled differently cannot be read down.
    const extras = parseLabelExtras(['updated', 'agent', 'created']);

    expect(extras).toEqual(['agent', 'created', 'updated']);
    expect(decorateLabel('Fix the tree flicker', facts, extras, NOW, 0)).toBe(
      '[claude] [09:15] [11:47] Fix the tree flicker',
    );
  });

  it('EXT-40: leaves out a fact it does not have, rather than showing it empty', () => {
    // A transcript-only session has no start time, and `[]` in its place says nothing.
    const extras = parseLabelExtras(['agent', 'created', 'updated']);

    expect(
      decorateLabel(
        'codex session',
        { agent: 'codex', updatedAt: '2026-08-24T11:47:00.000Z' },
        extras,
        NOW,
        0,
      ),
    ).toBe('[codex] [11:47] codex session');
  });

  it('EXT-40: ignores anything in the setting it does not recognise', () => {
    expect(parseLabelExtras(['agent', 'branch', 42, null])).toEqual(['agent']);
    expect(parseLabelExtras('agent')).toEqual([]);
    expect(parseLabelExtras({ agent: true })).toEqual([]);
  });

  it('EXT-40: dates the stamp only when it is not today', () => {
    expect(formatStamp('2026-08-24T09:15:00.000Z', NOW, 0)).toBe('09:15');
    expect(formatStamp('2026-08-21T09:15:00.000Z', NOW, 0)).toBe('21.08 09:15');
    // The offset moves both the stamp and "today", so a session started at 23:00 UTC
    // is this morning in Moscow and yesterday evening in Los Angeles.
    expect(formatStamp('2026-08-23T23:30:00.000Z', NOW, 180)).toBe('02:30');
    expect(formatStamp('2026-08-23T23:30:00.000Z', NOW, -420)).toBe('23.08 16:30');
  });

  it('EXT-40: a timestamp it cannot parse is passed through rather than shown as garbage', () => {
    expect(formatStamp('not a date', NOW, 0)).toBe('not a date');
  });
});
