import type { Comment } from '@agent-monitor/protocol';

/**
 * Render human comments for the agent.
 *
 * This text lands directly in the agent's context, so it is written as instructions
 * rather than as a data dump: the kind is stated first, and the closing line says
 * what the agent is expected to do about it.
 */
export function renderComments(comments: readonly Comment[]): string {
  if (comments.length === 0) return '';

  const lines = comments.map((comment) => {
    const target = comment.reply_to === undefined ? '' : ` (on report #${comment.reply_to})`;
    return `  [${comment.kind}]${target} ${comment.text}`;
  });

  const noun = comments.length === 1 ? 'comment' : 'comments';
  return [`${comments.length} new ${noun} from the human:`, ...lines, '', guidanceFor(comments)].join('\n');
}

function guidanceFor(comments: readonly Comment[]): string {
  const kinds = new Set(comments.map((comment) => comment.kind));
  const guidance: string[] = [];

  if (kinds.has('stop')) {
    guidance.push('A [stop] comment means: stop the current line of work and wait for the human.');
  }
  if (kinds.has('steer')) {
    guidance.push('A [steer] comment overrides the earlier plan. Apply it from your next step onwards.');
  }
  if (kinds.has('answer')) {
    guidance.push('An [answer] comment answers a question you asked.');
  }
  if (kinds.has('fyi')) {
    guidance.push('An [fyi] comment is context only; it does not require a change of plan.');
  }
  return guidance.join('\n');
}

/** Join non-empty blocks with a blank line between them. */
export function paragraphs(...blocks: (string | undefined | false)[]): string {
  return blocks.filter((block): block is string => typeof block === 'string' && block !== '').join('\n\n');
}
