import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManualClock, eventsPath, SessionStore } from '@agent-monitor/protocol';
import { bestOf, FakeHuman, makeWorkspace, type TempWorkspace } from '@agent-monitor/testkit';
import { MonitorRuntime } from '@agent-monitor/mcp-server';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceModel } from '../../extension/src/core/model.js';

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workers', 'busy-agent.ts');

let workspace: TempWorkspace | undefined;

afterEach(async () => {
  await workspace?.cleanup();
  workspace = undefined;
});

async function makeRoot(): Promise<string> {
  workspace = await makeWorkspace('agent-monitor-e2e-');
  return workspace.root;
}

function runtimeFor(root: string, sessionId = 'sess-1'): MonitorRuntime {
  return new MonitorRuntime({
    root,
    sessionId,
    agent: 'claude',
    cwd: root,
    clock: createManualClock('2026-08-13T10:00:00.000Z', { tickMs: 1 }),
    askPollIntervalMs: 20,
    minReportIntervalMs: 0,
  });
}

describe('E2E-03: question and answer', () => {
  it('the human answers from the panel and the agent carries on', async () => {
    const root = await makeRoot();
    const runtime = runtimeFor(root);
    const model = new WorkspaceModel(root);

    // The agent hits a fork in the road and blocks.
    const pending = runtime.askUser({ question: 'Postgres or SQLite?', options: ['postgres', 'sqlite'] });

    // The extension notices the question and shows it as waiting.
    let snapshot = await model.refresh();
    while (snapshot.waitingCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      snapshot = await model.refresh();
    }
    expect(snapshot.sessions[0]?.waitingQuestion?.title).toBe('Postgres or SQLite?');

    // The human clicks one of the agent's own options.
    const question = snapshot.sessions[0]?.waitingQuestion;
    await model.postComment('sess-1', { text: 'postgres', kind: 'answer', replyTo: question?.seq ?? 1 });

    const answer = await pending;
    expect(answer.text).toContain('postgres');

    snapshot = await model.refresh();
    expect(snapshot.waitingCount).toBe(0);
    expect(snapshot.sessions[0]?.status).toBe('working');
    expect(snapshot.sessions[0]?.unread).toEqual([]);
  });
});

describe('E2E-05: the agent is killed mid-write', () => {
  it('loses nothing that was already published and keeps working afterwards', async () => {
    const root = await makeRoot();

    // Kill the agent while it is in the middle of appending.
    const child = spawn(process.execPath, ['--import', 'tsx', worker, root, 'sess-1', '2000'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const published = await new Promise<number>((resolve) => {
      let last = -1;
      child.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf8').trim().split('\n');
        last = Number.parseInt(lines.at(-1) ?? '-1', 10);
        if (last >= 20) {
          child.kill('SIGKILL');
          resolve(last);
        }
      });
    });
    await new Promise((resolve) => child.once('exit', resolve));

    const store = SessionStore.open(root, 'sess-1');
    const survived = await store.listEvents();

    // Everything the agent got an acknowledgement for is still readable.
    expect(survived.length).toBeGreaterThanOrEqual(published);
    expect(survived.map((event) => event.seq)).toEqual(survived.map((_, index) => index + 1));

    // And a restarted agent continues the same session rather than corrupting it.
    const resumed = await store.appendEvent({ type: 'progress', title: 'back after the crash' });
    expect(resumed.seq).toBeGreaterThan(survived.length);

    const after = await store.listEvents();
    expect(after.at(-1)?.title).toBe('back after the crash');
    expect(after.length).toBeGreaterThan(survived.length);
  }, 60_000);

  it('recovers from a half-written last line', async () => {
    const root = await makeRoot();
    const store = SessionStore.open(root, 'sess-1');
    await store.init({ agent: 'claude', cwd: root });
    await store.appendEvent({ type: 'progress', title: 'before the crash' });

    // Exactly what a SIGKILL between two write syscalls leaves behind.
    await fs.appendFile(eventsPath(root, 'sess-1'), '{"seq":2,"ts":"2026-08-13T10:0', 'utf8');

    const resumed = await store.appendEvent({ type: 'progress', title: 'after the crash' });
    const events = await store.listEvents();

    expect(events.map((event) => event.title)).toEqual(['before the crash', 'after the crash']);
    expect(resumed.seq).toBe(3);
  });
});

describe('E2E-06: the extension restarts', () => {
  it('rebuilds the timeline and the unread count from disk', async () => {
    const root = await makeRoot();
    const runtime = runtimeFor(root);
    const human = new FakeHuman(root, 'sess-1');

    await runtime.reportProgress({ title: 'first milestone' });
    await runtime.reportProgress({ title: 'second milestone' });
    await human.comment('delivered later');

    const before = await new WorkspaceModel(root).refresh();

    // A new model is what the extension host has after a reload: no memory at all.
    const after = await new WorkspaceModel(root).refresh();

    expect(after.sessions[0]?.events.map((event) => event.title)).toEqual([
      'first milestone',
      'second milestone',
    ]);
    expect(after.unreadTotal).toBe(1);
    expect(after.sessions[0]?.events).toEqual(before.sessions[0]?.events);
  });

  it('counts as unread only what the agent has not been given', async () => {
    const root = await makeRoot();
    const runtime = runtimeFor(root);
    const human = new FakeHuman(root, 'sess-1');

    await human.comment('delivered');
    await runtime.reportProgress({ title: 'picks the comment up' });
    await human.comment('still waiting');

    const snapshot = await new WorkspaceModel(root).refresh();

    expect(snapshot.unreadTotal).toBe(1);
    expect(snapshot.sessions[0]?.unread[0]?.text).toBe('still waiting');
  });
});

describe('E2E-08: a long session', () => {
  it('keeps 500 reports and 100 comments intact and quick to read', async () => {
    const root = await makeRoot();
    const runtime = runtimeFor(root);
    const human = new FakeHuman(root, 'sess-1');

    for (let index = 0; index < 500; index += 1) {
      await runtime.reportProgress({ title: `milestone ${index}`, phase: 'the long haul' });
      if (index % 5 === 0) await human.comment(`comment ${index / 5}`, 'fyi');
    }

    const model = new WorkspaceModel(root);
    const started = performance.now();
    const snapshot = await model.refresh();
    const firstRead = performance.now() - started;

    const incremental = await bestOf(3, () => model.refresh().then(() => undefined));

    const session = snapshot.sessions[0];
    expect(session?.events).toHaveLength(500);
    expect(session?.comments).toHaveLength(100);
    expect(session?.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 500 }, (_, index) => index + 1),
    );
    // Comments are delivered as the agent reports, so by the end nothing is pending.
    expect(session?.unread).toEqual([]);

    expect(firstRead).toBeLessThan(1000);
    expect(incremental).toBeLessThan(50);
  }, 180_000);
});
