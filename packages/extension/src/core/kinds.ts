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
    label: 'Change the plan',
    detail: 'Overrides the plan: the agent has to apply it from its next step.',
  },
  {
    kind: 'fyi',
    label: 'Just so you know',
    detail: 'Context only. The agent is not expected to change what it is doing.',
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
  label: 'Stop and wait',
  detail: 'The agent stops and waits. Telling it to carry on happens in the terminal it runs in.',
};

/** Default reason for a stop sent with nothing typed; the schema wants text. */
export const DEFAULT_STOP_REASON = 'The human asked you to stop and wait.';
