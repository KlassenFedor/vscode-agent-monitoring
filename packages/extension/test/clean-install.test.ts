import { execFileSync, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionStore } from '@agent-monitor/protocol';
import { FakeAgent, makeWorkspace, type TempWorkspace } from '@agent-monitor/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { setupWorkspace } from '../src/core/setup.js';

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(extensionDir, 'dist');
const mcpBundle = path.join(dist, 'mcp-server.cjs');
const hookBundle = path.join(dist, 'hook.cjs');

let workspace: TempWorkspace | undefined;
let agent: FakeAgent | undefined;

beforeAll(() => {
  if (!existsSync(mcpBundle) || !existsSync(hookBundle)) {
    execFileSync('node', ['scripts/bundle.mjs'], { cwd: extensionDir, stdio: 'inherit' });
  }
}, 180_000);

afterEach(async () => {
  await agent?.close();
  await workspace?.cleanup();
  agent = undefined;
  workspace = undefined;
});

function runShell(command: string, options: { cwd: string; stdin: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    // Exactly how Claude Code runs a hook: the configured string, through a shell.
    const child = spawn(command, { cwd: options.cwd, shell: true });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
    child.stdin.end(options.stdin);
  });
}

describe('E2E-09: a clean install', () => {
  it('produces configuration the agents can actually run', async () => {
    workspace = await makeWorkspace('agent-monitor-clean-');
    const root = workspace.root;

    const report = await setupWorkspace({
      root,
      node: process.execPath,
      mcpServer: mcpBundle,
      hook: hookBundle,
      codexConfig: path.join(root, 'codex-config.toml'),
    });
    expect(report.notes).toEqual([]);

    // 1. The MCP server, started exactly as .mcp.json describes it.
    const mcp = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers['agent-monitor'];
    expect(server).toBeDefined();

    agent = await FakeAgent.spawn({
      command: server?.command as string,
      args: server?.args as string[],
      cwd: root,
      env: { AGENT_MONITOR_SESSION_ID: 'sess-clean', AGENT_MONITOR_AGENT: 'claude' },
    });

    const published = await agent.tool('report_progress', { title: 'milestone from a clean install' });
    expect(published.isError).toBe(false);

    // 2. The human comments while the agent is busy.
    const store = SessionStore.open(root, 'sess-clean');
    await store.appendComment({ kind: 'steer', text: 'do not touch legacy/' });

    // 3. The hook, started exactly as .claude/settings.json describes it.
    const settings = JSON.parse(await fs.readFile(path.join(root, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const hookCommand = settings.hooks.PostToolUse?.[0]?.hooks[0]?.command;
    expect(hookCommand).toBeTruthy();

    const stdout = await runShell(hookCommand as string, {
      cwd: root,
      stdin: JSON.stringify({ session_id: 'sess-clean', cwd: root, hook_event_name: 'PostToolUse' }),
    });

    const injected = JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(injected.hookSpecificOutput.additionalContext).toContain('do not touch legacy/');
    expect((await store.readCursor()).inbox_seq).toBe(1);
  }, 120_000);
});
