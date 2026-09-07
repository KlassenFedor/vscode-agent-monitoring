import type { AgentKind } from '@agent-monitor/protocol';

/**
 * One thing the agent said or did, in the order the transcript recorded it.
 *
 * This is what turns the passive layer into a timeline rather than a single reading:
 * a session that never calls the monitoring tools still has a history, and replacing
 * it with the latest line loses everything the human might want to comment on.
 */
export interface PassiveEntry {
  /**
   * Position in the transcript, counted from the first record ever read.
   *
   * Never reused and never renumbered, which is what makes it usable as the identity
   * of a row on screen: the list is capped and drops entries off the front, so an index
   * into it would shift under every trim and redraw the whole timeline.
   */
  ordinal: number;
  /** Timestamp of the transcript record, when it carried one. */
  ts: string | null;
  kind: 'message' | 'tool';
  text: string;
}

/**
 * What can be learned about a session without the agent cooperating at all.
 *
 * Enough to answer "is it alive, what is it doing, and what has it done" while the
 * agent publishes nothing (DESIGN.md §5).
 */
export interface PassiveActivity {
  agent: AgentKind;
  sessionId: string | null;
  cwd: string | null;
  branch: string | null;
  /** Timestamp of the most recent record in the transcript. */
  lastActivityAt: string | null;
  /** Last thing the agent said, trimmed to something a sidebar can show. */
  lastMessage: string | null;
  /** Tool the agent used most recently. */
  currentTool: string | null;
  /** Files the agent wrote to, most recent last, de-duplicated. */
  changedFiles: string[];
  /** What the agent said and did, oldest first, capped at the most recent entries. */
  entries: PassiveEntry[];
  /**
   * Thread this transcript was spawned from, when it is not a conversation of its own.
   *
   * Both agents have grown helpers that get a transcript each — Codex writes one file
   * per subagent thread beside the parent's, in the same working directory — and a
   * helper is not a session. It has no separate life to report on, it starts and ends
   * inside one turn of the thread that spawned it, and it is written at the same
   * moment, so a row of its own is the same work counted twice (TESTS.md PASV-15).
   */
  subagentOf: string | null;
}

export const EMPTY_ACTIVITY: PassiveActivity = {
  agent: 'other',
  sessionId: null,
  cwd: null,
  branch: null,
  lastActivityAt: null,
  lastMessage: null,
  currentTool: null,
  changedFiles: [],
  entries: [],
  subagentOf: null,
};

const MAX_CHANGED_FILES = 50;
const MAX_MESSAGE_CHARS = 400;
/** A transcript runs for hours; the timeline only has to be worth scrolling. */
const MAX_ENTRIES = 200;
const MAX_TOOL_CHARS = 120;

/**
 * Accumulates transcript records into an activity summary.
 *
 * Written as a reducer so a growing transcript can be fed in chunks: the parser is
 * handed only the records appended since the last read (TESTS.md PASV-05).
 */
export abstract class ActivityParser {
  protected readonly activity: PassiveActivity;
  readonly #changed = new Set<string>();
  readonly #entries: PassiveEntry[] = [];
  #ordinal = 0;

  constructor(agent: AgentKind) {
    this.activity = { ...EMPTY_ACTIVITY, agent, changedFiles: [], entries: [] };
  }

  /** Feed one record. Must never throw: transcripts are somebody else's format. */
  apply(record: unknown): void {
    try {
      if (isObject(record)) this.consume(record);
    } catch {
      // A record we cannot make sense of costs us that record, nothing more.
    }
  }

  applyAll(records: readonly unknown[]): void {
    for (const record of records) this.apply(record);
  }

  result(): PassiveActivity {
    return {
      ...this.activity,
      changedFiles: [...this.#changed].slice(-MAX_CHANGED_FILES),
      entries: [...this.#entries],
    };
  }

  /**
   * The workspace this transcript belongs to, once a record has mentioned one.
   *
   * Separate from {@link result} because it is checked after every read, to drop
   * rollouts belonging to other projects, and `result` copies the whole summary
   * including the changed-file list.
   */
  get cwd(): string | null {
    return this.activity.cwd;
  }

  /**
   * The thread that spawned this one, once a record has said there was one.
   *
   * Checked after every read, next to {@link cwd}, and for the same reason: both are
   * grounds for dropping the file rather than showing it, and both are known long
   * before the transcript is finished.
   */
  get subagentOf(): string | null {
    return this.activity.subagentOf;
  }

  protected abstract consume(record: Record<string, unknown>): void;

  protected noteTimestamp(value: unknown): void {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return;
    const normalized = new Date(Date.parse(value)).toISOString();
    if (this.activity.lastActivityAt === null || normalized > this.activity.lastActivityAt) {
      this.activity.lastActivityAt = normalized;
    }
  }

  protected noteMessage(value: unknown): void {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text === '') return;
    this.activity.lastMessage = truncate(text, MAX_MESSAGE_CHARS);
    this.#record('message', this.activity.lastMessage);
  }

  protected noteTool(name: unknown, input: unknown): void {
    if (typeof name !== 'string' || name === '') return;
    this.activity.currentTool = name;
    this.#record('tool', describeTool(name, input));

    if (!isObject(input)) return;
    const target = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof target === 'string' && WRITING_TOOLS.has(name)) this.#changed.add(target);
  }

  /** Record that this transcript belongs to a helper spawned by another thread. */
  protected noteSubagent(parent: unknown): void {
    if (this.activity.subagentOf !== null) return;
    const id = typeof parent === 'string' ? parent.trim() : '';
    // The parent id is worth keeping when the transcript names it, but the decision
    // this feeds does not depend on knowing it: what matters is that there is one.
    this.activity.subagentOf = id === '' ? 'unknown' : id;
  }

  protected noteChangedFile(value: unknown): void {
    if (typeof value === 'string' && value !== '') this.#changed.add(value);
  }

  /**
   * Append to the timeline, skipping a repeat of the entry just recorded.
   *
   * Codex announces the same assistant message twice — once as an `event_msg` and
   * again as a `response_item` — and a timeline that shows both reads as if the agent
   * said everything twice.
   */
  #record(kind: PassiveEntry['kind'], text: string): void {
    const last = this.#entries.at(-1);
    if (last?.kind === kind && last.text === text) return;

    this.#ordinal += 1;
    this.#entries.push({ ordinal: this.#ordinal, ts: this.activity.lastActivityAt, kind, text });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
  }
}

/** `Read: src/parser.ts`, `shell: pytest -q` — the tool plus whatever it was aimed at. */
function describeTool(name: string, input: unknown): string {
  if (!isObject(input)) return name;

  const target = input.file_path ?? input.path ?? input.notebook_path ?? input.command ?? input.pattern;
  const rendered = Array.isArray(target)
    ? target.filter((part) => typeof part === 'string').join(' ')
    : target;
  if (typeof rendered !== 'string' || rendered.trim() === '') return name;

  return truncate(`${name}: ${rendered.trim()}`, MAX_TOOL_CHARS);
}

/**
 * Cut long text, and say so.
 *
 * A hard slice left the agent ending mid-sentence with nothing to distinguish "it
 * wrote that much" from "we cut it here", which reads as a confused agent rather than
 * a truncated line.
 */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

const WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'apply_patch']);

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
