import { ValidationError } from './errors.js';
import { assertArtifactRef } from './paths.js';

export const EVENT_TYPES = ['progress', 'artifact', 'question', 'status', 'error'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const COMMENT_KINDS = ['fyi', 'steer', 'answer', 'stop'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export const SESSION_STATUSES = ['working', 'blocked', 'waiting_review', 'done', 'error'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const AGENT_KINDS = ['claude', 'codex', 'other'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Records carry an open index signature on purpose.
 *
 * A newer writer may add fields an older reader knows nothing about; those fields
 * survive a read/write round trip untouched instead of being silently dropped
 * (TESTS.md PROTO-05).
 */
export interface OpenRecord {
  [key: string]: unknown;
}

/** One entry in `events.jsonl`: agent to human. */
export interface AgentEvent extends OpenRecord {
  seq: number;
  ts: string;
  type: EventType;
  title: string;
  phase?: string;
  summary?: string;
  /** Paths relative to the session directory, always under `artifacts/`. */
  artifacts?: string[];
  next?: string;
  /** True only for `question` events the agent is blocked on. */
  needs_answer?: boolean;
  cost?: { tokens_in?: number; tokens_out?: number };
}

export type EventInput = Omit<AgentEvent, 'seq' | 'ts'> & { ts?: string };

/** One entry in `inbox.jsonl`: human to agent. */
export interface Comment extends OpenRecord {
  seq: number;
  ts: string;
  kind: CommentKind;
  text: string;
  /** `seq` of the event this comment replies to, when it replies to one. */
  reply_to?: number;
  author?: string;
}

export type CommentInput = Omit<Comment, 'seq' | 'ts'> & { ts?: string };

export interface SessionMeta extends OpenRecord {
  id: string;
  agent: AgentKind;
  cwd: string;
  status: SessionStatus;
  started_at: string;
  updated_at: string;
  protocol_version: number;
  title?: string;
  branch?: string;
  ended_at?: string;
  /**
   * The agent's own transcript for this session, as the agent reported it.
   *
   * Recorded so the passive layer can read the right file instead of deriving its path
   * from the working directory, which is guesswork about someone else's naming scheme.
   */
  transcript_path?: string;
  /**
   * When the human filed this session away.
   *
   * Set from the UI, never by an agent: it says the human is done looking at this
   * session, not that the work finished. The directory stays exactly where it was, so
   * nothing that reads the bus has to know the field exists.
   */
  archived_at?: string;
}

/**
 * How far into `inbox.jsonl` the agent has been fed.
 *
 * Advanced only after a comment has actually reached the agent, never on read
 * alone — otherwise feedback disappears silently (TESTS.md HOOK-06).
 */
export interface Cursor extends OpenRecord {
  inbox_seq: number;
  updated_at: string;
  /** Last time the hook emitted comments; used for debouncing. */
  last_drain_at?: string;
}

export function parseEvent(raw: unknown): AgentEvent {
  const o = asObject(raw, 'event');
  const event: AgentEvent = {
    ...o,
    seq: requireInt(o.seq, 'event.seq', 1),
    ts: requireTimestamp(o.ts, 'event.ts'),
    type: requireEnum(o.type, 'event.type', EVENT_TYPES),
    title: requireString(o.title, 'event.title', { maxLength: 500 }),
  };

  if (o.phase !== undefined) event.phase = requireString(o.phase, 'event.phase', { maxLength: 200 });
  if (o.summary !== undefined)
    event.summary = requireString(o.summary, 'event.summary', { allowEmpty: true });
  if (o.next !== undefined) event.next = requireString(o.next, 'event.next', { allowEmpty: true });
  if (o.needs_answer !== undefined) event.needs_answer = requireBoolean(o.needs_answer, 'event.needs_answer');
  if (o.artifacts !== undefined) event.artifacts = requireArtifactRefs(o.artifacts, 'event.artifacts');
  if (o.cost !== undefined) event.cost = requireCost(o.cost, 'event.cost');

  return event;
}

export function parseComment(raw: unknown): Comment {
  const o = asObject(raw, 'comment');
  const comment: Comment = {
    ...o,
    seq: requireInt(o.seq, 'comment.seq', 1),
    ts: requireTimestamp(o.ts, 'comment.ts'),
    kind: requireEnum(o.kind, 'comment.kind', COMMENT_KINDS),
    text: requireString(o.text, 'comment.text', { maxLength: 2000 }),
  };

  if (o.reply_to !== undefined) comment.reply_to = requireInt(o.reply_to, 'comment.reply_to', 1);
  if (o.author !== undefined) comment.author = requireString(o.author, 'comment.author', { maxLength: 200 });

  return comment;
}

export function parseMeta(raw: unknown): SessionMeta {
  const o = asObject(raw, 'meta');
  const meta: SessionMeta = {
    ...o,
    id: requireString(o.id, 'meta.id', { maxLength: 128 }),
    agent: requireEnum(o.agent, 'meta.agent', AGENT_KINDS),
    cwd: requireString(o.cwd, 'meta.cwd'),
    status: requireEnum(o.status, 'meta.status', SESSION_STATUSES),
    started_at: requireTimestamp(o.started_at, 'meta.started_at'),
    updated_at: requireTimestamp(o.updated_at, 'meta.updated_at'),
    protocol_version: requireInt(o.protocol_version, 'meta.protocol_version', 1),
  };

  if (o.title !== undefined) meta.title = requireString(o.title, 'meta.title', { maxLength: 500 });
  if (o.branch !== undefined) meta.branch = requireString(o.branch, 'meta.branch', { maxLength: 500 });
  if (o.ended_at !== undefined) meta.ended_at = requireTimestamp(o.ended_at, 'meta.ended_at');
  if (o.transcript_path !== undefined) {
    meta.transcript_path = requireString(o.transcript_path, 'meta.transcript_path', { maxLength: 4096 });
  }
  if (o.archived_at !== undefined) meta.archived_at = requireTimestamp(o.archived_at, 'meta.archived_at');

  return meta;
}

export function parseCursor(raw: unknown): Cursor {
  const o = asObject(raw, 'cursor');
  const cursor: Cursor = {
    ...o,
    inbox_seq: requireInt(o.inbox_seq, 'cursor.inbox_seq', 0),
    updated_at: requireTimestamp(o.updated_at, 'cursor.updated_at'),
  };
  if (o.last_drain_at !== undefined) {
    cursor.last_drain_at = requireTimestamp(o.last_drain_at, 'cursor.last_drain_at');
  }
  return cursor;
}

/**
 * Normalise UTC ISO-8601 timestamps.
 *
 * Everything on disk is stored as `...Z` with millisecond precision, which makes a
 * lexicographic string compare equivalent to a chronological one — the readers sort
 * by `ts` without parsing dates.
 */
export function normalizeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new ValidationError('ts', `not an ISO-8601 timestamp: ${value}`);
  return new Date(parsed).toISOString();
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(field, `expected an object, got ${describe(raw)}`);
  }
  return raw as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field, `expected a string, got ${describe(value)}`);
  }
  if (!options.allowEmpty && value.trim() === '') {
    throw new ValidationError(field, 'must not be empty');
  }
  const maxLength = options.maxLength ?? 100_000;
  if (value.length > maxLength) {
    throw new ValidationError(field, `is ${value.length} characters, limit is ${maxLength}`);
  }
  return value;
}

