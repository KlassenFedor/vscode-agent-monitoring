import * as os from 'node:os';

import { readCurrentSession, SessionStore } from '@agent-monitor/protocol';
import { makeWorkspace } from '@agent-monitor/testkit';
import { describe, expect, it } from 'vitest';

import { runHook } from '../src/hook.js';
import { makeHookHarness, parseStdout } from './helpers.js';

describe('session-start', () => {
  it('HOOK-01: creates the session, says nothing on stdout, exits 0', async () => {
    const harness = await makeHookHarness({ createSession: false });

    const result = await harness.run('session-start');

    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
    expect(await harness.store.readMeta()).toMatchObject({ id: 'sess-1', agent: 'claude' });
  });

  it("registers the agent's own session id as authoritative for the workspace", async () => {
    const harness = await makeHookHarness({ createSession: false });

    await harness.run('session-start');

    expect(await readCurrentSession(harness.root, 'claude')).toMatchObject({
      session_id: 'sess-1',
      authoritative: true,
    });
  });

  it('still starts a session when the agent sends no id', async () => {
    const workspace = await makeWorkspace('agent-monitor-hook-');
    try {
      const result = await runHook('session-start', {
        stdin: JSON.stringify({ cwd: workspace.root }),
        argv: [],
        env: {},
        cwd: workspace.root,
      });

      expect(result.exitCode).toBe(0);
      const pointer = await readCurrentSession(workspace.root, 'claude');
      expect(pointer?.authoritative).toBe(false);
      expect(pointer?.session_id).toMatch(/^claude-hook-/);
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('post-tool', () => {
  it('HOOK-02: stays silent when there is nothing new', async () => {
    const harness = await makeHookHarness();

    const result = await harness.run('post-tool');

    expect(result).toMatchObject({ stdout: '', exitCode: 0 });
  });

  it('HOOK-03: injects new comments as additional context', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('do not touch legacy/');

    const result = await harness.run('post-tool');
    const output = parseStdout(result) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };

    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('[steer] do not touch legacy/');
    expect(output.hookSpecificOutput.additionalContext).toContain('overrides the earlier plan');
    expect(result.exitCode).toBe(0);
  });

  it('HOOK-03: reflects the hook event the agent actually fired', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('note this');

    const result = await harness.run('post-tool', { payload: { hook_event_name: 'UserPromptSubmit' } });

    const output = parseStdout(result) as { hookSpecificOutput: { hookEventName: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  });

  it('HOOK-04: a stop comment blocks instead of being mentioned in passing', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('by the way, CI is red', 'fyi');
    await harness.human.stop('hold on, I am rewriting the ticket');

    const result = await harness.run('post-tool');
    const output = parseStdout(result) as { decision: string; reason: string };

    expect(output.decision).toBe('block');
    expect(output.reason).toContain('hold on, I am rewriting the ticket');
    expect(output.reason).toContain('stop and wait');
    expect(result.stdout).not.toContain('additionalContext');
  });

  it('HOOK-04: comments after a stop wait for the next invocation', async () => {
    const harness = await makeHookHarness({});
    await harness.human.stop();
    await harness.human.comment('and here is why', 'fyi');

    await harness.run('post-tool', { env: { AGENT_MONITOR_DEBOUNCE_MS: '0' } });

    expect((await harness.store.readCursor()).inbox_seq).toBe(1);
    expect((await harness.store.unreadComments()).map((c) => c.text)).toEqual(['and here is why']);
  });

  it('HOOK-05: a second call inside the debounce window stays silent', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('first');

    const first = await harness.run('post-tool', { env: { AGENT_MONITOR_DEBOUNCE_MS: '5000' } });
    expect(first.stdout).not.toBe('');

    await harness.human.comment('second');
    harness.advance(2_000);
    const debounced = await harness.run('post-tool', { env: { AGENT_MONITOR_DEBOUNCE_MS: '5000' } });

    expect(debounced.stdout).toBe('');
    // Held back, not thrown away.
    expect((await harness.store.unreadComments()).map((c) => c.text)).toEqual(['second']);
  });

  it('HOOK-05: the held-back comment arrives once the window has passed', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('first');
    await harness.run('post-tool', { env: { AGENT_MONITOR_DEBOUNCE_MS: '5000' } });

    await harness.human.comment('second');
    harness.advance(10_000);
    const result = await harness.run('post-tool', { env: { AGENT_MONITOR_DEBOUNCE_MS: '5000' } });

    expect(result.stdout).toContain('second');
  });

  it('HOOK-06: the cursor moves only when the comment really reached stdout', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('do not touch legacy/');

    const uncommitted = await harness.runWithoutCommit('post-tool');
    expect(uncommitted.stdout).toContain('legacy/');
    expect((await harness.store.readCursor()).inbox_seq).toBe(0);

    await uncommitted.commit?.();
    expect((await harness.store.readCursor()).inbox_seq).toBe(1);
    expect(await harness.store.unreadComments()).toEqual([]);
  });

  it('HOOK-06: a silent run never touches the cursor', async () => {
    const harness = await makeHookHarness();

    const result = await harness.run('post-tool');

    expect(result.commit).toBeUndefined();
    expect((await harness.store.readCursor()).inbox_seq).toBe(0);
  });

  it('HOOK-07: a workspace that was never monitored produces nothing', async () => {
    const workspace = await makeWorkspace('agent-monitor-hook-');
    try {
      const result = await runHook('post-tool', {
        stdin: JSON.stringify({ session_id: 'sess-1', cwd: workspace.root }),
        argv: [],
        env: {},
        cwd: workspace.root,
      });

      expect(result).toMatchObject({ stdout: '', exitCode: 0 });
    } finally {
      await workspace.cleanup();
    }
  });

  it('HOOK-08: garbage on stdin is not fatal', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('still delivered');

    for (const payload of ['', 'not json at all', '[]', 'null', '{"session_id": 42}']) {
      const result = await harness.runWithoutCommit('post-tool', { payload });
      expect(result.exitCode, payload).toBe(0);
    }

    // With no usable session id in the payload, the hook falls back to the workspace's
    // only session rather than giving up.
    const result = await harness.run('post-tool', { payload: 'not json at all' });
    expect(result.stdout).toContain('still delivered');
  });

  it('finds the session even when the agent reports an id nothing has written under', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('deliver me');

    const result = await harness.run('post-tool', { payload: { session_id: 'some-other-id' } });

    expect(result.stdout).toContain('deliver me');
  });
});

