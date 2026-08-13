#!/usr/bin/env node
import { runHook } from './hook.js';
import { readStdin } from './stdin.js';

/**
 * Entry point registered in `.claude/settings.json`:
 *
 *   agent-monitor-hook session-start | post-tool | stop | notify
 *
 * Deliberately depends on nothing but the protocol package. It runs after every tool
 * call, so its whole budget is ~100ms and each extra dependency is startup cost
 * (TESTS.md HOOK-09, HOOK-11).
 */
async function main(): Promise<void> {
  const [command = '', ...rest] = process.argv.slice(2);
  const stdin = await readStdin(process.stdin);

  const result = await runHook(command, {
    stdin,
    argv: rest,
    env: process.env,
    cwd: process.cwd(),
  });

  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);

  // Only after the agent has the text: see HookResult.commit.
  if (result.commit) await result.commit();
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(`agent-monitor: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 0;
});
