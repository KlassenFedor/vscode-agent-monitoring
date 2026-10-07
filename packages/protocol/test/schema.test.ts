import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/errors.js';
import { parseComment, parseCursor, parseEvent, parseMeta } from '../src/schema.js';

const baseEvent = {
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  type: 'progress',
  title: 'parser split into three modules',
};

describe('parseEvent', () => {
  it('PROTO-05: preserves fields it does not know about', async () => {
    const parsed = parseEvent({
      ...baseEvent,
      future_field: { nested: [1, 2, 3] },
      cost: { tokens_in: 10, vendor_extra: 'keep me' },
    });

    expect(parsed.future_field).toEqual({ nested: [1, 2, 3] });
    expect(parsed.cost).toEqual({ tokens_in: 10, vendor_extra: 'keep me' });
  });

  it('PROTO-06: rejects an unknown event type', () => {
    expect(() => parseEvent({ ...baseEvent, type: 'gossip' })).toThrow(ValidationError);
    expect(() => parseEvent({ ...baseEvent, type: 'gossip' })).toThrow(/event\.type/);
  });

  it('PROTO-06: rejects missing, empty and non-string titles', () => {
    expect(() => parseEvent({ ...baseEvent, title: undefined })).toThrow(/event\.title/);
    expect(() => parseEvent({ ...baseEvent, title: '   ' })).toThrow(/must not be empty/);
    expect(() => parseEvent({ ...baseEvent, title: 42 })).toThrow(/expected a string/);
  });

  it('PROTO-06: rejects a sequence number that is not a positive safe integer', () => {
    for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2, '1']) {
      expect(() => parseEvent({ ...baseEvent, seq })).toThrow(/event\.seq/);
    }
  });

  it('PROTO-06: rejects a non-object record', () => {
    for (const raw of [null, 42, 'text', [baseEvent]]) {
      expect(() => parseEvent(raw)).toThrow(/^event:/);
    }
  });

  it('normalises timestamps to UTC so string order equals time order', () => {
    expect(parseEvent({ ...baseEvent, ts: '2026-01-01T03:00:00+03:00' }).ts).toBe('2026-01-01T00:00:00.000Z');
    expect(() => parseEvent({ ...baseEvent, ts: 'yesterday' })).toThrow(/ISO-8601/);
  });

  it('SEC-01: rejects artifact references that point outside artifacts/', () => {
    const bad = [
      'artifacts/../../etc/passwd',
      '../artifacts/x.md',
      '/etc/passwd',
      'artifacts/sub/dir.md',
      'notartifacts/x.md',
    ];
    for (const ref of bad) {
      expect(() => parseEvent({ ...baseEvent, artifacts: [ref] })).toThrow(ValidationError);
    }
    expect(parseEvent({ ...baseEvent, artifacts: ['artifacts/0007-report.md'] }).artifacts).toEqual([
      'artifacts/0007-report.md',
    ]);
  });
});

describe('parseComment', () => {
  const baseComment = { seq: 1, ts: '2026-01-01T00:00:00.000Z', kind: 'steer', text: 'skip legacy/' };

  it('accepts every documented kind and rejects anything else', () => {
    for (const kind of ['fyi', 'steer', 'answer', 'stop']) {
      expect(parseComment({ ...baseComment, kind }).kind).toBe(kind);
    }
    expect(() => parseComment({ ...baseComment, kind: 'shout' })).toThrow(/comment\.kind/);
  });

  it('PROTO-05: preserves unknown fields', () => {
    expect(parseComment({ ...baseComment, ui_origin: 'webview' }).ui_origin).toBe('webview');
  });

  it('PROTO-06: rejects an empty comment and a bad reply target', () => {
    expect(() => parseComment({ ...baseComment, text: '' })).toThrow(/comment\.text/);
    expect(() => parseComment({ ...baseComment, reply_to: 0 })).toThrow(/comment\.reply_to/);
  });
});

/**
 * The on-disk format is a contract, and these two records are part of it.
 *
 * The `ask_user` tool that wrote them was removed, so nothing produces them any more —
 * but a session recorded before that still has to open, and `readJsonl` skips a line it
 * cannot validate without saying so. Take either value out of its list and the old rows
 * disappear from the timeline as if they had never been written.
 */
