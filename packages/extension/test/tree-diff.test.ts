import { describe, expect, it } from 'vitest';

import { planTreeRefresh } from '../src/core/tree-diff.js';

const rows = (...pairs: [string, string][]): Map<string, string> => new Map(pairs);

describe('sessions list refresh plan', () => {
  it('EXT-41: an unchanged list is not redrawn at all', () => {
    // This is the whole point. The list is rebuilt about once a second, and a redraw
    // takes the hover with it: the tooltip on a session name flashed and vanished,
    // and the one on an inline button flickered as the button was rebuilt underneath.
    const before = rows(['session:a', 'A'], ['session:b', 'B']);

    expect(planTreeRefresh(before, rows(['session:a', 'A'], ['session:b', 'B']))).toEqual({
      all: false,
      keys: [],
    });
  });

  it('EXT-41: only the rows that changed are named', () => {
    const before = rows(['session:a', 'A'], ['session:b', 'B'], ['session:c', 'C']);
    const after = rows(['session:a', 'A'], ['session:b', 'B2'], ['session:c', 'C']);

    expect(planTreeRefresh(before, after)).toEqual({ all: false, keys: ['session:b'] });
  });

  it('EXT-41: a row that appeared, vanished or moved redraws everything', () => {
    const before = rows(['session:a', 'A'], ['session:b', 'B']);

    // VS Code's change event names a subtree; there is no narrower way to say that a
    // row is now somewhere else, so order is a whole-tree change.
    expect(planTreeRefresh(before, rows(['session:b', 'B'], ['session:a', 'A']))).toEqual({
      all: true,
      keys: [],
    });
    expect(planTreeRefresh(before, rows(['session:a', 'A']))).toEqual({ all: true, keys: [] });
    expect(planTreeRefresh(before, rows(['session:a', 'A'], ['session:b', 'B'], ['archive', '1']))).toEqual({
      all: true,
      keys: [],
    });
    // Same size, different rows: a session deleted and another registered in one tick.
    expect(planTreeRefresh(before, rows(['session:a', 'A'], ['session:c', 'B']))).toEqual({
      all: true,
      keys: [],
    });
  });

  it('EXT-41: the first refresh of an empty list draws the whole thing', () => {
    expect(planTreeRefresh(rows(), rows(['session:a', 'A']))).toEqual({ all: true, keys: [] });
    expect(planTreeRefresh(rows(), rows())).toEqual({ all: false, keys: [] });
  });
});
