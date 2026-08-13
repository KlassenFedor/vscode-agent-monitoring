import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  artifactFileName,
  ProtocolError,
  SessionStore,
  SESSION_STATUSES,
  systemClock,
  type AgentEvent,
  type AgentKind,
  type Clock,
  paragraphs,
  renderComments,
  type Comment,
  type SessionStatus,
} from '@agent-monitor/protocol';

import {
  ArgumentError,
  asArgs,
  optionalInt,
  optionalString,
  optionalStringArray,
  requiredEnum,
  requiredString,
} from './args.js';

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface RuntimeOptions {
  root: string;
  sessionId: string;
  agent: AgentKind;
  /** Directory the agent is working in; recorded in the session metadata. */
  cwd?: string;
  clock?: Clock;
  /** Real-time source for throttling and deadlines, separate from the record clock. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Reports closer together than this are marked as throttled. */
  minReportIntervalMs?: number;
  askTimeoutMs?: number;
  askPollIntervalMs?: number;
  maxArtifactBytes?: number;
}

const DEFAULT_MIN_REPORT_INTERVAL_MS = 60_000;
const DEFAULT_ASK_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_ASK_POLL_MS = 250;
const DEFAULT_MAX_ARTIFACT_BYTES = 1_000_000;

const ARTIFACT_KINDS = ['markdown', 'diff', 'json', 'text', 'image', 'file'] as const;
type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * The behaviour behind the MCP tools, with no MCP plumbing in sight.
 *
 * Kept separate from the transport so the interesting cases — throttling, blocking
 * on a question, delivering comments — can be tested without a JSON-RPC round trip.
 */
export class MonitorRuntime {
  readonly store: SessionStore;
  readonly sessionId: string;
  readonly agent: AgentKind;
  readonly root: string;

  readonly #cwd: string;
  readonly #clock: Clock;
  readonly #nowMs: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #minReportIntervalMs: number;
  readonly #askTimeoutMs: number;
  readonly #askPollIntervalMs: number;
  readonly #maxArtifactBytes: number;

  #initialized = false;
  #lastReportAt: number | null = null;

  constructor(options: RuntimeOptions) {
    this.root = options.root;
    this.sessionId = options.sessionId;
    this.agent = options.agent;
    this.#cwd = options.cwd ?? options.root;
    this.#clock = options.clock ?? systemClock;
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#minReportIntervalMs = options.minReportIntervalMs ?? DEFAULT_MIN_REPORT_INTERVAL_MS;
    this.#askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.#askPollIntervalMs = options.askPollIntervalMs ?? DEFAULT_ASK_POLL_MS;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;

    this.store = SessionStore.open(options.root, options.sessionId, { clock: this.#clock });
  }

  /**
   * Publish a milestone and hand back whatever the human has said since last time.
   *
   * Returning the feedback here is the point of the whole design: the agent gets
   * corrections at the moment it is already reflecting on its progress, without
   * having to remember to ask (DESIGN.md §3).
   */
  async reportProgress(rawArgs: unknown): Promise<ToolResult> {
    return this.#guard(async () => {
      const args = asArgs(rawArgs);
      const title = requiredString(args, 'title', { maxLength: 500 });
      const phase = optionalString(args, 'phase', { maxLength: 200 });
      const summary = optionalString(args, 'summary', { maxLength: 3000 });
      const next = optionalString(args, 'next', { maxLength: 1000 });
      const artifacts = optionalStringArray(args, 'artifacts');

      await this.#ensureSession();

      const throttled = this.#isThrottled();
      const event = await this.store.appendEvent({
        type: 'progress',
        title,
        ...(phase === undefined ? {} : { phase }),
        ...(summary === undefined ? {} : { summary }),
        ...(next === undefined ? {} : { next }),
        ...(artifacts === undefined ? {} : { artifacts }),
        ...(throttled ? { throttled: true } : {}),
      });
      this.#lastReportAt = this.#nowMs();

      return {
        text: paragraphs(
          `Published as report #${event.seq}.`,
          throttled ? this.#throttleHint() : '',
          await this.#deliverFeedback(),
        ),
      };
    });
  }

