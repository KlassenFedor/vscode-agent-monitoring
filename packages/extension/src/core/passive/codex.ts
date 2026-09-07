import { ActivityParser, isObject } from './activity.js';

/**
 * Reads a Codex rollout file (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 *
 * Every record is `{ timestamp, type, payload }`, and the payload's own `type`
 * decides what it is. The working directory arrives in `session_meta` and is
 * repeated in each `turn_context`, which is what lets a rollout be matched to a
 * workspace (TESTS.md PASV-03).
 */
export class CodexTranscriptParser extends ActivityParser {
  constructor() {
    super('codex');
  }

  protected consume(record: Record<string, unknown>): void {
    this.noteTimestamp(record.timestamp);

    const payload = record.payload;
    if (!isObject(payload)) return;

    switch (record.type) {
      case 'session_meta':
        if (typeof payload.session_id === 'string') this.activity.sessionId = payload.session_id;
        if (typeof payload.cwd === 'string') this.activity.cwd = payload.cwd;
        if (isObject(payload.git) && typeof payload.git.branch === 'string') {
          this.activity.branch = payload.git.branch;
        }
        this.#consumeThreadSource(payload);
        return;

      case 'turn_context':
        if (typeof payload.cwd === 'string') this.activity.cwd = payload.cwd;
        return;

      case 'event_msg':
        if (payload.type === 'agent_message') this.noteMessage(payload.message);
        return;

      case 'response_item':
        this.#consumeResponseItem(payload);
        return;

      default:
        return;
    }
  }

  /**
   * Decide whether this rollout is a conversation or one of its helpers.
   *
   * Codex 0.15 spawns subagents — an approval reviewer, a waiter, whatever a `spawn_agent`
   * asks for — and each gets its own rollout file, written in the same second, in the
   * same directory, carrying the same `cwd` and the same `session_id` as the thread that
   * spawned it. Only `id` differs. Left alone, one Codex turn therefore filled the
   * sidebar with a row per helper, all ticking together: the conversation, a row whose
   * whole content was the reviewer's verdict as raw JSON, and a nameless one for a helper
   * that had not spoken yet.
   *
   * `parent_thread_id` is the field that says so outright, and it is the one relied on;
   * `source` is read too because it carries the same fact in a shape that survived a
   * rename once already, and neither appears on a rollout the human started.
   */
  #consumeThreadSource(payload: Record<string, unknown>): void {
    const parent = payload.parent_thread_id;
    if (typeof parent === 'string' && parent.trim() !== '') {
      this.noteSubagent(parent);
      return;
    }
    if (isObject(payload.source) && 'subagent' in payload.source) {
      this.noteSubagent(payload.session_id);
    }
  }

  #consumeResponseItem(payload: Record<string, unknown>): void {
    if (payload.type === 'function_call') {
      this.noteTool(payload.name, parseArguments(payload.arguments));
      return;
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      const content = payload.content;
      if (typeof content === 'string') {
        this.noteMessage(content);
        return;
      }
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (isObject(part) && typeof part.text === 'string') this.noteMessage(part.text);
      }
    }
  }
}

/** Codex passes tool arguments as a JSON string. */
function parseArguments(value: unknown): unknown {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