function requireInt(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ValidationError(field, `expected a safe integer, got ${describe(value)}`);
  }
  if (value < min) throw new ValidationError(field, `must be >= ${min}, got ${value}`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(field, `expected a boolean, got ${describe(value)}`);
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(field, `expected one of ${allowed.join(' | ')}, got ${describe(value)}`);
  }
  return value as T;
}

function requireTimestamp(value: unknown, field: string): string {
  const text = requireString(value, field);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new ValidationError(field, `not an ISO-8601 timestamp: ${text}`);
  return new Date(parsed).toISOString();
}

function requireArtifactRefs(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(field, `expected an array, got ${describe(value)}`);
  }
  if (value.length > 50) throw new ValidationError(field, `has ${value.length} entries, limit is 50`);
  return value.map((entry, index) => {
    const ref = requireString(entry, `${field}[${index}]`, { maxLength: 300 });
    try {
      return assertArtifactRef(ref);
    } catch (error) {
      throw new ValidationError(`${field}[${index}]`, (error as Error).message);
    }
  });
}

function requireCost(value: unknown, field: string): { tokens_in?: number; tokens_out?: number } {
  const o = asObject(value, field);
  const cost: { tokens_in?: number; tokens_out?: number } = { ...o };
  if (o.tokens_in !== undefined) cost.tokens_in = requireInt(o.tokens_in, `${field}.tokens_in`, 0);
  if (o.tokens_out !== undefined) cost.tokens_out = requireInt(o.tokens_out, `${field}.tokens_out`, 0);
  return cost;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
