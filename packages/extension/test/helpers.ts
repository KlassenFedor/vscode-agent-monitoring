import { createManualClock, SessionStore, type ManualClock } from '@agent-monitor/protocol';
import { FakeHuman, makeWorkspace } from '@agent-monitor/testkit';
import { afterEach } from 'vitest';

import { WorkspaceModel } from '../src/core/model.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

export interface ExtHarness {
  root: string;
  model: WorkspaceModel;
  clock: ManualClock;
  /** Open a store for a session id, creating its metadata. */
  agent(sessionId?: string): Promise<SessionStore>;
  human(sessionId?: string): FakeHuman;
}

export async function makeExtHarness(options: { staleAfterMs?: number } = {}): Promise<ExtHarness> {
  const workspace = await makeWorkspace('agent-monitor-ext-');
  cleanups.push(workspace.cleanup);

  const clock = createManualClock('2026-08-13T10:00:00.000Z', { tickMs: 1000 });
  const model = new WorkspaceModel(workspace.root, {
    clock,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
  });

  return {
    root: workspace.root,
    model,
    clock,
    async agent(sessionId = 'sess-1') {
      const store = SessionStore.open(workspace.root, sessionId, { clock });
      await store.init({ agent: 'claude', cwd: workspace.root });
      return store;
    },
    human(sessionId = 'sess-1') {
      return new FakeHuman(workspace.root, sessionId);
    },
  };
}

export function trackTemp(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}
