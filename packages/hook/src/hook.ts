import { notify, postTool, sessionStart, stop } from './commands.js';
import type { HookIo } from './context.js';
import { SILENT, type HookResult } from './output.js';

export const COMMANDS = {
  'session-start': sessionStart,
  'post-tool': postTool,
  stop,
  notify,
} as const;

export type CommandName = keyof typeof COMMANDS;

/** `drain` is the name the design document uses for the post-tool command. */
const ALIASES: Record<string, CommandName> = { drain: 'post-tool', 'post-tool-use': 'post-tool' };

export function isCommandName(value: string): value is CommandName {
  return value in COMMANDS || value in ALIASES;
}

/**
 * Run one hook invocation.
 *
 * Any failure inside a command is swallowed into a stderr note with exit code 0: the
 * hook runs on the agent's critical path, and a monitoring tool that can break the
 * agent's session is worse than no monitoring at all (TESTS.md HOOK-07).
 */
export async function runHook(command: string, io: HookIo): Promise<HookResult> {
  const name = (ALIASES[command] ?? command) as CommandName;
  const handler = COMMANDS[name];
  if (!handler) {
    return {
      stdout: '',
      stderr: `agent-monitor: unknown command ${JSON.stringify(command)}; expected one of ${Object.keys(COMMANDS).join(', ')}\n`,
      exitCode: 1,
    };
  }

  try {
    return await handler(io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...SILENT, stderr: `agent-monitor: ${name} failed: ${message}\n` };
  }
}
