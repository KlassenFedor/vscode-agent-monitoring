import {
  listSessionIds,
  normalizeRecords,
  SessionStore,
  systemClock,
  type AgentEvent,
  type Clock,
  type Comment,
  type CommentKind,
  type SessionMeta,
  type SessionStatus,
} from '@agent-monitor/protocol';

import { archiveSession, deleteSession, unarchiveSession } from './manage.js';

export interface SessionView {
  id: string;
  meta: SessionMeta | null;
  events: AgentEvent[];
  comments: Comment[];
  /** How far the agent has read the inbox. */
  cursorSeq: number;
  /** Comments written but not yet delivered to the agent. */
  unread: Comment[];
  lastActivityAt: string | null;
  /** No activity for a while: the agent may be stuck, or gone. */
  stale: boolean;
  /** Set when the agent is blocked on a question and cannot proceed without an answer. */
  waitingQuestion: AgentEvent | null;
  status: SessionStatus;
  /** Filed away by the human: still on disk, out of the way in the list. */
  archived: boolean;
}

export interface WorkspaceSnapshot {
  root: string;
  sessions: SessionView[];
  unreadTotal: number;
  waitingCount: number;
}

export interface ModelOptions {
  clock?: Clock;
  staleAfterMs?: number;
}

interface SessionState {
  store: SessionStore;
  events: AgentEvent[];
  comments: Comment[];
  eventsOffset: number;
  commentsOffset: number;
}

const DEFAULT_STALE_AFTER_MS = 10 * 60_000;

/**
 * Everything the UI knows, held in one place.
 *
 * Reads are incremental: each refresh continues from the byte offset the previous one
 * stopped at, so a session with hundreds of events costs the same per refresh as a
 * fresh one (TESTS.md EXT-07). The views are rebuilt from accumulated state rather
 * than re-read, which is also what makes reopening a closed panel free of duplicates
 * (EXT-14).
 */
export class WorkspaceModel {
  readonly root: string;

  readonly #clock: Clock;
  readonly #staleAfterMs: number;
  readonly #sessions = new Map<string, SessionState>();

  #snapshot: WorkspaceSnapshot;

  constructor(root: string, options: ModelOptions = {}) {
    this.root = root;
    this.#clock = options.clock ?? systemClock;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#snapshot = { root, sessions: [], unreadTotal: 0, waitingCount: 0 };
  }

  /** Latest known state without touching the disk. */
  snapshot(): WorkspaceSnapshot {
    return this.#snapshot;
  }

  session(sessionId: string): SessionView | undefined {
    return this.#snapshot.sessions.find((session) => session.id === sessionId);
  }

