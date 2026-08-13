import type { AgentEvent } from '@agent-monitor/protocol';

import type { SessionView } from './model.js';

export type NotificationLevel = 'none' | 'info' | 'error';

export interface NotificationPlan {
  level: NotificationLevel;
  message: string;
  /** Buttons to offer; for a question these are the agent's own options. */
  actions: string[];
  sessionId: string;
  event?: AgentEvent;
}

const NOTHING: Omit<NotificationPlan, 'sessionId'> = { level: 'none', message: '', actions: [] };

/**
 * Decide whether a change deserves to interrupt the human.
 *
 * Only two things do: the agent is blocked waiting for an answer, and the agent hit
 * an error. Progress reports go to the badge and the timeline — a notification per
 * milestone would train the human to dismiss them all (TESTS.md EXT-06).
 */
export function planNotification(next: SessionView, previous?: SessionView): NotificationPlan {
  const base = { sessionId: next.id };

  if (next.waitingQuestion && previous?.waitingQuestion?.seq !== next.waitingQuestion.seq) {
    const options = next.waitingQuestion.options;
    return {
      ...base,
      level: 'info',
      message: `${sessionLabel(next)} is waiting: ${next.waitingQuestion.title}`,
      actions: Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : [],
      event: next.waitingQuestion,
    };
  }

  const error = newestErrorSince(next, previous);
  if (error) {
    return {
      ...base,
      level: 'error',
      message: `${sessionLabel(next)}: ${error.title}`,
      actions: [],
      event: error,
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
