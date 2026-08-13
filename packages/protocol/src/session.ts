import { promises as fs } from 'node:fs';

import { readJsonFile, writeFileAtomic, writeJsonAtomic } from './atomic.js';
import { systemClock, type Clock } from './clock.js';
import { ensureDir, isErrno } from './fsutil.js';
import { JsonlAppender, readJsonl, type JsonlChunk } from './jsonl.js';
import { withFileLock } from './lock.js';
import {
  artifactRef,
  artifactsDir,
  assertArtifactName,
  cursorPath,
  eventsPath,
  inboxPath,
  lockPathFor,
  metaPath,
  PROTOCOL_VERSION,
  resolveArtifactPath,
  sessionDir,
  uniqueArtifactName,
} from './paths.js';
import {
  parseComment,
  parseCursor,
  parseEvent,
  parseMeta,
  type AgentEvent,
  type AgentKind,
  type Comment,
  type CommentInput,
  type Cursor,
  type EventInput,
  type SessionMeta,
  type SessionStatus,
} from './schema.js';

export interface SessionStoreOptions {
  clock?: Clock;
  lockTimeoutMs?: number;
  maxRecordBytes?: number;
}

export interface SessionInit {
  agent: AgentKind;
  cwd: string;
  title?: string;
  branch?: string;
  status?: SessionStatus;
}

export interface WrittenArtifact {
  /** Final file name, which may differ from the requested one on collision. */
  name: string;
  /** `artifacts/<name>`, the form to put in `event.artifacts`. */
  ref: string;
  absPath: string;
}

/**
 * Read/write access to one session directory.
 *
 * This is the whole public surface of the file bus: the MCP server, the hook CLI and
 * the extension all go through it, so the on-disk layout stays an implementation
 * detail of this package (DESIGN.md §2).
 */
export class SessionStore {
  readonly root: string;
  readonly sessionId: string;
  readonly dir: string;

  readonly #clock: Clock;
  readonly #lockTimeoutMs: number | undefined;
  readonly #events: JsonlAppender;
  readonly #inbox: JsonlAppender;

  private constructor(root: string, sessionId: string, options: SessionStoreOptions) {
    this.root = root;
    this.sessionId = sessionId;
    this.dir = sessionDir(root, sessionId);
    this.#clock = options.clock ?? systemClock;
    this.#lockTimeoutMs = options.lockTimeoutMs;

    const appenderOptions = {
      ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    };
    this.#events = new JsonlAppender(eventsPath(root, sessionId), appenderOptions);
    this.#inbox = new JsonlAppender(inboxPath(root, sessionId), appenderOptions);
  }

  static open(root: string, sessionId: string, options: SessionStoreOptions = {}): SessionStore {
    return new SessionStore(root, sessionId, options);
  }

  /** Create the session directory and its metadata. Safe to call repeatedly. */
  async init(input: SessionInit): Promise<SessionMeta> {
    await ensureDir(this.dir);
    const existing = await this.readMeta();
    if (existing) return existing;

    const now = this.#clock.iso();
    const meta: SessionMeta = {
      id: this.sessionId,
      agent: input.agent,
      cwd: input.cwd,
      status: input.status ?? 'working',
      started_at: now,
      updated_at: now,
      protocol_version: PROTOCOL_VERSION,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
    };
    await writeJsonAtomic(metaPath(this.root, this.sessionId), parseMeta(meta));
    return meta;
  }

  async appendEvent(input: EventInput): Promise<AgentEvent> {
    const ts = input.ts ?? this.#clock.iso();
    return this.#events.append((seq) => parseEvent({ ...input, seq, ts }));
  }

  async appendComment(input: CommentInput): Promise<Comment> {
    const ts = input.ts ?? this.#clock.iso();
    return this.#inbox.append((seq) => parseComment({ ...input, seq, ts }));
  }

  /** Incremental read of `events.jsonl` starting at a byte offset. */
  async readEvents(offset = 0): Promise<JsonlChunk<AgentEvent>> {
    return readJsonl(eventsPath(this.root, this.sessionId), offset, parseEvent);
  }

  /** Incremental read of `inbox.jsonl` starting at a byte offset. */
  async readComments(offset = 0): Promise<JsonlChunk<Comment>> {
    return readJsonl(inboxPath(this.root, this.sessionId), offset, parseComment);
  }