describe('PROTO-57: records the removed ask_user tool left behind still parse', () => {
  it('reads a question event and keeps the options beside it', () => {
    const parsed = parseEvent({
      seq: 2,
      ts: '2026-01-01T00:05:00.000Z',
      type: 'question',
      title: 'Postgres or SQLite?',
      needs_answer: true,
      options: ['postgres', 'sqlite'],
    });

    expect(parsed.type).toBe('question');
    expect(parsed.needs_answer).toBe(true);
    expect(parsed.options).toEqual(['postgres', 'sqlite']);
  });

  it('reads an answer comment', () => {
    const parsed = parseComment({
      seq: 1,
      ts: '2026-01-01T00:06:00.000Z',
      kind: 'answer',
      text: 'postgres',
      reply_to: 2,
    });

    expect(parsed.kind).toBe('answer');
    expect(parsed.reply_to).toBe(2);
  });

  it('still refuses a malformed value on a legacy field', () => {
    expect(() => parseEvent({ ...baseEvent, type: 'question', needs_answer: 'yes' })).toThrow(
      /event\.needs_answer/,
    );
  });
});

describe('parseMeta and parseCursor', () => {
  const baseMeta = {
    id: 'sess-1',
    agent: 'claude',
    cwd: '/work',
    status: 'working',
    started_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    protocol_version: 1,
  };

  it('accepts a complete record and rejects an unknown status', () => {
    expect(parseMeta(baseMeta).status).toBe('working');
    expect(() => parseMeta({ ...baseMeta, status: 'napping' })).toThrow(/meta\.status/);
    expect(() => parseMeta({ ...baseMeta, agent: 'gemini' })).toThrow(/meta\.agent/);
  });

  it('takes archived_at only as a timestamp', () => {
    expect(parseMeta({ ...baseMeta, archived_at: '2026-08-20T09:00:00Z' }).archived_at).toBe(
      '2026-08-20T09:00:00.000Z',
    );
    expect(parseMeta(baseMeta)).not.toHaveProperty('archived_at');
    expect(() => parseMeta({ ...baseMeta, archived_at: true })).toThrow(/meta\.archived_at/);
    expect(() => parseMeta({ ...baseMeta, archived_at: 'yesterday' })).toThrow(/meta\.archived_at/);
  });

  it('takes restored_at only as a timestamp', () => {
    expect(parseMeta({ ...baseMeta, restored_at: '2026-08-20T09:00:00Z' }).restored_at).toBe(
      '2026-08-20T09:00:00.000Z',
    );
    expect(parseMeta(baseMeta)).not.toHaveProperty('restored_at');
    expect(() => parseMeta({ ...baseMeta, restored_at: 'yesterday' })).toThrow(/meta\.restored_at/);
  });

  it('allows a zero cursor but not a negative one', () => {
    expect(parseCursor({ inbox_seq: 0, updated_at: '2026-01-01T00:00:00.000Z' }).inbox_seq).toBe(0);
    expect(() => parseCursor({ inbox_seq: -1, updated_at: '2026-01-01T00:00:00.000Z' })).toThrow(
      /cursor\.inbox_seq/,
    );
  });
});

describe('event links', () => {
  it('keeps a workspace link on the event, canonicalised', () => {
    const event = parseEvent({
      seq: 1,
      ts: '2026-08-13T10:00:00.000Z',
      type: 'artifact',
      title: 'the parser',
      links: ['src\\core\\parser.ts', './docs/plan.md'],
    });

    expect(event.links).toEqual(['src/core/parser.ts', 'docs/plan.md']);
  });

  it('SEC-04: refuses a link that climbs out of the workspace', () => {
    const event = {
      seq: 1,
      ts: '2026-08-13T10:00:00.000Z',
      type: 'artifact',
      title: 'x',
      links: ['../../etc/passwd'],
    };

    expect(() => parseEvent(event)).toThrow(ValidationError);
  });

  it('keeps links and artifacts apart, since they resolve against different roots', () => {
    const event = parseEvent({
      seq: 1,
      ts: '2026-08-13T10:00:00.000Z',
      type: 'artifact',
      title: 'x',
      artifacts: ['artifacts/0001-plan.diff'],
      links: ['src/parser.ts'],
    });

    expect(event.artifacts).toEqual(['artifacts/0001-plan.diff']);
    expect(event.links).toEqual(['src/parser.ts']);
  });
});
