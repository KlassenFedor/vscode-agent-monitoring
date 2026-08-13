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

  return passive.filter((view) => {
    if (view.sessionId !== null && knownIds.has(view.sessionId)) return false;
    return !reportingAgents.has(view.agent);
  });
}
