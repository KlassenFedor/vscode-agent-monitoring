import * as path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { JsonlAppender, readJsonl } from '../src/jsonl.js';
import { parseEvent, type EventType } from '../src/schema.js';
import { makeRoot, readText } from './helpers.js';

/**
 * JSON cannot express negative zero: `JSON.parse(JSON.stringify(-0))` is `0`.
 * That is a property of the wire format, not of this package, so the generator does
 * not produce values the format is unable to carry.
 */
function withoutNegativeZero(value: unknown): unknown {
  if (Object.is(value, -0)) return 0;
  if (Array.isArray(value)) return value.map(withoutNegativeZero);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNegativeZero(v)]));
  }
  return value;
}

/** Text that may contain newlines, quotes, emoji, lone surrogates — anything a user types. */
const text = fc.fullUnicodeString({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0);

// `question` and `needs_answer` are generated on purpose even though nothing writes them
// any more: they are the legacy-read guarantee (PROTO-57), and a round trip is exactly
// what they have to survive. Narrowing this generator would quietly drop that proof.
const eventArb = fc.record(
  {
    type: fc.constantFrom<EventType>('progress', 'artifact', 'question', 'status', 'error'),
    title: text,
    summary: fc.option(fc.fullUnicodeString({ maxLength: 200 }), { nil: undefined }),
    phase: fc.option(text, { nil: undefined }),
    needs_answer: fc.option(fc.boolean(), { nil: undefined }),
    extra_unknown_field: fc.option(fc.jsonValue().map(withoutNegativeZero), { nil: undefined }),
  },
  { requiredKeys: ['type', 'title'] },
);

describe('JSONL round trip', () => {
  it('PROTO-20: every written record is read back unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArb, { minLength: 1, maxLength: 25 }), async (inputs) => {
        const file = path.join(await makeRoot('agent-monitor-prop-'), 'events.jsonl');
        const appender = new JsonlAppender(file);

        const written = [];
        for (const input of inputs) {
          written.push(
            await appender.append((seq) => parseEvent({ ...input, seq, ts: '2026-01-01T00:00:00.000Z' })),
          );
        }

        const chunk = await readJsonl(file, 0, parseEvent);
        expect(chunk.skipped).toBe(0);
        expect(chunk.records).toEqual(written);
      }),
      { numRuns: 40 },
    );
  });

  it('PROTO-21: one record is always exactly one line', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArb, { minLength: 1, maxLength: 15 }), async (inputs) => {
        const file = path.join(await makeRoot('agent-monitor-prop-'), 'events.jsonl');
        const appender = new JsonlAppender(file);

        for (const input of inputs) {
          await appender.append((seq) => parseEvent({ ...input, seq, ts: '2026-01-01T00:00:00.000Z' }));
        }

        const raw = await readText(file);
        expect(raw.endsWith('\n')).toBe(true);
        expect(raw.trimEnd().split('\n')).toHaveLength(inputs.length);
      }),
      { numRuns: 30 },
    );
  });
});
