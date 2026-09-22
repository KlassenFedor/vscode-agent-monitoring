import { promises as fs } from 'node:fs';

import {
  AGENT_KINDS,
  readCurrentSession,
  sessionDir,
  SessionStore,
  systemClock,
  type Clock,
  type SessionMeta,
} from '@agent-monitor/protocol';

export interface ManageOptions {
  clock?: Clock;
}

/**
 * File a session away.
 *
 * Archiving is a statement about the human's attention, not about the work: the
 * directory stays where it is, with every report, comment and artefact intact, and an
 * agent still writing to it goes on writing. Only the list stops leading with it.
 *
 * Recorded in `meta.json` rather than in the extension's own storage, because the
 * session directory is already the one place that survives a reinstall, a different
 * machine, and a second editor open on the same workspace.
 */
export async function archiveSession(
  root: string,
  sessionId: string,
  options: ManageOptions = {},
): Promise<SessionMeta> {
  const clock = options.clock ?? systemClock;
  const store = SessionStore.open(root, sessionId, { clock });
  return store.patchMeta({ archived_at: clock.iso() }, { touch: false });
}

/**
 * Put an archived session back in the list.
 *
 * `restored_at` restarts the clocks that archive and delete old sessions (`lastTouchedMs`
 * in rotate.ts): a session brought back by hand is one the human wants to see, and the
 * next automatic pass must not file it away again on the strength of its age.
 */
export async function unarchiveSession(
  root: string,
  sessionId: string,
  options: ManageOptions = {},
): Promise<SessionMeta> {
  const clock = options.clock ?? systemClock;
  const store = SessionStore.open(root, sessionId, { clock });
  // `undefined` erases the field: the merge keeps the key and JSON drops it (patchMeta).
  return store.patchMeta({ archived_at: undefined, restored_at: clock.iso() }, { touch: false });
}

/**
 * Delete a session directory and everything in it.
 *
 * The counterpart of rotation, which does the same thing on a timer. This one is the
 * human saying it now, so it does not exempt the session an agent's pointer names — but
 * the caller is expected to have said out loud what is being destroyed first
 * (`sessionFootprint`), because nothing here is recoverable.
 */
export async function deleteSession(root: string, sessionId: string): Promise<void> {
  await fs.rm(sessionDir(root, sessionId), { recursive: true, force: true });
}

export interface SessionFootprint {
  events: number;
  comments: number;
  artifacts: number;
  /** True when `current-<agent>.json` still points at this session. */
  current: boolean;
}

/**
 * What deleting this session would destroy.
 *
 * Read from disk rather than taken from the model: the confirmation must describe the
 * files, and the model's copy is as old as the last refresh.
 */
export async function sessionFootprint(root: string, sessionId: string): Promise<SessionFootprint> {
  const store = SessionStore.open(root, sessionId);
  const [events, comments, artifacts] = await Promise.all([
    store.listEvents().catch(() => []),
    store.listComments().catch(() => []),
    store.listArtifacts().catch(() => []),
  ]);

  return {
    events: events.length,
    comments: comments.length,
    artifacts: artifacts.length,
    current: await isCurrentSession(root, sessionId),
  };
}

/** Is an agent pointed at this session right now? */
export async function isCurrentSession(root: string, sessionId: string): Promise<boolean> {
  return (await currentSessionIds(root)).has(sessionId);
}

/**
 * The session each agent's pointer names, across every agent.
 *
 * One small file per agent, and everything that decides a session's fate reads it:
 * rotation refuses to delete these, and the list refuses to hide them. A session an
 * agent is about to write to is never residue, however empty it looks right now.
 */
export async function currentSessionIds(root: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const agent of AGENT_KINDS) {
    const pointer = await readCurrentSession(root, agent);
    if (pointer) ids.add(pointer.session_id);
  }
  return ids;
}
