import type { AgentKind } from '@agent-monitor/protocol';

/**
 * What can be learned about a session without the agent cooperating at all.
 *
 * This is a pulse, not a report: enough to answer "is it alive, and what is it doing"
 * while the agent publishes nothing (DESIGN.md §5).
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
};

const MAX_CHANGED_FILES = 50;
const MAX_MESSAGE_CHARS = 400;

/**
 * Accumulates transcript records into an activity summary.
 *
 * Written as a reducer so a growing transcript can be fed in chunks: the parser is
 * handed only the records appended since the last read (TESTS.md PASV-05).
 */
export abstract class ActivityParser {
  protected readonly activity: PassiveActivity;
  readonly #changed = new Set<string>();

  constructor(agent: AgentKind) {
    this.activity = { ...EMPTY_ACTIVITY, agent, changedFiles: [] };
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
    return { ...this.activity, changedFiles: [...this.#changed].slice(-MAX_CHANGED_FILES) };
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
    this.activity.lastMessage = text.slice(0, MAX_MESSAGE_CHARS);
  }

  protected noteTool(name: unknown, input: unknown): void {
    if (typeof name !== 'string' || name === '') return;
    this.activity.currentTool = name;

    if (!isObject(input)) return;
    const target = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof target === 'string' && WRITING_TOOLS.has(name)) this.#changed.add(target);
  }

  protected noteChangedFile(value: unknown): void {
    if (typeof value === 'string' && value !== '') this.#changed.add(value);
  }
}

const WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'apply_patch']);

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
