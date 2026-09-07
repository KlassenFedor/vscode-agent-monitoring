import type { SessionView } from './model.js';
import type { PassiveSessionView } from './passive/tracker.js';

export interface ResidualOptions {
  /** Sessions an agent's pointer names right now (`currentSessionIds`). */
  current: ReadonlySet<string>;
  /** Transcript pulse per session id, from `mergePassive`. */
  pulses: ReadonlyMap<string, PassiveSessionView>;
}

/**
 * Session directories that hold nothing and are not going to.
 *
 * These are made by us, not by the human. Claude Code ends its session and starts a
 * new one on `/clear`, `/model`, `/effort`, `/login` and `/resume`: a new id, a new
 * transcript, and a fresh `SessionStart` hook, which duly registers a session. The
 * conversation carries on under the new id and the old directory is left holding one
 * `meta.json` — no reports, no comments, no artifacts, no title, because the Stop hook
 * that would have named it never ran. A morning of ordinary work leaves a dozen of
 * them, and every one takes a row in the list next to the session the human is actually
 * watching (TESTS.md EXT-43).
 *
 * Hidden rather than deleted here, because this runs on the watcher tick and hiding is
 * the reversible half: rotation removes them from disk on the next start. Four
 * conditions have to hold together, and each one is there to protect a session that
 * only looks empty:
 *
 * - nothing published and nothing said — one report or one comment makes it a session;
 * - no title — a name is a thing the human can recognise it by, even with nothing else;
 * - stale, so a session registered seconds ago still appears at once, which is the whole
 *   point of registering it at process start (DESIGN.md §3);
 * - no live transcript pulse and not the current pointer, which together cover the
 *   session that is working normally and simply has not reported yet.
 */
export function residualSessions(sessions: readonly SessionView[], options: ResidualOptions): Set<string> {
  const hidden = new Set<string>();

  for (const session of sessions) {
    // Archiving is the human's own statement about a session; it outranks ours.
    if (session.archived) continue;
    if (options.current.has(session.id)) continue;
    if (session.events.length > 0 || session.comments.length > 0) continue;
    if (typeof session.meta?.title === 'string' && session.meta.title.trim() !== '') continue;
    if (!session.stale) continue;

    const pulse = options.pulses.get(session.id);
    if (pulse && !pulse.stale) continue;

    hidden.add(session.id);
  }

  return hidden;
}
