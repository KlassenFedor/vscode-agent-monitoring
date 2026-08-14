import { execFileSync, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionStore } from '@agent-monitor/protocol';
import { bestOf, makeWorkspace, type TempWorkspace } from '@agent-monitor/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runHook } from '../src/hook.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const hookPackage = path.join(repoRoot, 'packages', 'hook');
const cli = path.join(hookPackage, 'dist', 'cli.js');

let workspace: TempWorkspace | undefined;

beforeAll(() => {
  if (!existsSync(cli)) {
    // npx is a shell script on POSIX and a .cmd on Windows; execFileSync needs the
    // exact name because it does not go through a shell.
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-b', 'packages/hook'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
}, 120_000);

afterEach(async () => {
  await workspace?.cleanup();
  workspace = undefined;
});

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], options: { cwd: string; stdin: string }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: options.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(options.stdin);
  });
}

describe('hook as a real process', () => {
  it('HOOK-10: writes protocol JSON to stdout and nothing else', async () => {
    workspace = await makeWorkspace('agent-monitor-hook-');
    const store = SessionStore.open(workspace.root, 'sess-1');
    await store.init({ agent: 'claude', cwd: workspace.root });
    await store.appendComment({ kind: 'steer', text: 'do not touch legacy/' });

    const result = await runCli(['post-tool'], {
      cwd: workspace.root,
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: workspace.root, hook_event_name: 'PostToolUse' }),
    });

    expect(result.code).toBe(0);
    // Exactly one JSON document, no banner, no trailing log line.
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain('do not touch legacy/');
    expect((await store.readCursor()).inbox_seq).toBe(1);
  });

  it('HOOK-02: prints nothing at all when there is nothing to say', async () => {
    workspace = await makeWorkspace('agent-monitor-hook-');
    const store = SessionStore.open(workspace.root, 'sess-1');
    await store.init({ agent: 'claude', cwd: workspace.root });

    const result = await runCli(['post-tool'], {
      cwd: workspace.root,
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: workspace.root }),
    });

    expect(result).toMatchObject({ stdout: '', code: 0 });
  });

  it('HOOK-08: survives being handed nothing on stdin', async () => {
    workspace = await makeWorkspace('agent-monitor-hook-');

    const result = await runCli(['post-tool'], { cwd: workspace.root, stdin: '' });

    expect(result).toMatchObject({ stdout: '', code: 0 });
  });

  it('E2E-02: a comment reaches the agent through the hook alone', async () => {
    workspace = await makeWorkspace('agent-monitor-hook-');

    // The agent starts; the hook registers the session under the agent's own id.
    await runCli(['session-start'], {
      cwd: workspace.root,
      stdin: JSON.stringify({ session_id: 'claude-abc', cwd: workspace.root }),
    });

    // The human comments while the agent is busy, using the extension's write path.
    const store = SessionStore.open(workspace.root, 'claude-abc');
    await store.appendComment({ kind: 'steer', text: 'skip the CLI for now' });

    // The agent calls no monitoring tool at all; the next tool use carries the comment.
    const result = await runCli(['post-tool'], {
      cwd: workspace.root,
      stdin: JSON.stringify({ session_id: 'claude-abc', cwd: workspace.root }),
    });

    expect(result.stdout).toContain('skip the CLI for now');
    expect((await store.readCursor()).inbox_seq).toBe(1);
  });
});

describe('hook budgets', () => {
  it('HOOK-09: stays well under 100ms with a thousand comments queued', async () => {
    workspace = await makeWorkspace('agent-monitor-hook-');
    const store = SessionStore.open(workspace.root, 'sess-1');
    await store.init({ agent: 'claude', cwd: workspace.root });
    for (let index = 0; index < 1000; index += 1) {
      await store.appendComment({ kind: 'fyi', text: `comment ${index}` });
    }
    await store.commitCursor(999);

    const io = {
      stdin: JSON.stringify({ session_id: 'sess-1', cwd: workspace.root }),
      argv: [],
      env: {},
      cwd: workspace.root,
    };
    await runHook('post-tool', io);

    // Best of three: the hook runs on the agent's critical path, so what matters is
    // its own cost, not how busy the test machine happens to be.
    const elapsed = await bestOf(3, async () => {
      const result = await runHook('post-tool', io);
      await result.commit?.();
    });

    expect(elapsed).toBeLessThan(100);
  }, 60_000);

  it('HOOK-11: depends on nothing but the protocol package', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(hookPackage, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@agent-monitor/protocol']);

    // The MCP SDK costs ~370ms to import, which alone would blow the 100ms budget.
    for (const file of await fs.readdir(path.join(hookPackage, 'dist'))) {
      if (!file.endsWith('.js')) continue;
      const source = await fs.readFile(path.join(hookPackage, 'dist', file), 'utf8');
      expect(source, file).not.toContain('@modelcontextprotocol');
    }
  });
});