describe('stop', () => {
  it('blocks the end of the turn when a comment is still unread', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('one more thing before you finish');

    const result = await harness.run('stop');
    const output = parseStdout(result) as { decision: string; reason: string };

    expect(output.decision).toBe('block');
    expect(output.reason).toContain('one more thing before you finish');
    expect((await harness.store.readCursor()).inbox_seq).toBe(1);
  });

  it('marks a finished turn as waiting for review', async () => {
    const harness = await makeHookHarness();

    const result = await harness.run('stop');

    expect(result.stdout).toBe('');
    expect((await harness.store.readMeta())?.status).toBe('waiting_review');
  });

  it('leaves a session the agent already marked done alone', async () => {
    const harness = await makeHookHarness();
    await harness.store.patchMeta({ status: 'done' });

    await harness.run('stop');

    expect((await harness.store.readMeta())?.status).toBe('done');
  });

  it('HOOK-12: never blocks a stop that a Stop hook already blocked', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('this must not trap the agent');

    // The agent reached Stop, was blocked, kept working and came back. Blocking again
    // on the same unread comment is a session that can never end.
    const result = await harness.run('stop', { payload: { stop_hook_active: true } });

    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('HOOK-12: the comment survives for the next turn rather than being swallowed', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('still unread');

    await harness.run('stop', { payload: { stop_hook_active: true } });

    expect((await harness.store.readCursor()).inbox_seq).toBe(0);
    expect(await harness.store.unreadComments()).toHaveLength(1);
  });
});

describe('workspace resolution', () => {
  it('falls back to CLAUDE_PROJECT_DIR when the payload says nothing', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('found through the project directory');

    // Empty stdin and a working directory that is not the workspace: this is the shape
    // an invocation takes when the agent has changed directory mid-session.
    const result = await runHook('post-tool', {
      stdin: '',
      argv: [],
      env: { CLAUDE_PROJECT_DIR: harness.root },
      cwd: os.tmpdir(),
    });

    expect(result.stdout).toContain('found through the project directory');
  });

  it('lets the payload outrank CLAUDE_PROJECT_DIR', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('the payload knows better');

    const result = await runHook('post-tool', {
      stdin: JSON.stringify({ session_id: harness.sessionId, cwd: harness.root }),
      argv: [],
      env: { CLAUDE_PROJECT_DIR: os.tmpdir() },
      cwd: os.tmpdir(),
    });

    expect(result.stdout).toContain('the payload knows better');
  });
});

describe('notify', () => {
  it('accepts Codex-style JSON passed as an argument', async () => {
    const harness = await makeHookHarness();

    const result = await harness.run('notify', {
      argv: [JSON.stringify({ type: 'agent-turn-complete', cwd: harness.root })],
      env: { AGENT_MONITOR_ROOT: harness.root },
    });

    expect(result.stdout).toBe('');
    expect((await harness.store.readMeta())?.status).toBe('waiting_review');
  });

  it('ignores notifications it has no opinion about', async () => {
    const harness = await makeHookHarness();

    await harness.run('notify', { argv: [JSON.stringify({ type: 'something-else' })] });

    expect((await harness.store.readMeta())?.status).toBe('working');
  });
});

describe('command routing', () => {
  it('accepts the drain alias from the design document', async () => {
    const harness = await makeHookHarness();
    await harness.human.comment('via the alias');

    const result = await harness.run('drain');

    expect(result.stdout).toContain('via the alias');
  });

  it('reports an unknown command on stderr without writing to stdout', async () => {
    const harness = await makeHookHarness();

    const result = await harness.run('teleport');

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown command');
    expect(result.exitCode).toBe(1);
  });

  it('HOOK-07: an internal failure degrades to silence, never to a broken agent', async () => {
    const harness = await makeHookHarness();
    // A directory where the session file should be makes every read fail.
    const store = SessionStore.open(harness.root, 'sess-1');
    void store;

    const result = await runHook('post-tool', {
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: harness.root }),
      argv: [],
      env: { AGENT_MONITOR_ROOT: '\0invalid' },
      cwd: harness.root,
    });

    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
