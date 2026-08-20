import { promises as fs } from 'node:fs';

import { claimCurrentSession, sessionDir, SessionStore } from '@agent-monitor/protocol';
import { describe, expect, it } from 'vitest';

import { sessionFootprint } from '../src/core/manage.js';
import { makeExtHarness } from './helpers.js';

async function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

describe('EXT-39: managing sessions from the list', () => {
  it('takes an archived session out of the list without touching what it holds', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'first', summary: 'did a thing' });
    await harness.model.refresh();

    await harness.model.setArchived('sess-1', true);

    const session = harness.model.session('sess-1');
    expect(session?.archived).toBe(true);
    expect(session?.events).toHaveLength(1);
    expect(await exists(sessionDir(harness.root, 'sess-1'))).toBe(true);
    expect((await store.readMeta())?.archived_at).toBeTypeOf('string');
  });

  it('stops an archived session from counting as something to attend to', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'question', title: 'which one?', needs_answer: true });
    await store.patchMeta({ status: 'blocked' });
    await harness.human().comment('do the second one');

    const before = await harness.model.refresh();
    expect(before.waitingCount).toBe(1);
    expect(before.unreadTotal).toBe(1);

    const after = await harness.model.setArchived('sess-1', true);

    // Archiving is the human saying they are done being interrupted by this session;
    // the question and the undelivered comment are still there to read.
    expect(after.waitingCount).toBe(0);
    expect(after.unreadTotal).toBe(0);
    expect(harness.model.session('sess-1')?.waitingQuestion).not.toBeNull();
    expect(harness.model.session('sess-1')?.unread).toHaveLength(1);
  });

  it('does not let filing a session away pass for activity', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'first' });
    const before = (await store.readMeta())?.updated_at;

    harness.clock.advance(60 * 60_000);
    await harness.model.refresh();
    await harness.model.setArchived('sess-1', true);

    // `updated_at` is how old the session is for rotation and how stale it looks in the
    // list. A bookkeeping write by the human says nothing about the agent's work.
    expect((await store.readMeta())?.updated_at).toBe(before);
  });

  it('puts a restored session back where it was', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await harness.model.refresh();

    await harness.model.setArchived('sess-1', true);
    await harness.model.setArchived('sess-1', false);

    expect(harness.model.session('sess-1')?.archived).toBe(false);
    // The field is gone from the file, not left behind as an empty string.
    expect(await store.readMeta()).not.toHaveProperty('archived_at');
  });

  it('sorts archived sessions below everything else', async () => {
    const harness = await makeExtHarness();
    for (const id of ['sess-1', 'sess-2']) await harness.agent(id);
    await harness.model.refresh();

    await harness.model.setArchived('sess-1', true);

    expect(harness.model.snapshot().sessions.map((session) => session.id)).toEqual(['sess-2', 'sess-1']);
  });

  it('deletes a session directory and forgets it', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'first' });
    await store.writeArtifact('plan.md', '# plan');
    await harness.model.refresh();

    const snapshot = await harness.model.remove('sess-1');

    expect(snapshot.sessions).toEqual([]);
    expect(await exists(sessionDir(harness.root, 'sess-1'))).toBe(false);
  });

  it('reads a fresh session from disk after one with the same id was deleted', async () => {
    // The agent that owned the id is still running: its next report starts the directory
    // again. Reading a new file from the old byte offset would lose its first records.
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'first' });
    await harness.model.refresh();
    await harness.model.remove('sess-1');

    const restarted = SessionStore.open(harness.root, 'sess-1', { clock: harness.clock });
    await restarted.init({ agent: 'claude', cwd: harness.root });
    await restarted.appendEvent({ type: 'progress', title: 'after the delete' });

    await harness.model.refresh();
    expect(harness.model.session('sess-1')?.events.map((event) => event.title)).toEqual(['after the delete']);
  });

  it('counts what a delete would destroy, and whether an agent is still pointed at it', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'first' });
    await store.appendEvent({ type: 'progress', title: 'second' });
    await harness.human().comment('careful with that');
    await store.writeArtifact('plan.md', '# plan');

    expect(await sessionFootprint(harness.root, 'sess-1')).toEqual({
      events: 2,
      comments: 1,
      artifacts: 1,
      current: false,
    });

    await claimCurrentSession(harness.root, 'claude', 'sess-1');
    expect((await sessionFootprint(harness.root, 'sess-1')).current).toBe(true);
  });
});
