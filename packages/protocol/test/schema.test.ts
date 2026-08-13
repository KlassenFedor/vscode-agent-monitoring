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

  it('allows a zero cursor but not a negative one', () => {
    expect(parseCursor({ inbox_seq: 0, updated_at: '2026-01-01T00:00:00.000Z' }).inbox_seq).toBe(0);
    expect(() => parseCursor({ inbox_seq: -1, updated_at: '2026-01-01T00:00:00.000Z' })).toThrow(
      /cursor\.inbox_seq/,
    );
  });
});
