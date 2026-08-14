import { promises as fs } from 'node:fs';

import {
  AGENT_KINDS,
  claimCurrentSession,
  findLatestSession,
  isSafeSessionId,
  readCurrentSession,
  sessionDir,
  SessionStore,
  systemClock,
  type AgentKind,
  type Clock,
} from '@agent-monitor/protocol';

import type { HookPayload } from './payload.js';

export interface HookIo {
  stdin: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  clock?: Clock;
}

export interface HookContext {
  root: string;
  agent: AgentKind;
  sessionId: string | null;
  store: SessionStore | null;
  /**
   * The one time source in the hook. Debouncing compares against timestamps this
   * same clock wrote, so mixing in a second source would silently break it.
   */
  clock: Clock;
}

/**
 * Workspace the hook is running for: an explicit override, else what the agent reported.
 *
 * `CLAUDE_PROJECT_DIR` sits between the payload and the process directory because it is
 * the one value that still names the workspace when the hook is invoked with neither a
 * payload nor a useful working directory.
 */
export function resolveRoot(io: HookIo, payload: HookPayload): string {
  return (
    io.env.AGENT_MONITOR_ROOT?.trim() || payload.cwd?.trim() || io.env.CLAUDE_PROJECT_DIR?.trim() || io.cwd
  );
}

export function resolveAgent(io: HookIo): AgentKind {
  const declared = io.env.AGENT_MONITOR_AGENT?.trim().toLowerCase();
  if (AGENT_KINDS.includes(declared as AgentKind)) return declared as AgentKind;
  // The hook is wired into Claude Code's hook system; Codex reaches this code only
  // through `notify`, which passes the agent explicitly.
  return 'claude';
}

/**
 * Find the session this hook invocation belongs to, without creating one.
 *
 * Three sources, in descending order of evidence: the id the agent just handed us
 * (if a session directory for it exists), the workspace's current-session pointer,
 * and finally the most recently updated unfinished session. The fallbacks matter
 * because the MCP server may have started before the agent told anyone its real id,
 * in which case the session on disk is under a generated name.
 */
export async function resolveExistingSession(io: HookIo, payload: HookPayload): Promise<HookContext> {
  const root = resolveRoot(io, payload);
  const agent = resolveAgent(io);
  const clock = io.clock ?? systemClock;

  const hinted = payload.session_id?.trim();
  if (hinted && isSafeSessionId(hinted) && (await directoryExists(sessionDir(root, hinted)))) {
    return context(root, agent, hinted, clock);
  }

  const pointer = await readCurrentSession(root, agent);
  if (pointer && (await directoryExists(sessionDir(root, pointer.session_id)))) {
    return context(root, agent, pointer.session_id, clock);
  }

  const latest = await findLatestSession(root);
  if (latest) return context(root, agent, latest.id, clock);

  return { root, agent, sessionId: null, store: null, clock };
}

/**
 * Find or start the session, registering the agent's own id as the shared answer.
 *
 * Called from `session-start`, which is the one moment the hook knows the agent's
 * real session id before anything else has written to disk.
 */
export async function resolveOrCreateSession(io: HookIo, payload: HookPayload): Promise<HookContext> {
  const root = resolveRoot(io, payload);
  const agent = resolveAgent(io);
  const clock = io.clock ?? systemClock;

  const hinted = payload.session_id?.trim();
  const authoritative = Boolean(hinted && isSafeSessionId(hinted));
  const proposed = authoritative ? (hinted as string) : `${agent}-hook-${Date.now().toString(36)}`;

  const claim = await claimCurrentSession(root, agent, proposed, { authoritative, clock });
  const store = SessionStore.open(root, claim.session_id, { clock });
  await store.init({ agent, cwd: payload.cwd?.trim() || io.cwd });

  return { root, agent, sessionId: claim.session_id, store, clock };
}

function context(root: string, agent: AgentKind, sessionId: string, clock: Clock): HookContext {
  return { root, agent, sessionId, store: SessionStore.open(root, sessionId, { clock }), clock };
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
