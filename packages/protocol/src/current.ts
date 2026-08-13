import { readJsonFile, writeJsonAtomic } from './atomic.js';
import { systemClock, type Clock } from './clock.js';
import { ValidationError } from './errors.js';
import { withFileLock } from './lock.js';
import { isSafeSessionId, lockPathFor, monitorDir } from './paths.js';
import { AGENT_KINDS, type AgentKind, type OpenRecord } from './schema.js';

import * as path from 'node:path';

/**
 * Which session is the live one for an agent in this workspace.
 *
 * Two processes need to agree on it and neither can tell the other directly: the MCP
 * server learns its id from the environment (often not at all, and then it invents
 * one), while the hook learns it from the JSON the agent pipes in. Without a shared
 * answer the human's comments land in one session directory and the agent reads
 * another — feedback silently goes nowhere.
 */
export interface CurrentSession extends OpenRecord {
  session_id: string;
  agent: AgentKind;
  /**
   * The claimant knew the agent's real session id, rather than having invented one.
   * An authoritative claim displaces a generated one; the reverse never happens.
   */
  authoritative: boolean;
  updated_at: string;
}

export interface ClaimOptions {
  authoritative?: boolean;
  /** A pointer older than this belongs to a finished session and may be replaced. */
  maxAgeMs?: number;
  clock?: Clock;
}

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function currentSessionPath(root: string, agent: AgentKind): string {
  return path.join(monitorDir(root), `current-${agent}.json`);
}

export async function readCurrentSession(root: string, agent: AgentKind): Promise<CurrentSession | null> {
  try {
    const raw = await readJsonFile(currentSessionPath(root, agent));
    return raw === null ? null : parseCurrentSession(raw);
  } catch {
    // A pointer we cannot read — truncated, hand-edited, pointing somewhere unsafe —
    // is worth no more than a missing one; the caller claims the slot and overwrites.
    return null;
  }
}

/**
 * Register `sessionId` as the current session, or adopt the one already registered.
 *
 * Returns the pointer that won, which the caller must use from then on. Whoever
 * starts first usually wins; an authoritative claim beats a fresh generated one, so
 * the agent's own id ends up being the shared answer regardless of start order.
 */
export async function claimCurrentSession(
  root: string,
  agent: AgentKind,
  sessionId: string,
  options: ClaimOptions = {},
): Promise<CurrentSession> {
  const clock = options.clock ?? systemClock;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const authoritative = options.authoritative ?? false;
  const file = currentSessionPath(root, agent);

  return withFileLock(lockPathFor(file), async () => {
    const existing = await readCurrentSession(root, agent);

    if (existing && !shouldReplace(existing, { authoritative, maxAgeMs, now: clock.now() })) {
      return existing;
    }

    const claim: CurrentSession = {
      session_id: sessionId,
      agent,
      authoritative,
      updated_at: clock.iso(),
    };
    await writeJsonAtomic(file, claim);
    return claim;
  });
}

function shouldReplace(
  existing: CurrentSession,
  ctx: { authoritative: boolean; maxAgeMs: number; now: number },
): boolean {
  const age = ctx.now - Date.parse(existing.updated_at);
  if (Number.isNaN(age) || age > ctx.maxAgeMs) return true;
  return ctx.authoritative && !existing.authoritative;
}

export function parseCurrentSession(raw: unknown): CurrentSession {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('current', 'expected an object');
  }
  const o = raw as Record<string, unknown>;

  const sessionId = o.session_id;
  if (typeof sessionId !== 'string' || !isSafeSessionId(sessionId)) {
    throw new ValidationError('current.session_id', 'missing or unsafe session id');
  }
  const agent = o.agent;
  if (typeof agent !== 'string' || !AGENT_KINDS.includes(agent as AgentKind)) {
    throw new ValidationError('current.agent', `expected one of ${AGENT_KINDS.join(' | ')}`);
  }
  const updatedAt = o.updated_at;
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    throw new ValidationError('current.updated_at', 'not an ISO-8601 timestamp');
  }

  return {
    ...o,
    session_id: sessionId,
    agent: agent as AgentKind,
    authoritative: o.authoritative === true,
    updated_at: new Date(Date.parse(updatedAt)).toISOString(),
  };
}
