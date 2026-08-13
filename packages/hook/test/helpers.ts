import { createManualClock, SessionStore, type ManualClock } from '@agent-monitor/protocol';
import { FakeHuman, makeWorkspace } from '@agent-monitor/testkit';
import { afterEach } from 'vitest';

import { runHook } from '../src/hook.js';
import type { HookIo } from '../src/context.js';
import type { HookResult } from '../src/output.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

export interface HookHarness {
  root: string;
  sessionId: string;
  store: SessionStore;
  human: FakeHuman;
  clock: ManualClock;
  /** Move the shared clock forward; debouncing is measured against it. */
  advance(ms: number): void;
  /** Run a command the way the CLI does: emit first, then commit. */
  run(command: string, options?: RunOptions): Promise<HookResult>;
  /** Run a command but skip the commit, as if the process died after writing. */
  runWithoutCommit(command: string, options?: RunOptions): Promise<HookResult>;
}

export interface RunOptions {
  payload?: Record<string, unknown> | string;
  env?: Record<string, string>;
  argv?: string[];
}

export async function makeHookHarness(
  options: { sessionId?: string; createSession?: boolean } = {},
): Promise<HookHarness> {
  const workspace = await makeWorkspace('agent-monitor-hook-');
  cleanups.push(workspace.cleanup);

  const sessionId = options.sessionId ?? 'sess-1';
  const clock = createManualClock('2026-08-13T10:00:00.000Z', { tickMs: 1 });

  const store = SessionStore.open(workspace.root, sessionId, { clock });
  if (options.createSession !== false) {
    await store.init({ agent: 'claude', cwd: workspace.root });
  }

  const io = (runOptions: RunOptions): HookIo => ({
    stdin:
      typeof runOptions.payload === 'string'
        ? runOptions.payload
        : JSON.stringify({ session_id: sessionId, cwd: workspace.root, ...runOptions.payload }),
    argv: runOptions.argv ?? [],
    env: { ...runOptions.env },
    cwd: workspace.root,
    clock,
  });

  return {
    root: workspace.root,
    sessionId,
    store,
    human: new FakeHuman(workspace.root, sessionId),
    clock,
    advance(ms: number) {
      clock.advance(ms);
    },
    async run(command, runOptions = {}) {
      const result = await runHook(command, io(runOptions));
      if (result.commit) await result.commit();
      return result;
    },
    runWithoutCommit(command, runOptions = {}) {
      return runHook(command, io(runOptions));
    },
  };
}

/** Parse the JSON a hook wrote to stdout, failing loudly if it wrote anything else. */
export function parseStdout(result: HookResult): Record<string, unknown> {
  expectJson(result.stdout);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function expectJson(text: string): void {
  if (text.trim() === '') throw new Error('expected JSON on stdout, got nothing');
  JSON.parse(text);
}
