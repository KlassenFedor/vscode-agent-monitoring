import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionStore } from '@agent-monitor/protocol';
import { FakeAgent, makeWorkspace, type TempWorkspace } from '@agent-monitor/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'cli.js');

let workspace: TempWorkspace | undefined;
let agent: FakeAgent | undefined;

beforeAll(() => {
  // These tests exercise the published entry point, so they need the build output
  // rather than the sources the rest of the suite runs against.
  if (!existsSync(cli)) {
    execFileSync('npx', ['tsc', '-b', 'packages/mcp-server'], { cwd: repoRoot, stdio: 'inherit' });
  }
}, 120_000);

afterEach(async () => {
  await agent?.close();
  await workspace?.cleanup();
  agent = undefined;
  workspace = undefined;
});

describe('stdio entry point', () => {
  it('MCP-16: starts and completes the handshake well inside the budget', async () => {
    workspace = await makeWorkspace('agent-monitor-stdio-');

    const started = Date.now();
    agent = await FakeAgent.spawn({
      command: process.execPath,
      args: [cli],
      cwd: workspace.root,
      env: { AGENT_MONITOR_SESSION_ID: 'sess-stdio', AGENT_MONITOR_AGENT: 'claude' },
    });
    const elapsed = Date.now() - started;

    expect(await agent.listTools()).toHaveLength(5);
    // The agent waits on this every time it starts a session.
    expect(elapsed).toBeLessThan(1000);
  });

  it('writes the session into the workspace it was started in', async () => {
    workspace = await makeWorkspace('agent-monitor-stdio-');
    agent = await FakeAgent.spawn({
      command: process.execPath,
      args: [cli],
      cwd: workspace.root,
      env: { AGENT_MONITOR_SESSION_ID: 'sess-stdio', AGENT_MONITOR_AGENT: 'codex' },
    });

    const result = await agent.tool('report_progress', { title: 'milestone from a real process' });
    expect(result.isError).toBe(false);

    const store = SessionStore.open(workspace.root, 'sess-stdio');
    expect((await store.readMeta())?.agent).toBe('codex');
    expect((await store.listEvents())[0]?.title).toBe('milestone from a real process');
  });

  it('E2E-01: a comment written while the agent runs reaches its next report', async () => {
    workspace = await makeWorkspace('agent-monitor-stdio-');
    agent = await FakeAgent.spawn({
      command: process.execPath,
      args: [cli],
      cwd: workspace.root,
      env: { AGENT_MONITOR_SESSION_ID: 'sess-stdio' },
    });

    await agent.tool('report_progress', { title: 'first milestone' });

    const store = SessionStore.open(workspace.root, 'sess-stdio');
    await store.appendComment({ kind: 'steer', text: 'do not touch legacy/' });

    const second = await agent.tool('report_progress', { title: 'second milestone' });

    expect(second.text).toContain('[steer] do not touch legacy/');
    expect((await store.readCursor()).inbox_seq).toBe(1);
  });
});