  async listEvents(): Promise<AgentEvent[]> {
    return normalizeRecords((await this.readEvents(0)).records);
  }

  async listComments(): Promise<Comment[]> {
    return normalizeRecords((await this.readComments(0)).records);
  }

  async readMeta(): Promise<SessionMeta | null> {
    const raw = await readJsonFile(metaPath(this.root, this.sessionId));
    return raw === null ? null : parseMeta(raw);
  }

  /**
   * Read-modify-write of `meta.json` under a lock, since the agent (status changes)
   * and the extension (title edits) can both touch it.
   */
  async patchMeta(patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const file = metaPath(this.root, this.sessionId);
    return this.#withLock(file, async () => {
      const current = await this.readMeta();
      if (!current) throw new Error(`session ${this.sessionId} has no ${file}; call init() first`);

      const merged = parseMeta({ ...current, ...patch, updated_at: this.#clock.iso() });
      await writeJsonAtomic(file, merged);
      return merged;
    });
  }

  async readCursor(): Promise<Cursor> {
    const raw = await readJsonFile(cursorPath(this.root, this.sessionId));
    if (raw === null) return { inbox_seq: 0, updated_at: this.#clock.iso() };
    return parseCursor(raw);
  }

  /** Comments the agent has not been shown yet. Does not move the cursor. */
  async unreadComments(): Promise<Comment[]> {
    const cursor = await this.readCursor();
    const all = await this.listComments();
    return all.filter((comment) => comment.seq > cursor.inbox_seq);
  }

  /**
   * Record that comments up to `seq` reached the agent.
   *
   * Deliberately separate from reading: the cursor may only advance once delivery
   * actually happened, or feedback is lost without a trace (TESTS.md HOOK-06).
   */
  async commitCursor(seq: number, extra: Partial<Cursor> = {}): Promise<Cursor> {
    const file = cursorPath(this.root, this.sessionId);
    return this.#withLock(file, async () => {
      const current = await this.readCursor();
      const next = parseCursor({
        ...current,
        ...extra,
        inbox_seq: Math.max(current.inbox_seq, seq),
        updated_at: this.#clock.iso(),
      });
      await writeJsonAtomic(file, next);
      return next;
    });
  }

  /**
   * Store an artifact and return the reference to put in an event.
   *
   * Never overwrites: a colliding name gets a numeric suffix, because an artifact is
   * a record of what the agent produced at a point in time (TESTS.md MCP-07).
   */
  async writeArtifact(name: string, content: string | Uint8Array): Promise<WrittenArtifact> {
    const dir = artifactsDir(this.root, this.sessionId);
    assertArtifactName(name);

    return this.#withLock(dir, async () => {
      await ensureDir(dir);
      const taken = await listDir(dir);
      const finalName = uniqueArtifactName(taken, name);
      const absPath = resolveArtifactPath(this.root, this.sessionId, finalName);
      await writeFileAtomic(absPath, content);
      return { name: finalName, ref: artifactRef(finalName), absPath };
    });
  }

  async readArtifact(name: string): Promise<Buffer | null> {
    const absPath = resolveArtifactPath(this.root, this.sessionId, name);
    try {
      return await fs.readFile(absPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
      throw error;
    }
  }

  async listArtifacts(): Promise<string[]> {
    return (await listDir(artifactsDir(this.root, this.sessionId))).sort();
  }

  #withLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const options = this.#lockTimeoutMs === undefined ? {} : { timeoutMs: this.#lockTimeoutMs };
    return withFileLock(lockPathFor(target), fn, options);
  }
}

/**
 * Put records in a stable, chronological order and drop duplicate sequence numbers.
 *
 * A duplicate `seq` means two writers raced outside the lock; `ts` decides who came
 * first and the later copy is dropped (TESTS.md PROTO-12).
 */
export function normalizeRecords<T extends { seq: number; ts: string }>(records: readonly T[]): T[] {
  const sorted = [...records].sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
  const seen = new Set<number>();
  const result: T[] = [];
  for (const record of sorted) {
    if (seen.has(record.seq)) continue;
    seen.add(record.seq);
    result.push(record);
  }
  return result;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return [];
    throw error;
  }
}
