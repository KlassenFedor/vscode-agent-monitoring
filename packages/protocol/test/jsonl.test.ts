import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonlAppender, readJsonl } from '../src/jsonl.js';
import { RecordTooLargeError } from '../src/errors.js';
import { parseEvent } from '../src/schema.js';
import { appendText, fileSize, makeRoot, readText, writeText } from './helpers.js';

/** Reader that keeps whatever it is given, for tests about framing rather than schema. */
const passthrough = (raw: unknown): Record<string, unknown> => raw as Record<string, unknown>;

function record(seq: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ seq, ts: '2026-01-01T00:00:00.000Z', type: 'progress', title: `n${seq}`, ...extra })}\n`;
}

describe('JsonlAppender', () => {
  it('PROTO-01: writes exactly one valid JSON line', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    const appender = new JsonlAppender(file);

    await appender.append((seq) => ({ seq, ts: '2026-01-01T00:00:00.000Z', title: 'first' }));

    const text = await readText(file);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(text.trimEnd())).toMatchObject({ seq: 1, title: 'first' });
  });

  it('PROTO-02: assigns sequence numbers starting at 1 and increasing by one', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    const appender = new JsonlAppender(file);

    const seqs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const written = await appender.append((seq) => ({ seq, ts: '2026-01-01T00:00:00.000Z' }));
      seqs.push(written.seq);
    }

    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('PROTO-02: a fresh appender continues the sequence of an existing file', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, record(1) + record(2));

    const written = await new JsonlAppender(file).append((seq) => ({ seq, ts: '2026-01-01T00:00:00.000Z' }));

    expect(written.seq).toBe(3);
  });

  it('PROTO-31: refuses a record larger than the line limit', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    const appender = new JsonlAppender(file);

    const huge = 'x'.repeat(5000);
    await expect(appender.append((seq) => ({ seq, huge }))).rejects.toThrow(RecordTooLargeError);
    await expect(appender.append((seq) => ({ seq, huge }))).rejects.toThrow(/artifacts\//);

    // The rejected record must not have consumed a sequence number or touched the file.
    const written = await appender.append((seq) => ({ seq, ts: '2026-01-01T00:00:00.000Z' }));
    expect(written.seq).toBe(1);
  });

  it('PROTO-11: heals a truncated trailing line instead of appending to it', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, `${record(1)}{"seq":2,"ts":"2026-01-01T00`);

    const written = await new JsonlAppender(file).append((seq) => ({
      seq,
      ts: '2026-01-01T00:00:01.000Z',
      type: 'progress',
      title: 'after crash',
    }));

    const lines = (await readText(file)).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] as string)).toMatchObject({ title: 'after crash' });
    expect(written.seq).toBe(3);

    // The fragment is reported as one skipped line; the two good records survive.
    const chunk = await readJsonl(file, 0, passthrough);
    expect(chunk.records.map((r) => r.seq)).toEqual([1, 3]);
    expect(chunk.skipped).toBe(1);
  });
});

describe('readJsonl', () => {
  it('PROTO-03: reads only the bytes appended since the given offset', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, record(1) + record(2));

    const first = await readJsonl(file, 0, passthrough);
    expect(first.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(first.nextOffset).toBe(await fileSize(file));

    const line3 = record(3);
    await appendText(file, line3);

    const second = await readJsonl(file, first.nextOffset, passthrough);
    expect(second.records.map((r) => r.seq)).toEqual([3]);
    expect(second.nextOffset - first.nextOffset).toBe(Buffer.byteLength(line3, 'utf8'));
    expect(second.reset).toBe(false);
  });

  it('PROTO-10: skips a corrupt line in the middle and keeps reading', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, `${record(1)}{not json}\n${record(3)}`);

    const chunk = await readJsonl(file, 0, passthrough);

    expect(chunk.records.map((r) => r.seq)).toEqual([1, 3]);
    expect(chunk.skipped).toBe(1);
  });

  it('PROTO-11: holds an unterminated trailing line until it is complete', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, `${record(1)}{"seq":2,"ts"`);

    const held = await readJsonl(file, 0, passthrough);
    expect(held.records.map((r) => r.seq)).toEqual([1]);
    expect(held.nextOffset).toBe(Buffer.byteLength(record(1), 'utf8'));
    expect(held.skipped).toBe(0);

    await appendText(file, `:"2026-01-01T00:00:00.000Z","type":"progress","title":"n2"}\n`);

    const completed = await readJsonl(file, held.nextOffset, passthrough);
    expect(completed.records.map((r) => r.seq)).toEqual([2]);
  });

  it('PROTO-13: answers empty for a missing file and a missing directory', async () => {
    const root = await makeRoot();

    const missingFile = await readJsonl(path.join(root, 'events.jsonl'), 0, passthrough);
    expect(missingFile).toMatchObject({ records: [], nextOffset: 0, skipped: 0, reset: false });

    const missingDir = await readJsonl(path.join(root, 'nope', 'events.jsonl'), 0, passthrough);
    expect(missingDir.records).toEqual([]);
  });

  it('PROTO-13: reports a reset when the file shrank or disappeared', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, record(1));

    const truncated = await readJsonl(file, 10_000, passthrough);
    expect(truncated.reset).toBe(true);
    expect(truncated.records.map((r) => r.seq)).toEqual([1]);
  });

  it('PROTO-15: reads CRLF line endings and a leading BOM', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, `﻿${record(1).trimEnd()}\r\n${record(2).trimEnd()}\r\n`);

    const chunk = await readJsonl(file, 0, passthrough);

    expect(chunk.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(chunk.skipped).toBe(0);
    expect(chunk.nextOffset).toBe(await fileSize(file));
  });

  it('PROTO-14: skips lines that parse as JSON but fail validation', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, `${record(1)}{"seq":2,"ts":"2026-01-01T00:00:00.000Z","type":"nonsense","title":"x"}\n${record(3)}`);

    const chunk = await readJsonl(file, 0, parseEvent);

    expect(chunk.records.map((r) => r.seq)).toEqual([1, 3]);
    expect(chunk.skipped).toBe(1);
  });

  it('ignores blank lines a human editor may have left behind', async () => {
    const file = path.join(await makeRoot(), 'events.jsonl');
    await writeText(file, `${record(1)}\n\n${record(2)}`);

    const chunk = await readJsonl(file, 0, passthrough);

    expect(chunk.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(chunk.skipped).toBe(0);
  });
});
