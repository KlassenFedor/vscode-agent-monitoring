/**
 * What the hook hands back to the agent.
 *
 * stdout carries protocol JSON and nothing else — a stray log line there is read as a
 * malformed hook response (TESTS.md HOOK-10) — so diagnostics go to stderr.
 */
export interface HookOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HookResult extends HookOutcome {
  /**
   * Marks the delivered comments as read.
   *
   * Separate from producing the output so the caller can commit only after stdout has
   * actually been written. Committing first would lose a comment for good if the
   * write failed; committing after can at worst repeat one (TESTS.md HOOK-06).
   */
  commit?: () => Promise<void>;
}

export const SILENT: HookOutcome = { stdout: '', stderr: '', exitCode: 0 };

/** Inject text into the agent's context without interrupting what it is doing. */
export function additionalContext(hookEventName: string, context: string): HookOutcome {
  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } }),
    stderr: '',
    exitCode: 0,
  };
}

/** Stop the agent's current line of work and make it read `reason` first. */
export function block(reason: string): HookOutcome {
  return {
    stdout: JSON.stringify({ decision: 'block', reason }),
    stderr: '',
    exitCode: 0,
  };
}

export function note(message: string): HookOutcome {
  return { stdout: '', stderr: `agent-monitor: ${message}\n`, exitCode: 0 };
}
