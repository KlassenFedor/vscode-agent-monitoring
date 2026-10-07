import type { AgentEvent } from '@agent-monitor/protocol';

import type { SessionView } from './model.js';

export type NotificationLevel = 'none' | 'info' | 'error';

export interface NotificationPlan {
  level: NotificationLevel;
  message: string;
  sessionId: string;
}

const NOTHING: Omit<NotificationPlan, 'sessionId'> = { level: 'none', message: '' };

/**
 * Decide whether a change deserves to interrupt the human.
 *
 * Only one thing does: the agent hit an error. Progress reports go to the badge and
 * the timeline — a notification per milestone would train the human to dismiss them
 * all (TESTS.md EXT-06).
 */
export function planNotification(next: SessionView, previous?: SessionView): NotificationPlan {
  const base = { sessionId: next.id };

  const error = newestErrorSince(next, previous);
  if (error) {
    return {
      ...base,
      level: 'error',
      message: `${sessionLabel(next)}: ${error.title}`,
    };
  }

  return { ...NOTHING, ...base };
}

function newestErrorSince(next: SessionView, previous?: SessionView): AgentEvent | null {
  const seen = previous?.events.at(-1)?.seq ?? 0;
  for (let index = next.events.length - 1; index >= 0; index -= 1) {
    const event = next.events[index];
    if (!event || event.seq <= seen) break;
    if (event.type === 'error') return event;
  }
  return null;
}

export function sessionLabel(session: SessionView): string {
  const title = session.meta?.title;
  if (typeof title === 'string' && title.trim() !== '') return title;
  const agent = session.meta?.agent ?? 'agent';
  return `${agent} session ${session.id.slice(0, 8)}`;
}

export interface SessionChoice {
  /** What the caller acts on. Never the label: two sessions can share one. */
  id: string;
  label: string;
  /** Whatever tells this one apart from its neighbours in the list. */
  description: string;
}

/**
 * Offer the sessions to choose between.
 *
 * The id travels with the choice because titles are written by a language model and
 * two of them can easily match: picking the session back out by its label handed the
 * comment to whichever one happened to be first, silently and in the case — several
 * agents at once — where being precise matters most.
 */
export function sessionChoices(sessions: readonly SessionView[]): SessionChoice[] {
  return sessions.map((session) => ({
    id: session.id,
    label: sessionLabel(session),
    description: [
      session.meta?.agent ?? 'agent',
      session.status,
      session.unread.length > 0 ? `${session.unread.length} undelivered` : '',
      session.id.slice(0, 8),
    ]
      .filter(Boolean)
      .join(' · '),
  }));
}
