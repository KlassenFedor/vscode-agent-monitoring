import { ActivityParser, isObject } from './activity.js';

/**
 * Reads a Claude Code transcript (`~/.claude/projects/<slug>/<session>.jsonl`).
 *
 * The interesting records are `assistant` and `user` messages; the file also carries
 * a dozen bookkeeping types (`mode`, `file-history-snapshot`, `bridge-session`, …)
 * that are skipped by falling through. This format is undocumented and moves, so
 * unknown shapes are ignored rather than treated as errors (TESTS.md PASV-04).
 */
export class ClaudeTranscriptParser extends ActivityParser {
  constructor() {
    super('claude');
  }

  protected consume(record: Record<string, unknown>): void {
    this.noteTimestamp(record.timestamp);

    if (typeof record.sessionId === 'string') this.activity.sessionId = record.sessionId;
    if (typeof record.cwd === 'string') this.activity.cwd = record.cwd;
    if (typeof record.gitBranch === 'string') this.activity.branch = record.gitBranch;

    if (record.type !== 'assistant' && record.type !== 'user') return;

    const message = record.message;
    if (!isObject(message)) return;

    const content = message.content;
    if (typeof content === 'string') {
      if (record.type === 'assistant') this.noteMessage(content);
      return;
    }
    if (!Array.isArray(content)) return;

    for (const part of content) {
      if (!isObject(part)) continue;
      if (part.type === 'text' && record.type === 'assistant') this.noteMessage(part.text);
      else if (part.type === 'tool_use') this.noteTool(part.name, part.input);
    }
  }
}
