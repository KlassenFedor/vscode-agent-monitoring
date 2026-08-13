import { createManualClock, SessionStore, type ManualClock } from '@agent-monitor/protocol';
import { FakeHuman, makeWorkspace } from '@agent-monitor/testkit';
import { afterEach } from 'vitest';

import { MonitorRuntime, type RuntimeOptions } from '../src/runtime.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

export interface Harness {
  root: string;
  sessionId: string;
  runtime: MonitorRuntime;
  human: FakeHuman;
  store: SessionStore;
  clock: ManualClock;
  /** Controllable stand-in for wall-clock time used by throttling and deadlines. */
  setNow(ms: number): void;
}

export async function makeHarness(options: Partial<RuntimeOptions> = {}): Promise<Harness> {
  const workspace = await makeWorkspace('agent-monitor-mcp-');
  cleanups.push(workspace.cleanup);

  // A second harness can be pointed at the first one's workspace to test two agents
  // sharing a project.
  const root = options.root ?? workspace.root;
  const sessionId = options.sessionId ?? 'sess-1';
  const clock = createManualClock('2026-08-13T10:00:00.000Z', { tickMs: 1 });
  let now = 1_000_000;

  const runtime = new MonitorRuntime({
    agent: 'claude',
    ...options,
    root,
    sessionId,
    cwd: options.cwd ?? root,
    clock,
    nowMs: () => now,
    askPollIntervalMs: 500,
    // Virtual time moves by the full requested amount while real time barely moves,
    // so deadline behaviour is exercised without the suite sitting in a sleep.
    sleep: (ms: number) => {
      now += ms;
      return new Promise((resolve) => setTimeout(resolve, 1));
    },
  });

  return {
    root,
    sessionId,
    runtime,
    human: new FakeHuman(root, sessionId),
    store: SessionStore.open(root, sessionId),
    clock,
    setNow(ms: number) {
      now = ms;
    },
  };
}
