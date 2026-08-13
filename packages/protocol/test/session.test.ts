import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createManualClock } from '../src/clock.js';
import { UnsafeNameError } from '../src/errors.js';
import { eventsPath, inboxPath, metaPath } from '../src/paths.js';
import { SessionStore, normalizeRecords } from '../src/session.js';
import { commentInput, eventInput, makeRoot, writeText } from './helpers.js';

async function openSession(options: { tickMs?: number } = {}) {
  const root = await makeRoot();
  const clock = createManualClock('2026-08-13T10:00:00.000Z', { tickMs: options.tickMs ?? 1 });
  const store = SessionStore.open(root, 'sess-1', { clock });
  await store.init({ agent: 'claude', cwd: root });
  return { root, store, clock };
}

describe('SessionStore.init', () => {
  it('creates metadata once and is safe to call again', async () => {
    const { root, store } = await openSession();

    const first = await store.readMeta();
    const again = await store.init({ agent: 'codex', cwd: '/elsewhere' });

    expect(first).toMatchObject({ id: 'sess-1', agent: 'claude', status: 'working', protocol_version: 1 });
    expect(again).toEqual(first);
    expect(await fs.readdir(path.dirname(metaPath(root, 'sess-1')))).toContain('meta.json');
  });

  it('merges patches without dropping unknown fields', async () => {
    const { store } = await openSession();
    await store.patchMeta({ vendor_hint: 'kept' } as never);

    const patched = await store.patchMeta({ status: 'done', title: 'refactor parser' });

    expect(patched).toMatchObject({ status: 'done', title: 'refactor parser', vendor_hint: 'kept' });
    expect(patched.updated_at > patched.started_at).toBe(true);
  });
});

describe('SessionStore events and comments', () => {
  it('writes events and comments to their own files', async () => {
    const { root, store } = await openSession();

    await store.appendEvent(eventInput({ title: 'parser split' }));
    await store.appendComment(commentInput());

    expect(await fs.readFile(eventsPath(root, 'sess-1'), 'utf8')).toContain('parser split');
    expect(await fs.readFile(inboxPath(root, 'sess-1'), 'utf8')).toContain('legacy/');
  });

  it('stamps records with the injected clock', async () => {
    const { store, clock } = await openSession({ tickMs: 0 });
    clock.set('2026-08-13T12:00:00.000Z');

    const event = await store.appendEvent(eventInput());

    expect(event.ts).toBe('2026-08-13T12:00:00.000Z');
  });

  it('PROTO-12: collapses duplicate sequence numbers and orders by timestamp', async () => {
    const { root, store } = await openSession();
    await writeText(
      eventsPath(root, 'sess-1'),
      [
        '{"seq":2,"ts":"2026-08-13T10:00:02.000Z","type":"progress","title":"second"}',
        '{"seq":1,"ts":"2026-08-13T10:00:01.000Z","type":"progress","title":"first"}',
        '{"seq":2,"ts":"2026-08-13T10:00:09.000Z","type":"progress","title":"duplicate"}',
        '',
      ].join('\n'),
    );

    const events = await store.listEvents();

    expect(events.map((e) => e.title)).toEqual(['first', 'second']);
  });

  it('normalizeRecords is stable for records sharing a timestamp', () => {
    const records = [
      { seq: 3, ts: 'T' },
      { seq: 1, ts: 'T' },
      { seq: 2, ts: 'T' },
    ];
    expect(normalizeRecords(records).map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});

describe('SessionStore cursor', () => {
  it('starts at zero and reports every comment as unread', async () => {
    const { store } = await openSession();
    await store.appendComment(commentInput({ text: 'one' }));
    await store.appendComment(commentInput({ text: 'two' }));

    expect((await store.readCursor()).inbox_seq).toBe(0);
    expect((await store.unreadComments()).map((c) => c.text)).toEqual(['one', 'two']);
  });

  it('HOOK-06: reading does not advance the cursor, only an explicit commit does', async () => {
    const { store } = await openSession();
    await store.appendComment(commentInput({ text: 'one' }));

    await store.unreadComments();
    expect((await store.readCursor()).inbox_seq).toBe(0);

    await store.commitCursor(1);
    expect(await store.unreadComments()).toEqual([]);
  });

  it('MCP-04: only comments written after the commit are unread again', async () => {
    const { store } = await openSession();
    await store.appendComment(commentInput({ text: 'one' }));
    await store.commitCursor(1);

    await store.appendComment(commentInput({ text: 'two' }));

    expect((await store.unreadComments()).map((c) => c.text)).toEqual(['two']);
  });

  it('never moves the cursor backwards', async () => {
    const { store } = await openSession();
    await store.commitCursor(5);
    expect((await store.commitCursor(2)).inbox_seq).toBe(5);
  });

  it('carries extra fields the hook uses for debouncing', async () => {
    const { store } = await openSession();
    const cursor = await store.commitCursor(1, { last_drain_at: '2026-08-13T10:05:00.000Z' });
    expect(cursor.last_drain_at).toBe('2026-08-13T10:05:00.000Z');
    expect((await store.readCursor()).last_drain_at).toBe('2026-08-13T10:05:00.000Z');
  });
});

describe('SessionStore artifacts', () => {
  it('stores an artifact and returns the reference used inside events', async () => {
    const { store } = await openSession();

    const written = await store.writeArtifact('report.md', '# hello\n');
    const event = await store.appendEvent(eventInput({ artifacts: [written.ref] }));

    expect(written.ref).toBe('artifacts/report.md');
    expect(event.artifacts).toEqual(['artifacts/report.md']);
    expect((await store.readArtifact('report.md'))?.toString('utf8')).toBe('# hello\n');
  });

  it('MCP-07: never overwrites an existing artifact', async () => {
    const { store } = await openSession();

    const first = await store.writeArtifact('report.md', 'first');
    const second = await store.writeArtifact('report.md', 'second');

    expect([first.name, second.name]).toEqual(['report.md', 'report-2.md']);
    expect((await store.readArtifact('report.md'))?.toString('utf8')).toBe('first');
    expect(await store.listArtifacts()).toEqual(['report-2.md', 'report.md']);
  });

  it('SEC-04: refuses to write outside the artifacts directory', async () => {
    const { root, store } = await openSession();

    await expect(store.writeArtifact('../../../escape.md', 'x')).rejects.toThrow(UnsafeNameError);
    await expect(fs.readFile(path.join(root, '..', 'escape.md'), 'utf8')).rejects.toThrow();
  });

  it('answers null for an artifact that was never written', async () => {
    const { store } = await openSession();
    expect(await store.readArtifact('missing.md')).toBeNull();
    expect(await store.listArtifacts()).toEqual([]);
  });
});