  /**
   * Store a file next to the session and announce it.
   *
   * Artifacts are what make a report reviewable — a diff, a plan, a table — and they
   * are stored rather than inlined so a large one cannot blow up the event line.
   */
  async publishArtifact(rawArgs: unknown): Promise<ToolResult> {
    return this.#guard(async () => {
      const args = asArgs(rawArgs);
      const name = requiredString(args, 'name', { maxLength: 100 });
      const title = optionalString(args, 'title', { maxLength: 500 });
      const summary = optionalString(args, 'summary', { maxLength: 3000 });
      const kind = (optionalString(args, 'kind') ?? 'file') as ArtifactKind;
      if (!ARTIFACT_KINDS.includes(kind)) {
        throw new ArgumentError(`kind must be one of: ${ARTIFACT_KINDS.join(', ')}`);
      }

      const inlineContent = optionalString(args, 'content', { maxLength: this.#maxArtifactBytes });
      const sourcePath = optionalString(args, 'path', { maxLength: 4096 });
      if ((inlineContent === undefined) === (sourcePath === undefined)) {
        throw new ArgumentError('pass exactly one of content or path');
      }

      const content = inlineContent ?? (await this.#readWorkspaceFile(sourcePath as string));

      await this.#ensureSession();
      const ordinal = (await this.store.listArtifacts()).length + 1;
      const written = await this.store.writeArtifact(artifactFileName(ordinal, name), content);

      const event = await this.store.appendEvent({
        type: 'artifact',
        title: title ?? name,
        artifacts: [written.ref],
        kind,
        ...(summary === undefined ? {} : { summary }),
      });

      return {
        text: paragraphs(
          `Published ${written.ref} as report #${event.seq}. The human can open it from the session panel.`,
          await this.#deliverFeedback(),
        ),
      };
    });
  }

  /** Explicit poll for feedback, for agents without a hook channel. */
  async checkFeedback(rawArgs: unknown): Promise<ToolResult> {
    return this.#guard(async () => {
      const args = asArgs(rawArgs);
      const since = optionalInt(args, 'since', { min: 0 });

      await this.#ensureSession();
      const delivered = await this.#deliverFeedback({ ...(since === undefined ? {} : { since }) });

      return { text: delivered === '' ? 'No new comments from the human.' : delivered };
    });
  }

  /**
   * Ask the human something and wait for the answer.
   *
   * The only blocking tool. It exists so that a real fork in the road is decided by
   * the person rather than guessed at, and it gives up after a timeout so a human who
   * has walked away cannot strand the session forever (TESTS.md MCP-10).
   */
  async askUser(rawArgs: unknown): Promise<ToolResult> {
    return this.#guard(async () => {
      const args = asArgs(rawArgs);
      const question = requiredString(args, 'question', { maxLength: 1000 });
      const options = optionalStringArray(args, 'options', { maxItems: 10 });
      const timeoutMs = optionalInt(args, 'timeout_ms', { min: 1000, max: 60 * 60_000 }) ?? this.#askTimeoutMs;

      await this.#ensureSession();
      const event = await this.store.appendEvent({
        type: 'question',
        title: question,
        needs_answer: true,
        ...(options === undefined ? {} : { options }),
      });
      await this.store.patchMeta({ status: 'blocked' });

      const deadline = this.#nowMs() + timeoutMs;
      for (;;) {
        const pending = await this.store.unreadComments();
        const index = pending.findIndex((comment) => comment.kind === 'answer' || comment.kind === 'stop');

        if (index >= 0) {
          const upToAnswer = pending.slice(0, index + 1);
          const resolution = upToAnswer[index] as Comment;
          await this.#commit(upToAnswer);
          await this.store.patchMeta({ status: resolution.kind === 'stop' ? 'blocked' : 'working' });

          return {
            text: paragraphs(
              resolution.kind === 'stop'
                ? 'The human asked you to stop and wait rather than answering.'
                : `Answer to question #${event.seq}:`,
              renderComments(upToAnswer),
            ),
          };
        }

        if (this.#nowMs() >= deadline) {
          await this.store.patchMeta({ status: 'working' });
          return {
            text: paragraphs(
              `No answer within ${Math.round(timeoutMs / 1000)}s.`,
              'Decide yourself, and state the assumption you made in your next report so the human can correct it.',
              await this.#deliverFeedback(),
            ),
          };
        }

        await this.#sleep(this.#askPollIntervalMs);
      }
    });
  }

  /** Move the session between working / blocked / waiting_review / done. */
  async setStatus(rawArgs: unknown): Promise<ToolResult> {
    return this.#guard(async () => {
      const args = asArgs(rawArgs);
      const status = requiredEnum<SessionStatus>(args, 'status', SESSION_STATUSES);
      const title = optionalString(args, 'title', { maxLength: 500 });

      await this.#ensureSession();
      await this.store.patchMeta({
        status,
        ...(title === undefined ? {} : { title }),
        ...(status === 'done' ? { ended_at: this.#clock.iso() } : {}),
      });
      const event = await this.store.appendEvent({
        type: 'status',
        title: title ?? `status: ${status}`,
        status,
      });

      return {
        text: paragraphs(`Session marked ${status} (report #${event.seq}).`, await this.#deliverFeedback()),
      };
    });
  }

  async #ensureSession(): Promise<void> {
    if (this.#initialized) return;
    await this.store.init({ agent: this.agent, cwd: this.#cwd });
    this.#initialized = true;
  }

  /**
   * Collect unread comments, mark them delivered, and render them.
   *
   * The cursor moves here and only here, right after the text has been built, so a
   * comment is never marked delivered without being in the reply (TESTS.md HOOK-06).
   */
  async #deliverFeedback(options: { since?: number } = {}): Promise<string> {
    const unread = await this.store.unreadComments();
    const since = options.since;
    const selected = since === undefined ? unread : unread.filter((comment) => comment.seq > since);
    if (selected.length === 0) return '';

    const rendered = renderComments(selected);
    await this.#commit(selected);
    return rendered;
  }

  async #commit(comments: readonly Comment[]): Promise<void> {
    const highest = comments.reduce((max, comment) => Math.max(max, comment.seq), 0);
    if (highest > 0) await this.store.commitCursor(highest);
  }

  #isThrottled(): boolean {
    if (this.#lastReportAt === null) return false;
    return this.#nowMs() - this.#lastReportAt < this.#minReportIntervalMs;
  }

  #throttleHint(): string {
    const seconds = Math.round(this.#minReportIntervalMs / 1000);
    return `Note: the previous report was less than ${seconds}s ago, so this one is marked as throttled in the timeline. Report on milestones (a module finished, a plan ready, tests green), not on every file.`;
  }

  /** Read a file the agent already wrote, refusing anything outside the workspace. */
  async #readWorkspaceFile(sourcePath: string): Promise<string> {
    const resolved = path.resolve(this.root, sourcePath);
    const prefix = path.resolve(this.root) + path.sep;
    if (!resolved.startsWith(prefix)) {
      throw new ArgumentError('path must point inside the workspace');
    }

    const stats = await fs.stat(resolved).catch(() => null);
    if (!stats?.isFile()) throw new ArgumentError(`no such file: ${sourcePath}`);
    if (stats.size > this.#maxArtifactBytes) {
      throw new ArgumentError(`file is ${stats.size} bytes, limit is ${this.#maxArtifactBytes}`);
    }
    return fs.readFile(resolved, 'utf8');
  }

  /**
   * Turn any failure into a tool result the agent can read.
   *
   * A monitoring tool must never be the reason an agent stops working: the agent is
   * told what went wrong and carries on with its actual task (TESTS.md MCP-13).
   */
  async #guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await fn();
    } catch (error) {
      return { text: describeFailure(error), isError: true };
    }
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof ArgumentError) {
    return `Bad arguments: ${error.message}`;
  }
  if (error instanceof ProtocolError) {
    return `Agent Monitor could not write to the session (${error.code}): ${error.message}. Continue with your task; progress reporting is unavailable.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Agent Monitor failed: ${message}. Continue with your task; progress reporting is unavailable.`;
}

export type { AgentEvent };
