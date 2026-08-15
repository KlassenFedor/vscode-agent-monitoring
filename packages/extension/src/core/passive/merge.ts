import type { SessionView } from '../model.js';
import type { PassiveSessionView } from './tracker.js';

export interface PassiveMerge {
  /** Passive sessions that deserve a row of their own. */
  visible: PassiveSessionView[];
  /**
   * Pulse for a registered session that is publishing nothing, by session id.
   *
   * The row is real — it opens, it takes comments — but without this it would show a
   * status and nothing else, and go stale while the agent was still working.
   */
  attached: Map<string, PassiveSessionView>;
}

/**
 * Decide what to do with each passive session next to the registered ones.
 *
 * Passive tracking answers one question — "is the agent alive and what is it doing" —
 * and stops being a separate row as soon as it can be tied to a session on disk: the
 * ids rarely match, so showing both would put one piece of work on screen twice under
 * two different names. Tied to a session, the pulse becomes that session's liveness.
 */
export function mergePassive(
  sessions: readonly SessionView[],
  passive: readonly PassiveSessionView[],
): PassiveMerge {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const byTranscript = new Map(
    sessions.flatMap((session) =>
      session.meta?.transcript_path ? [[session.meta.transcript_path, session] as const] : [],
    ),
  );

  const attached = new Map<string, PassiveSessionView>();
  const visible: PassiveSessionView[] = [];

  for (const view of passive) {
    // Same file, or the same id, therefore the same work — whatever the two sides call
    // it, and whether or not that session has finished reporting.
    const exact =
      byTranscript.get(view.transcriptPath) ??
      (view.sessionId === null ? undefined : byId.get(view.sessionId));
    if (exact) {
      if (!attached.has(exact.id)) attached.set(exact.id, view);
      continue;
    }

    const adopted = adoptable(sessions, view, attached);
    if (adopted) attached.set(adopted.id, view);
    else visible.push(view);
  }

  return { visible, attached };
}

/**
 * The live session this pulse most likely belongs to.
 *
 * Codex never tells us where it keeps its rollout, so the agent and "still running" is
 * all there is to match on. That is enough in practice — one agent of a kind per
 * workspace — and the guard is that a session which already named a transcript, or
 * already took a pulse, is not a candidate.
 */
function adoptable(
  sessions: readonly SessionView[],
  view: PassiveSessionView,
  attached: ReadonlyMap<string, PassiveSessionView>,
): SessionView | undefined {
  const candidates = sessions.filter(
    (session) =>
      session.meta?.agent === view.agent &&
      session.status !== 'done' &&
      !session.meta?.transcript_path &&
      !attached.has(session.id),
  );

  return candidates.reduce<SessionView | undefined>(
    (best, session) => ((session.lastActivityAt ?? '') > (best?.lastActivityAt ?? '') ? session : best),
    candidates[0],
  );
}
