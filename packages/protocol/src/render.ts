import type { Comment } from './schema.js';

export interface RenderOptions {
  /** Replaces the default "N new comments from the human:" line. */
  heading?: string;
}

/**
 * Render human comments for an agent to read.
 *
 * Lives in the protocol package because both delivery channels need identical
 * wording: the MCP tool reply and the hook's injected context. Text that lands in an
 * agent's context is written as instructions — the kind first, then what it obliges
 * the agent to do — since the agent acts on it rather than merely displaying it.
 */
export function renderComments(comments: readonly Comment[], options: RenderOptions = {}): string {
  if (comments.length === 0) return '';

  const lines = comments.map((comment) => {
    const target = comment.reply_to === undefined ? '' : ` (on report #${comment.reply_to})`;
    return `  [${comment.kind}]${target} ${comment.text}`;
  });

  const noun = comments.length === 1 ? 'comment' : 'comments';
  const heading = options.heading ?? `${comments.length} new ${noun} from the human:`;
  return [heading, ...lines, '', guidanceFor(comments)].join('\n');
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