  /** Re-read whatever changed and rebuild the snapshot. */
  async refresh(): Promise<WorkspaceSnapshot> {
    const ids = await listSessionIds(this.root);
    for (const id of ids) {
      if (!this.#sessions.has(id)) {
        this.#sessions.set(id, {
          store: SessionStore.open(this.root, id, { clock: this.#clock }),
          events: [],
          comments: [],
          eventsOffset: 0,
          commentsOffset: 0,
        });
      }
    }
    for (const id of [...this.#sessions.keys()]) {
      if (!ids.includes(id)) this.#sessions.delete(id);
    }

    const views: SessionView[] = [];
    for (const [id, state] of this.#sessions) {
      views.push(await this.#readSession(id, state));
    }

    views.sort(compareSessions);
    // Archived sessions are still listed, but they stop counting: the status bar and the
    // notifications exist to interrupt, and a session the human has put away is the one
    // statement that interrupting is unwanted.
    const active = views.filter((view) => !view.archived);
    this.#snapshot = {
      root: this.root,
      sessions: views,
      unreadTotal: active.reduce((total, view) => total + view.unread.length, 0),
      waitingCount: active.filter((view) => view.waitingQuestion !== null).length,
    };
    return this.#snapshot;
  }

  /** Write a comment the agent will pick up on its next report or tool call. */
  async postComment(
    sessionId: string,
    input: { text: string; kind?: CommentKind; replyTo?: number },
  ): Promise<Comment> {
    const state = this.#sessions.get(sessionId);
    if (!state) throw new Error(`unknown session: ${sessionId}`);

    return state.store.appendComment({
      kind: input.kind ?? 'steer',
      text: input.text,
      ...(input.replyTo === undefined ? {} : { reply_to: input.replyTo }),
      author: 'human',
    });
  }

  /**
   * Take a session out of the way, or put it back.
   *
   * The snapshot is rebuilt here rather than left to the next watcher tick: this is a
   * click, and a list that keeps showing the old state for a second reads as a click
   * that did not land.
   */
  async setArchived(sessionId: string, archived: boolean): Promise<WorkspaceSnapshot> {
    const options = { clock: this.#clock };
    if (archived) await archiveSession(this.root, sessionId, options);
    else await unarchiveSession(this.root, sessionId, options);
    return this.refresh();
  }

  /** Delete the session directory. Irreversible; the caller confirms. */
  async remove(sessionId: string): Promise<WorkspaceSnapshot> {
    await deleteSession(this.root, sessionId);
    // Drop the cached offsets too: a session id can come back — the agent that owned it
    // is still running — and reading a new file from an old offset loses its start.
    this.#sessions.delete(sessionId);
    return this.refresh();
  }

  async #readSession(id: string, state: SessionState): Promise<SessionView> {
    const events = await state.store.readEvents(state.eventsOffset);
    if (events.reset) state.events = [];
    state.events = normalizeRecords([...state.events, ...events.records]);
    state.eventsOffset = events.nextOffset;

    const comments = await state.store.readComments(state.commentsOffset);
    if (comments.reset) state.comments = [];
    state.comments = normalizeRecords([...state.comments, ...comments.records]);
    state.commentsOffset = comments.nextOffset;

    const meta = await state.store.readMeta().catch(() => null);
    const cursor = await state.store.readCursor().catch(() => null);
    const cursorSeq = cursor?.inbox_seq ?? 0;

    const lastActivityAt = latestTimestamp(state.events, state.comments, meta);
    const status = meta?.status ?? 'working';

    return {
      id,
      meta,
      events: state.events,
      comments: state.comments,
      cursorSeq,
      unread: state.comments.filter((comment) => comment.seq > cursorSeq),
      lastActivityAt,
      stale: this.#isStale(status, lastActivityAt),
      waitingQuestion: findWaitingQuestion(state.events, status),
      status,
      archived: typeof meta?.archived_at === 'string',
    };
  }

  #isStale(status: SessionStatus, lastActivityAt: string | null): boolean {
    if (status === 'done' || status === 'blocked') return false;
    if (!lastActivityAt) return false;
    return this.#clock.now() - Date.parse(lastActivityAt) > this.#staleAfterMs;
  }
}

/**
 * A question only counts as pending while the agent is actually blocked on it.
 * Once it has been answered the agent leaves `blocked`, so the badge clears itself
 * without the UI having to track answers.
 */
function findWaitingQuestion(events: readonly AgentEvent[], status: SessionStatus): AgentEvent | null {
  if (status !== 'blocked') return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'question' && event.needs_answer === true) return event;
  }
  return null;
}

function latestTimestamp(
  events: readonly AgentEvent[],
  comments: readonly Comment[],
  meta: SessionMeta | null,
): string | null {
  const candidates = [events.at(-1)?.ts, comments.at(-1)?.ts, meta?.updated_at].filter(
    (value): value is string => typeof value === 'string',
  );

  if (candidates.length === 0) return null;
  return candidates.reduce((latest, value) => (value > latest ? value : latest));
}

/** Sessions that need attention first, then the most recently active. */
function compareSessions(a: SessionView, b: SessionView): number {
  const rank = (view: SessionView): number => {
    // Tested before everything else, and ranked below it: an archived session waiting
    // on a question must not climb back to the top of the list it was taken out of.
    if (view.archived) return 5;
    if (view.waitingQuestion) return 0;
    if (view.unread.length > 0) return 1;
    if (view.status === 'done') return 4;
    if (view.stale) return 3;
    return 2;
  };

  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;

  const left = a.lastActivityAt ?? '';
  const right = b.lastActivityAt ?? '';
  return left === right ? a.id.localeCompare(b.id) : left < right ? 1 : -1;
}
