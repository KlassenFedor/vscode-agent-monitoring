import { describe, expect, it } from 'vitest';

import { makeExtHarness } from './helpers.js';

describe('WorkspaceModel', () => {
  it('EXT-02: picks up sessions that already exist on disk', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'written before the extension started' });

    const snapshot = await harness.model.refresh();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]?.events.map((event) => event.title)).toEqual([
      'written before the extension started',
    ]);
  });

  it('EXT-01: a new event shows up on the next refresh', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await harness.model.refresh();

    await store.appendEvent({ type: 'progress', title: 'second milestone' });
    const snapshot = await harness.model.refresh();

    expect(snapshot.sessions[0]?.events.map((event) => event.title)).toEqual(['second milestone']);
  });

  it('EXT-14: repeated refreshes neither duplicate nor lose events', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'one' });
    await store.appendEvent({ type: 'progress', title: 'two' });

    await harness.model.refresh();
    await harness.model.refresh();
    const snapshot = await harness.model.refresh();

    expect(snapshot.sessions[0]?.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('EXT-04: counts comments the agent has not been given yet', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    const human = harness.human();
    await human.comment('one');
    await human.comment('two');

    let snapshot = await harness.model.refresh();
    expect(snapshot.unreadTotal).toBe(2);

    await store.commitCursor(2);
    snapshot = await harness.model.refresh();
    expect(snapshot.unreadTotal).toBe(0);
    expect(snapshot.sessions[0]?.cursorSeq).toBe(2);
  });

  it('EXT-03: writes a comment the agent can read', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await harness.model.refresh();

    await harness.model.postComment('sess-1', { text: 'do not touch legacy/', kind: 'steer', replyTo: 3 });

    const [comment] = await store.listComments();
    expect(comment).toMatchObject({ kind: 'steer', text: 'do not touch legacy/', reply_to: 3 });
    expect(await store.unreadComments()).toHaveLength(1);
  });

  it('reports a question the agent is blocked on, and clears it once answered', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    await store.appendEvent({ type: 'question', title: 'Postgres or SQLite?', needs_answer: true });
    await store.patchMeta({ status: 'blocked' });

    let snapshot = await harness.model.refresh();
    expect(snapshot.waitingCount).toBe(1);
    expect(snapshot.sessions[0]?.waitingQuestion?.title).toBe('Postgres or SQLite?');

    await store.patchMeta({ status: 'working' });
    snapshot = await harness.model.refresh();
    expect(snapshot.waitingCount).toBe(0);
  });

  it('marks a session stale once it goes quiet', async () => {
    const harness = await makeExtHarness({ staleAfterMs: 60_000 });
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'last sign of life' });

    expect((await harness.model.refresh()).sessions[0]?.stale).toBe(false);

    harness.clock.advance(120_000);
    expect((await harness.model.refresh()).sessions[0]?.stale).toBe(true);
  });

  it('never calls a finished session stale', async () => {
    const harness = await makeExtHarness({ staleAfterMs: 60_000 });
    const store = await harness.agent();
    await store.appendEvent({ type: 'progress', title: 'done here' });
    await store.patchMeta({ status: 'done' });

    harness.clock.advance(120_000);

    expect((await harness.model.refresh()).sessions[0]?.stale).toBe(false);
  });

  it('E2E-07: keeps two sessions of one workspace apart, needy ones first', async () => {
    const harness = await makeExtHarness();
    const quiet = await harness.agent('quiet');
    await harness.agent('needy');
    await quiet.appendEvent({ type: 'progress', title: 'ticking along' });
    await harness.human('needy').comment('look at this');

    const snapshot = await harness.model.refresh();

    expect(snapshot.sessions.map((session) => session.id)).toEqual(['needy', 'quiet']);
    expect(snapshot.sessions[0]?.unread).toHaveLength(1);
    expect(snapshot.sessions[1]?.unread).toHaveLength(0);
  });

  it('forgets a session whose directory was deleted', async () => {
    const harness = await makeExtHarness();
    await harness.agent();
    await harness.model.refresh();

    const { promises: fs } = await import('node:fs');
    await fs.rm(`${harness.root}/.agent-monitor/sessions/sess-1`, { recursive: true, force: true });

    expect((await harness.model.refresh()).sessions).toEqual([]);
  });

  it('EXT-07: stays quick with a thousand events across refreshes', async () => {
    const harness = await makeExtHarness();
    const store = await harness.agent();
    for (let index = 0; index < 1000; index += 1) {
      await store.appendEvent({ type: 'progress', title: `milestone ${index}` });
    }

    const firstStarted = performance.now();
    const snapshot = await harness.model.refresh();
    const firstElapsed = performance.now() - firstStarted;

    const incrementalStarted = performance.now();
    await harness.model.refresh();
    const incrementalElapsed = performance.now() - incrementalStarted;

    expect(snapshot.sessions[0]?.events).toHaveLength(1000);
    expect(firstElapsed).toBeLessThan(1000);
    // Nothing changed, so the second pass must not re-read the file.
    expect(incrementalElapsed).toBeLessThan(50);
  }, 120_000);
});
