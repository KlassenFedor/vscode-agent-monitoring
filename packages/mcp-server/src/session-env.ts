import { randomBytes } from 'node:crypto';

import { isSafeSessionId, type AgentKind } from '@agent-monitor/protocol';

export interface SessionContext {
  /** Workspace root that owns `.agent-monitor/`. */
  root: string;
  sessionId: string;
  agent: AgentKind;
  cwd: string;
  /** True when no agent-provided id was usable and one was invented. */
  generated: boolean;
}

/**
 * Work out which session this server process belongs to.
 *
 * The server is started by the agent, so its working directory is the workspace and
 * its environment is the agent's. Neither Claude Code nor Codex guarantees a session
 * id in the environment, so a generated id is the normal case rather than an error
 * path: it stays stable for the lifetime of the process, which is the lifetime of
 * the agent session.
 */
export function resolveSessionContext(env: NodeJS.ProcessEnv, cwd: string): SessionContext {
  // Claude Code starts the server in the workspace and also names it outright; the
  // explicit variable is preferred because a server started elsewhere would otherwise
  // create a second, empty `.agent-monitor/` where nobody is looking.
  const root = env.AGENT_MONITOR_ROOT?.trim() || env.CLAUDE_PROJECT_DIR?.trim() || cwd;
  const agent = detectAgent(env);

  // Measured against Claude Code 2.1.229: `CLAUDE_CODE_SESSION_ID` is the one that is
  // actually set, and it matches the id the hook receives on stdin, which is what puts
  // both channels in the same session directory. `CLAUDE_SESSION_ID` has never been
  // observed; it stays in the list because reading a variable that is absent costs
  // nothing and the naming has changed before.
  const candidates = [
    env.AGENT_MONITOR_SESSION_ID,
    env.CLAUDE_CODE_SESSION_ID,
    env.CLAUDE_SESSION_ID,
    env.CODEX_SESSION_ID,
    env.CODEX_THREAD_ID,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    // An unusable id is ignored rather than fatal: refusing to start would cost the
    // agent its whole reporting channel over a cosmetic problem.
    if (value && isSafeSessionId(value)) {
      return { root, sessionId: value, agent, cwd, generated: false };
    }
  }

  return { root, sessionId: generateSessionId(agent), agent, cwd, generated: true };
}

export function detectAgent(env: NodeJS.ProcessEnv): AgentKind {
  const declared = env.AGENT_MONITOR_AGENT?.trim().toLowerCase();
  if (declared === 'claude' || declared === 'codex' || declared === 'other') return declared;

  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_SESSION_ID) return 'claude';
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_SESSION_ID || env.CODEX_THREAD_ID) return 'codex';
  return 'other';
}

/** `claude-20260813T142011-3f9a2b`, chosen to satisfy the session id character rules. */
export function generateSessionId(agent: AgentKind, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
  return `${agent}-${stamp}-${randomBytes(3).toString('hex')}`;
}
