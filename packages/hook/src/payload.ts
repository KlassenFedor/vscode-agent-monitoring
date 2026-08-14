/**
 * The JSON an agent pipes into a hook on stdin.
 *
 * Claude Code sends `session_id`, `cwd`, `hook_event_name` and event-specific fields.
 * Everything is optional here on purpose: the hook must survive an agent that changed
 * its payload shape, and a missing field only costs a fallback (TESTS.md HOOK-08).
 */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  /** Stop event only: true when this stop was already blocked by a Stop hook. */
  stop_hook_active?: boolean;
  /** Stop event only: the last thing the agent said, which makes a decent title. */
  last_assistant_message?: string;
  [key: string]: unknown;
}

/** Never throws: unparsable input is simply an empty payload. */
export function parsePayload(stdin: string): HookPayload {
  const text = stdin.trim();
  if (text === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const raw = parsed as Record<string, unknown>;
  const payload: HookPayload = { ...raw };
  for (const field of ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'tool_name'] as const) {
    payload[field] = typeof raw[field] === 'string' ? (raw[field] as string) : undefined;
  }
  return payload;
}
