import type { CommentKind } from '@agent-monitor/protocol';

/**
 * How a kind of comment is offered to the human.
 *
 * `fyi` / `steer` / `stop` are the protocol's vocabulary, and the person writing the
 * comment is solving a different problem: "change course" or "just mention something".
 * The wire format keeps its names — it is a contract — and the human reads intent.
 *
 * One list, because there are two places to send a comment from (the panel and the
 * command palette) and two sets of wording for the same three things is how they end
 * up meaning subtly different things.
 */
export interface CommentKindChoice {
  kind: CommentKind;
  label: string;
  /** What it does to the agent's plan, which is the part that decides the choice. */
  detail: string;
}

export const COMMENT_KIND_CHOICES: readonly CommentKindChoice[] = [
  {
    kind: 'steer',
    label: 'Change course',
    detail: 'Binding: the agent applies it from its next step and drops the part of its plan that conflicts.',
  },
  {
    kind: 'fyi',
    label: 'Add context',
    detail: 'Not binding: the agent takes note and carries on as planned.',
  },
];

/**
 * Stopping is an action, not a kind of remark, so it is not in the list above.
 *
 * A blocked agent ends its turn and waits on its own terminal; hooks stop running, so
 * nothing written to the session can reach it (docs-local/live/FINDINGS.md §1). There
 * is no "carry on" to pair with it, and every place that offers a stop says so.
 */
export const STOP_CHOICE: CommentKindChoice = {
  kind: 'stop',
  label: 'Stop the agent',
  detail: 'It stops and waits. Only the terminal it runs in can start it again.',
};

/** Default reason for a stop sent with nothing typed; the schema wants text. */
export const DEFAULT_STOP_REASON = 'The human asked you to stop and wait.';

/**
 * What the timeline prints on a comment.
 *
 * The badge used to print the wire name, so a human who chose "Change course" read
 * "STEER" two lines below it and had to work out that these were the same thing.
 * `answer` is named here rather than in the choice list because it is never chosen:
 * it comes from the buttons on a question the agent asked.
 */
const KIND_BADGES: Record<CommentKind, string> = {
  steer: 'course change',
  fyi: 'context',
  stop: 'stop',
  answer: 'answer',
};

export function commentKindLabel(kind: CommentKind): string {
  return KIND_BADGES[kind];
}
