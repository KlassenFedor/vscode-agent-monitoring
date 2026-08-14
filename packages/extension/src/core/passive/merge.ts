import type { SessionView } from '../model.js';
import type { PassiveSessionView } from './tracker.js';

/**
 * Decide which passive sessions are worth showing next to the real ones.
 *
 * Passive tracking answers one question — "is the agent alive and what is it doing" —
 * and only matters while nothing is being published. Once an agent reports through
 * the monitoring tools, showing its transcript pulse as well would put the same
 * session on screen twice, under two different names, since the ids rarely match.
 */
export function visiblePassive(
  sessions: readonly SessionView[],
  passive: readonly PassiveSessionView[],
): PassiveSessionView[] {
  const reportingAgents = new Set(
    sessions.filter((session) => session.status !== 'done').map((session) => session.meta?.agent),
  );
  const knownIds = new Set(sessions.map((session) => session.id));
  const knownTranscripts = new Set(
    sessions.map((session) => session.meta?.transcript_path).filter((file): file is string => Boolean(file)),
  );

  return passive.filter((view) => {
    // Same file, therefore the same work — whatever the two sides call it, and whether
    // or not that session has finished reporting.
    if (knownTranscripts.has(view.transcriptPath)) return false;
    if (view.sessionId !== null && knownIds.has(view.sessionId)) return false;
    return !reportingAgents.has(view.agent);
  });
}
